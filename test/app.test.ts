import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { app } from "../src/app";
import { createDeletionJob, runQueuedJobs, scheduleGcJob } from "../src/jobs/jobs";
import { claimObjectWrite, releaseObjectWrite } from "../src/storage/r2";
import { createPresignedPut } from "../src/storage/presign";
import { cleanupUploadSessions } from "../src/storage/uploads";
import type { Bindings } from "../src/env";
import { homePage } from "../src/ui/home";

const testEnv = {
  ...env,
  READ_TOKEN: "read-secret",
  WRITE_TOKEN: "write-secret",
  ADMIN_TOKEN: "admin-secret",
  NIX_PUBLIC_SIGN_KEY: "",
  R2_ACCOUNT_ID: "00000000000000000000000000000000",
  R2_BUCKET_NAME: "nix-cache-test",
  R2_S3_ACCESS_KEY_ID: "test-access-key",
  R2_S3_SECRET_ACCESS_KEY: "test-secret-key",
} as Bindings;

beforeAll(async () => {
  const schema = `
    DROP TABLE IF EXISTS artifact_version_members;
    DROP TABLE IF EXISTS artifact_versions;
    DROP TABLE IF EXISTS artifact_packages;
    DROP TABLE IF EXISTS artifact_set_members;
    DROP TABLE IF EXISTS artifact_sets;
    DROP TABLE IF EXISTS narinfo_refs;
    DROP TABLE IF EXISTS objects;
    DROP TABLE IF EXISTS gc_policies;
    DROP TABLE IF EXISTS settings;
    DROP TABLE IF EXISTS jobs;
    DROP TABLE IF EXISTS gc_policy_matches;
    DROP TABLE IF EXISTS gc_policy_capacity_matches;
    DROP TABLE IF EXISTS gc_scan_versions;
    DROP TABLE IF EXISTS delete_job_nars;
    DROP TABLE IF EXISTS delete_job_narinfos;
    DROP TABLE IF EXISTS write_claims;
    DROP TABLE IF EXISTS audit_log;
    DROP TABLE IF EXISTS upload_sessions;
    CREATE TABLE artifact_packages (package_name TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE objects (r2_key TEXT PRIMARY KEY, kind TEXT NOT NULL, etag TEXT NOT NULL, sha256 TEXT, size INTEGER NOT NULL, uploaded_at TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'ready');
    CREATE TABLE narinfo_refs (narinfo_key TEXT PRIMARY KEY, nar_key TEXT NOT NULL, store_path TEXT, created_at TEXT NOT NULL);
    CREATE TABLE artifact_versions (version_id TEXT PRIMARY KEY, package_name TEXT NOT NULL, version_name TEXT NOT NULL, tags_json TEXT NOT NULL DEFAULT '{}', retention_days INTEGER, pinned INTEGER NOT NULL DEFAULT 0, registered_at TEXT NOT NULL, updated_at TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'active', UNIQUE(package_name, version_name));
    CREATE TABLE artifact_version_members (version_id TEXT NOT NULL, narinfo_key TEXT NOT NULL, PRIMARY KEY(version_id, narinfo_key));
    CREATE TABLE gc_policies (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, conditions_json TEXT NOT NULL DEFAULT '[]', group_by_json TEXT NOT NULL DEFAULT '[]', last_n INTEGER, duration_days INTEGER, capacity_versions INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE jobs (id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL, target_version_id TEXT, cursor INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, payload_json TEXT NOT NULL DEFAULT '{}', last_error TEXT, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE write_claims (r2_key TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at TEXT NOT NULL);
    CREATE INDEX idx_write_claims_expires_at ON write_claims(expires_at);
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, actor TEXT NOT NULL, target TEXT, details_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
    CREATE TABLE upload_sessions (id TEXT PRIMARY KEY, r2_key TEXT NOT NULL, staging_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, expected_size INTEGER NOT NULL, expected_sha256 TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'issued', object_etag TEXT, error_code TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, completed_at TEXT, updated_at TEXT NOT NULL);
    CREATE INDEX idx_upload_sessions_expiry ON upload_sessions(status, expires_at);
    CREATE INDEX idx_upload_sessions_key ON upload_sessions(r2_key, status, created_at DESC);
    CREATE UNIQUE INDEX idx_upload_sessions_active_key ON upload_sessions(r2_key) WHERE status = 'issued';
    CREATE TABLE gc_scan_versions (job_id TEXT NOT NULL, version_id TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(job_id, version_id));
    CREATE TABLE gc_policy_matches (job_id TEXT NOT NULL, version_id TEXT NOT NULL, policy_id INTEGER NOT NULL, group_key TEXT NOT NULL, registered_at TEXT NOT NULL, keep_count INTEGER NOT NULL, PRIMARY KEY(job_id, version_id, policy_id));
    CREATE TABLE gc_policy_capacity_matches (job_id TEXT NOT NULL, version_id TEXT NOT NULL, policy_id INTEGER NOT NULL, group_key TEXT NOT NULL, registered_at TEXT NOT NULL, capacity_versions INTEGER NOT NULL, PRIMARY KEY(job_id, version_id, policy_id));
    CREATE TABLE delete_job_nars (job_id TEXT NOT NULL, nar_key TEXT NOT NULL, PRIMARY KEY(job_id, nar_key));
    CREATE TABLE delete_job_narinfos (job_id TEXT NOT NULL, narinfo_key TEXT NOT NULL, PRIMARY KEY(job_id, narinfo_key));
    CREATE UNIQUE INDEX idx_jobs_active_delete_target ON jobs(target_version_id) WHERE type = 'delete_version' AND target_version_id IS NOT NULL AND status IN ('queued', 'running', 'failed');
  `;
  for (const statement of schema.split(";")) {
    if (statement.trim()) await testEnv.DB.exec(statement);
  }
  await testEnv.DB.prepare(
    "INSERT INTO gc_policies (name, conditions_json, group_by_json, last_n, duration_days, capacity_versions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind("default-package-tags", "[]", '["pkg_name","pkg_tags"]', 3, null, null, "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z").run();
});

async function request(path: string, init: RequestInit = {}, inferContentLength = true): Promise<{ response: Response; waitUntil: Promise<unknown>[] }> {
  const waiters: Promise<unknown>[] = [];
  const ctx = { waitUntil(promise: Promise<unknown>) { waiters.push(promise); } } as ExecutionContext;
  const headers = new Headers(init.headers);
  if (inferContentLength && init.method === "PUT" && typeof init.body === "string" && !headers.has("Content-Length")) {
    headers.set("Content-Length", String(new TextEncoder().encode(init.body).byteLength));
  }
  const response = await app.fetch(new Request(`https://cache.test${path}`, { ...init, headers }), testEnv, ctx);
  return { response, waitUntil: waiters };
}

function bearer(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

function netrcBasic(token: string): HeadersInit {
  return { Authorization: `Basic ${btoa(`nix:${token}`)}` };
}

function narInfoBody(narKey: string, storePath: string): string {
  return `StorePath: ${storePath}\nURL: /${narKey}\nCompression: none\nFileHash: sha256:0000000000000000000000000000000000000000000000000000\nFileSize: 1\nNarHash: sha256:1111111111111111111111111111111111111111111111111111\nNarSize: 1\nReferences: \n`;
}

async function uploadPair(prefix: string, narBody = prefix): Promise<{ narKey: string; narinfoKey: string }> {
  const narKey = `nar/${prefix}.nar`;
  const narinfoKey = `${prefix}.narinfo`;
  const nar = await request(`/${narKey}`, { method: "PUT", headers: { ...bearer("write-secret"), "Content-Length": String(narBody.length) }, body: narBody });
  expect([201, 204]).toContain(nar.response.status);
  const narinfo = await request(`/${narinfoKey}`, {
    method: "PUT",
    headers: bearer("write-secret"),
    body: narInfoBody(narKey, `/nix/store/${prefix}`),
  });
  expect([201, 204]).toContain(narinfo.response.status);
  return { narKey, narinfoKey };
}

async function register(packageName: string, versionName: string, narinfoKeys: string[], extra: Record<string, unknown> = {}) {
  return request(`/api/packages/${packageName}/versions/${versionName}`, {
    method: "PUT",
    headers: { ...bearer("write-secret"), "Content-Type": "application/json" },
    body: JSON.stringify({ narinfoKeys, ...extra }),
  });
}

async function sha256Bytes(value: Uint8Array): Promise<string> {
  const bytes = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function chunkedBody(value: Uint8Array, chunkSize: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= value.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, value.byteLength);
      controller.enqueue(value.subarray(offset, end));
      offset = end;
    },
  });
}

function awsEncodeForTest(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function hexBytes(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmacBytes(key: Uint8Array, value: string): Promise<Uint8Array> {
  const keyBuffer = key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) as ArrayBuffer;
  const cryptoKey = await crypto.subtle.importKey("raw", keyBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(value));
  return new Uint8Array(signature);
}

async function referencePresignedSignature(url: string, headers: Record<string, string>, secret: string, method = "PUT"): Promise<string> {
  const parsed = new URL(url);
  const query = Array.from(parsed.searchParams.entries())
    .filter(([name]) => name !== "X-Amz-Signature")
    .map(([name, value]) => [awsEncodeForTest(name), awsEncodeForTest(value)] as const)
    .sort(([leftName, leftValue], [rightName, rightValue]) => leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  const signedHeaders = parsed.searchParams.get("X-Amz-SignedHeaders") ?? "";
  const requestHeaders = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  requestHeaders.set("host", parsed.host);
  const canonicalHeaders = signedHeaders.split(";").map((name) => `${name}:${(requestHeaders.get(name) ?? "").trim().replace(/[\t ]+/g, " ")}`).join("\n");
  const canonicalRequest = [method, parsed.pathname, query, `${canonicalHeaders}\n`, signedHeaders, "UNSIGNED-PAYLOAD"].join("\n");
  const requestDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalRequest));
  const date = parsed.searchParams.get("X-Amz-Date") ?? "";
  const scope = parsed.searchParams.get("X-Amz-Credential")?.split("/").slice(1).join("/") ?? "";
  const stringToSign = ["AWS4-HMAC-SHA256", date, scope, hexBytes(new Uint8Array(requestDigest))].join("\n");
  const dateKey = await hmacBytes(new TextEncoder().encode(`AWS4${secret}`), date.slice(0, 8));
  const regionKey = await hmacBytes(dateKey, "auto");
  const serviceKey = await hmacBytes(regionKey, "s3");
  const signingKey = await hmacBytes(serviceKey, "aws4_request");
  return hexBytes(await hmacBytes(signingKey, stringToSign));
}

function stagingKeyFromPresignedUrl(url: string): string {
  const pathname = decodeURIComponent(new URL(url).pathname);
  const prefix = `/${testEnv.R2_BUCKET_NAME}/`;
  expect(pathname.startsWith(prefix)).toBe(true);
  return pathname.slice(prefix.length);
}

describe("Admin console page", () => {
  it("uses a flat layout and restores the token within the browser tab session", async () => {
    const { response } = await request("/admin");
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).not.toContain("<aside>");
    expect(html).not.toContain("grid-template-columns: 230px 1fr");
    expect(html).toContain("window.sessionStorage");
    expect(html).toContain("openConsole(storedToken)");
    expect(html).not.toContain("localStorage");
    expect(html).toContain('id="groupTags"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("let groupByTags = true");
    expect(html).toContain("function tagGroupLabel(tags)");
    expect(html).toContain('id="enableCapacity"');
    expect(html).toContain("capacityVersions");
    expect(html).toContain("Over-capacity versions may be removed before the duration expires.");
    expect(html).toContain("Priority is left to right: earlier actions take precedence over later ones.");
    expect(html.indexOf('id="lastNCard"')).toBeLessThan(html.indexOf('id="capacityCard"'));
    expect(html.indexOf('id="capacityCard"')).toBeLessThan(html.indexOf('id="durationCard"'));
    expect(html).toContain("grid-template-columns: repeat(3, minmax(0, 1fr))");
    expect(html).toContain('id="policy_duration" type="number" min="0" placeholder=""');
    expect(html).toContain("function setDurationDefault(value)");
    expect(html).toContain("setDurationDefault(settings.default_retention_days)");
    expect(html).not.toContain('id="policy_duration" type="number" min="0" placeholder="30"');
    expect(html).toContain('hourCycle: "h23"');
    expect(html).toContain("const formatRetentionRemaining = (value)");
    expect(html).toContain('return "Expired"');
    expect(html).toContain('className = remainingSeconds < 0 ? "expired" : ""');
    expect(html).toContain("capacityExceeded");
    expect(html).toContain("GC eligible · capacity exceeded");
    expect(html).toContain(".gc-eligible { color: var(--red)");
    expect(html).toContain("group-toggle");
    expect(html).toContain("version-toggle");
    expect(html).toContain("toggleFiles(detailRow");
    expect(html).not.toContain("Click Files to inspect this version's cache files.");
    expect(html).toContain("Extend");
    expect(html).toContain("retention-editor");
    expect(html).toContain("tbody tr { border-bottom: 1px solid #28302e; }");
    expect(html).toContain("td { padding: 12px 10px; border-bottom: 0;");
    expect(html).toContain("waitForJob(jobId)");
    expect(html).toContain('result.reused ? "GC already scheduled · " : "GC started · "');
    expect(html).toContain('setMessage("GC scan completed · queued deletions may continue", "success")');
    expect(html).toContain("No tags");
    expect(html).not.toContain('id="guide"');
    expect(html).toContain('id="publishing"');
    expect(html).toContain("CI publishing");
    expect(html).toContain('"narinfoKeys": ["abc123.narinfo"]');
    expect(html).toContain('"retentionDays": 30');
    expect(html.match(/Powered by/g)?.length).toBe(2);
    expect(html).toContain('href="https://github.com/ihciah/nix-cache-worker"');
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Function(script ?? "")).not.toThrow();
  });
});

describe("Public home page", () => {
  it("explains how to add the cache without replacing the official cache", async () => {
    const response = homePage("", "https://cache.test");
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("Stop building in production.");
    expect(html).toContain("Build your Nix artifacts in CI, push them to your private cache, and deploy instantly.");
    expect(html).toContain("Getting started");
    expect(html).toContain("substituters = lib.mkForce [");
    expect(html).toContain("&quot;https://cache.nixos.org&quot;");
    expect(html).toContain("&quot;https://cache.test&quot;");
    expect(html).toContain("trusted-public-keys = lib.mkForce [");
    expect(html).toContain("&quot;cache.nixos.org-1:&lt;existing-cache-key&gt;&quot;");
    expect(html).toContain("cache.test:&lt;public-signing-key&gt;");
    expect(html).toContain('href="https://github.com/ihciah/nix-cache-worker"');
    expect(html.match(/Powered by/g)?.length).toBe(1);
  });
});

describe("Structured retention rule API", () => {
  it("creates, validates, and round-trips visual rule fields", async () => {
    const payload = {
      name: "api-stable-rule",
      conditions: [
        { field: "pkg_name", operator: "starts_with", value: "api-", negate: false },
        { field: "pkg_tag:channel", operator: "equals", value: "stable", negate: false },
      ],
      groupBy: ["pkg_name", "pkg_tag:system"],
      lastN: 2,
      durationDays: 30,
      capacityVersions: 20,
    };
    const created = await request("/api/admin/policies", { method: "POST", headers: { ...bearer("admin-secret"), "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    expect(created.response.status).toBe(201);
    const createdBody = await created.response.json<typeof payload & { id: number }>();
    expect(createdBody.conditions).toEqual(payload.conditions);
    expect(createdBody.groupBy).toEqual(payload.groupBy);
    expect(createdBody.lastN).toBe(2);
    expect(createdBody.durationDays).toBe(30);
    expect(createdBody.capacityVersions).toBe(20);

    const updated = await request(`/api/admin/policies/${createdBody.id}`, {
      method: "PUT",
      headers: { ...bearer("admin-secret"), "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, capacityVersions: 21 }),
    });
    expect(updated.response.status).toBe(200);
    expect((await updated.response.json<{ capacityVersions: number }>()).capacityVersions).toBe(21);

    const highCount = await request("/api/admin/policies", {
      method: "POST",
      headers: { ...bearer("admin-secret"), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "api-high-count-rule", conditions: [{ field: "pkg_name", operator: "equals", value: "never-match", negate: false }], groupBy: [], lastN: 36_501, durationDays: null }),
    });
    expect(highCount.response.status).toBe(201);
    const tooMany = await request("/api/admin/policies", {
      method: "POST",
      headers: { ...bearer("admin-secret"), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "api-too-many-rule", conditions: [], groupBy: [], lastN: null, durationDays: null, capacityVersions: 100_001 }),
    });
    expect(tooMany.response.status).toBe(422);

    const capacityOnly = await request("/api/admin/policies", {
      method: "POST",
      headers: { ...bearer("admin-secret"), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "api-capacity-only-rule", conditions: [{ field: "pkg_name", operator: "equals", value: "capacity-only-package", negate: false }], groupBy: ["pkg_name"], lastN: null, durationDays: null, capacityVersions: 4 }),
    });
    expect(capacityOnly.response.status).toBe(201);
    expect((await capacityOnly.response.json<{ capacityVersions: number }>()).capacityVersions).toBe(4);

    const zeroCapacity = await request("/api/admin/policies", {
      method: "POST",
      headers: { ...bearer("admin-secret"), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "api-zero-capacity-rule", conditions: [{ field: "pkg_name", operator: "equals", value: "zero-capacity-package", negate: false }], groupBy: [], lastN: null, durationDays: null, capacityVersions: 0 }),
    });
    expect(zeroCapacity.response.status).toBe(201);

    const listed = await request("/api/admin/policies", { headers: bearer("admin-secret") });
    expect(listed.response.status).toBe(200);
    expect((await listed.response.json<{ items: Array<{ name: string }> }>()).items.some((item) => item.name === payload.name)).toBe(true);

    const invalid = await request("/api/admin/policies", { method: "POST", headers: { ...bearer("admin-secret"), "Content-Type": "application/json" }, body: JSON.stringify({ name: "missing-action", conditions: [], groupBy: [] }) });
    expect(invalid.response.status).toBe(422);
  });
});

describe("Nix cache HTTP API", () => {
  it("serves nix-cache-info publicly", async () => {
    const { response } = await request("/nix-cache-info");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("StoreDir: /nix/store");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
  });

  it("supports immutable NAR upload, HEAD, range, and ETag", async () => {
    const body = "0123456789";
    const upload = await request("/nar/http-semantics.nar", { method: "PUT", headers: { ...bearer("write-secret"), "Content-Length": String(body.length) }, body });
    expect(upload.response.status).toBe(201);
    const etag = upload.response.headers.get("ETag");
    expect(etag).toBeTruthy();
    const head = await request("/nar/http-semantics.nar", { method: "HEAD" });
    expect(head.response.status).toBe(200);
    expect(head.response.headers.get("Content-Length")).toBe(String(body.length));
    const range = await request("/nar/http-semantics.nar", { headers: { Range: "bytes=2-5" } });
    expect(range.response.status).toBe(206);
    expect(new TextDecoder().decode(await range.response.arrayBuffer())).toBe("2345");
    expect(range.response.headers.get("Content-Length")).toBe("4");
    const notModified = await request("/nar/http-semantics.nar", { headers: { "If-None-Match": etag ?? "" } });
    expect(notModified.response.status).toBe(304);
  });

  it("rejects different immutable content and accepts identical retries", async () => {
    const first = await request("/nar/immutable-version.nar", { method: "PUT", headers: bearer("write-secret"), body: "first" });
    expect(first.response.status).toBe(201);
    const owner = await claimObjectWrite(testEnv, "nar/immutable-version.nar");
    expect(owner).toBeTruthy();
    const blockedDuplicate = await request("/nar/immutable-version.nar", { method: "PUT", headers: bearer("write-secret"), body: "first" });
    expect(blockedDuplicate.response.status).toBe(409);
    await releaseObjectWrite(testEnv, "nar/immutable-version.nar", owner as string);
    const duplicate = await request("/nar/immutable-version.nar", { method: "PUT", headers: bearer("write-secret"), body: "first" });
    expect(duplicate.response.status).toBe(204);
    const empty = await request("/nar/immutable-version.nar", { method: "PUT", headers: bearer("write-secret") });
    expect(empty.response.status).toBe(400);
    const conflict = await request("/nar/immutable-version.nar", { method: "PUT", headers: bearer("write-secret"), body: "second" });
    expect(conflict.response.status).toBe(409);
  });

  it("accepts an identical narinfo retry", async () => {
    const pair = await uploadPair("idempotent-narinfo");
    const replay = await request(`/${pair.narinfoKey}`, {
      method: "PUT",
      headers: bearer("write-secret"),
      body: narInfoBody(pair.narKey, "/nix/store/idempotent-narinfo"),
    });
    expect(replay.response.status).toBe(204);
  });

  it("reclaims an expired write claim for the requested key", async () => {
    const seedOwner = await claimObjectWrite(testEnv, "claim-cleanup-seed");
    expect(seedOwner).toBeTruthy();
    await releaseObjectWrite(testEnv, "claim-cleanup-seed", seedOwner as string);
    await testEnv.DB.prepare("INSERT OR REPLACE INTO write_claims (r2_key, owner, expires_at) VALUES (?, ?, ?)")
      .bind("expired-claim", "stale-owner", "2000-01-01T00:00:00.000Z").run();
    const owner = await claimObjectWrite(testEnv, "expired-claim");
    expect(owner).toBeTruthy();
    await releaseObjectWrite(testEnv, "expired-claim", owner as string);
  });

  it("keeps SQL tag formatting matches visible in package search", async () => {
    const timestamp = new Date().toISOString();
    await testEnv.DB.prepare(
      "INSERT INTO artifact_versions (version_id, package_name, version_name, tags_json, registered_at, updated_at, state) VALUES (?, ?, ?, ?, ?, ?, 'active')",
    ).bind(crypto.randomUUID(), "formatted-search-package", "v1", '{"channel": "stable"}', timestamp, timestamp).run();
    const result = await request("/api/admin/packages?q=%22channel%22%3A%20%22stable%22", { headers: bearer("admin-secret") });
    expect(result.response.status).toBe(200);
    const body = await result.response.json<{ items: Array<{ packageName: string; versionCount: number }> }>();
    expect(body.items.find((item) => item.packageName === "formatted-search-package")?.versionCount).toBe(1);
    await testEnv.DB.prepare(
      "INSERT INTO artifact_versions (version_id, package_name, version_name, tags_json, registered_at, updated_at, state) VALUES (?, ?, ?, ?, ?, ?, 'active')",
    ).bind(crypto.randomUUID(), "literal-wildcard-package", "v1", "{}", timestamp, timestamp).run();
    const wildcard = await request("/api/admin/packages?q=_", { headers: bearer("admin-secret") });
    expect((await wildcard.response.json<{ items: Array<{ packageName: string }> }>()).items.some((item) => item.packageName === "literal-wildcard-package")).toBe(false);
  });

  it("repairs a missing D1 object index on an idempotent retry", async () => {
    const key = "nar/retry-index-repair.nar";
    const first = await request(`/${key}`, { method: "PUT", headers: bearer("write-secret"), body: "repair-me" });
    expect(first.response.status).toBe(201);
    await testEnv.DB.prepare("DELETE FROM objects WHERE r2_key = ?").bind(key).run();
    const retry = await request(`/${key}`, { method: "PUT", headers: bearer("write-secret"), body: "repair-me" });
    expect(retry.response.status).toBe(204);
    expect((await testEnv.DB.prepare("SELECT sha256 FROM objects WHERE r2_key = ?").bind(key).first<{ sha256: string }>())?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("completes and replays a streamed standard upload above the old multipart threshold", async () => {
    const body = new Uint8Array(8 * 1024 * 1024 + 1);
    body.fill(7);
    const headers = { ...bearer("write-secret"), "Content-Length": String(body.byteLength) };
    const first = await request("/nar/standard-stream-retry.nar", { method: "PUT", headers, body: chunkedBody(body, 16 * 1024) });
    expect(first.response.status).toBe(201);
    const replay = await request("/nar/standard-stream-retry.nar", { method: "PUT", headers, body });
    expect(replay.response.status).toBe(204);
    expect(replay.response.headers.get("ETag")).toBe(first.response.headers.get("ETag"));
  });

  it("requires Content-Length for a streamed standard upload", async () => {
    const response = await request("/nar/missing-content-length.nar", {
      method: "PUT",
      headers: bearer("write-secret"),
      body: "streaming-without-length",
    }, false);
    expect(response.response.status).toBe(411);
  });

  it("requires write access for direct upload sessions", async () => {
    const body = { key: "nar/direct-auth.nar", size: 1, sha256: "0".repeat(64) };
    expect((await request("/api/uploads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).response.status).toBe(403);
    expect((await request("/api/uploads", { method: "POST", headers: { ...bearer("read-secret"), "Content-Type": "application/json" }, body: JSON.stringify(body) })).response.status).toBe(403);
    expect((await request("/api/uploads", { method: "POST", headers: { ...bearer("write-secret"), "Content-Type": "application/json" }, body: JSON.stringify({ ...body, key: "not-a-narinfo.narinfo" }) })).response.status).toBe(422);
    const created = await request("/api/uploads", { method: "POST", headers: { ...bearer("write-secret"), "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect(created.response.status).toBe(201);
    const upload = await created.response.json<{ uploadId: string }>();
    expect((await request(`/api/uploads/${upload.uploadId}/complete`, { method: "POST" })).response.status).toBe(403);
    expect((await request(`/api/uploads/${upload.uploadId}/complete`, { method: "POST", headers: bearer("read-secret") })).response.status).toBe(403);
  });

  it("produces a verifiable SigV4 presigned PUT signature", async () => {
    const presigned = await createPresignedPut(testEnv, "_nix_uploads/reference-vector", 3600, new Date("2026-01-02T03:04:05.000Z"));
    const signature = new URL(presigned.url).searchParams.get("X-Amz-Signature");
    expect(signature).toBe(await referencePresignedSignature(presigned.url, presigned.headers, testEnv.R2_S3_SECRET_ACCESS_KEY as string));
  });

  it("redirects supported cache paths to short-lived R2 URLs when direct reads are enabled", async () => {
    const key = "nar/direct-read.nar";
    const body = "direct-read";
    expect((await request(`/${key}`, { method: "PUT", headers: bearer("write-secret"), body })).response.status).toBe(201);
    expect((await testEnv.CACHE_BUCKET.head(key))?.httpMetadata?.cacheControl).toBe("no-store");
    testEnv.DIRECT_DOWNLOAD_URL_TTL_SECONDS = "300";
    try {
      const get = await request(`/${key}`);
      expect(get.response.status).toBe(307);
      expect(get.response.headers.get("Cache-Control")).toBe("no-store");
      const getLocation = new URL(get.response.headers.get("Location") ?? "");
      expect(getLocation.origin).toBe("https://00000000000000000000000000000000.r2.cloudflarestorage.com");
      expect(getLocation.pathname).toBe(`/nix-cache-test/${key}`);
      expect(getLocation.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
      expect(getLocation.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
      expect(getLocation.toString()).not.toContain("test-secret-key");
      expect(getLocation.searchParams.get("X-Amz-Signature")).toBe(
        await referencePresignedSignature(getLocation.toString(), {}, testEnv.R2_S3_SECRET_ACCESS_KEY as string, "GET"),
      );

      const head = await request(`/${key}`, { method: "HEAD" });
      expect(head.response.status).toBe(307);
      expect(head.response.headers.get("Location")).not.toBe(get.response.headers.get("Location"));
      expect(new URL(head.response.headers.get("Location") ?? "").searchParams.get("X-Amz-Signature")).toBe(
        await referencePresignedSignature(head.response.headers.get("Location") ?? "", {}, testEnv.R2_S3_SECRET_ACCESS_KEY as string, "HEAD"),
      );

      const rangedHead = await request(`/${key}`, { method: "HEAD", headers: { Range: "bytes=0-3" } });
      expect(rangedHead.response.status).toBe(206);
      expect(rangedHead.response.headers.get("Content-Range")).toBe("bytes 0-3/11");
      expect(rangedHead.response.headers.get("Content-Length")).toBe("4");

      const legacyKey = "nar/direct-read-legacy.nar";
      await testEnv.CACHE_BUCKET.put(legacyKey, "legacy", {
        httpMetadata: { contentType: "application/x-nix-nar", cacheControl: "public, max-age=31536000, immutable" },
      });
      const legacy = await request(`/${legacyKey}`);
      expect(legacy.response.status).toBe(200);
      expect(legacy.response.headers.get("Location")).toBeNull();
      expect(legacy.response.headers.get("Cache-Control")).toContain("max-age=21600");

      expect((await request("/not-present.narinfo")).response.status).toBe(404);
    } finally {
      delete testEnv.DIRECT_DOWNLOAD_URL_TTL_SECONDS;
    }
  });

  it("serializes concurrent direct-upload session initialization", async () => {
    const body = { key: "nar/direct-concurrent-init.nar", size: 1, sha256: "0".repeat(64) };
    const init = () => request("/api/uploads", {
      method: "POST",
      headers: { ...bearer("write-secret"), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const results = await Promise.all([init(), init()]);
    const statuses = results.map(({ response }) => response.status);
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.every((status) => status === 200 || status === 201 || status === 409)).toBe(true);
    const successful = results.find(({ response }) => response.status === 201 || response.status === 200);
    const upload = await successful?.response.json<{ uploadId: string }>();
    if (upload?.uploadId) {
      await testEnv.DB.prepare("UPDATE upload_sessions SET expires_at = ?, updated_at = ? WHERE id = ?")
        .bind("2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", upload.uploadId).run();
      await cleanupUploadSessions(testEnv, 10);
    }
  });

  it("uploads a NAR directly to a presigned staging URL and finalizes it", async () => {
    const body = new TextEncoder().encode("direct-upload-body");
    const key = "nar/direct-finalize.nar";
    const init = await request("/api/uploads", {
      method: "POST",
      headers: { ...bearer("write-secret"), "Content-Type": "application/json" },
      body: JSON.stringify({ key, size: body.byteLength, sha256: await sha256Bytes(body) }),
    });
    expect(init.response.status).toBe(201);
    const upload = await init.response.json<{ uploadId: string; uploadUrl: string; uploadHeaders: Record<string, string> }>();
    expect(upload.uploadUrl).toContain("X-Amz-Signature=");
    expect(upload.uploadUrl).toContain("X-Amz-Content-Sha256=UNSIGNED-PAYLOAD");
    expect(upload.uploadUrl).not.toContain("test-secret-key");
    expect(upload.uploadHeaders).toEqual({ "Content-Type": "application/octet-stream", "If-None-Match": "*" });

    const stagingKey = stagingKeyFromPresignedUrl(upload.uploadUrl);
    await testEnv.CACHE_BUCKET.put(stagingKey, body, { onlyIf: { etagDoesNotMatch: "*" } });
    const complete = await request(`/api/uploads/${upload.uploadId}/complete`, { method: "POST", headers: bearer("write-secret") });
    expect(complete.response.status).toBe(201);
    expect(await complete.response.json<{ key: string; size: number; duplicate: boolean }>()).toMatchObject({ key, size: body.byteLength, duplicate: false });

    const head = await request(`/${key}`, { method: "HEAD" });
    expect(head.response.status).toBe(200);
    expect(head.response.headers.get("Content-Length")).toBe(String(body.byteLength));
    expect((await testEnv.DB.prepare("SELECT state, sha256 FROM objects WHERE r2_key = ?").bind(key).first<{ state: string; sha256: string }>())).toMatchObject({ state: "ready", sha256: await sha256Bytes(body) });
    expect(await testEnv.CACHE_BUCKET.head(stagingKey)).not.toBeNull();
    expect(await testEnv.CACHE_BUCKET.put(stagingKey, body, { onlyIf: { etagDoesNotMatch: "*" } })).toBeNull();

    await testEnv.DB.prepare("UPDATE upload_sessions SET expires_at = ?, updated_at = ? WHERE id = ?")
      .bind("2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", upload.uploadId).run();
    const lateReplay = await request(`/api/uploads/${upload.uploadId}/complete`, { method: "POST", headers: bearer("write-secret") });
    expect(lateReplay.response.status).toBe(200);
    await cleanupUploadSessions(testEnv, 10);
    expect(await testEnv.CACHE_BUCKET.head(stagingKey)).toBeNull();
  });

  it("keeps direct upload completion idempotent and enforces the narinfo dependency", async () => {
    const body = new TextEncoder().encode("direct-idempotent-body");
    const key = "nar/direct-idempotent.nar";
    const init = await request("/api/uploads", {
      method: "POST",
      headers: { ...bearer("write-secret"), "Content-Type": "application/json" },
      body: JSON.stringify({ key, size: body.byteLength, sha256: await sha256Bytes(body) }),
    });
    const upload = await init.response.json<{ uploadId: string; uploadUrl: string }>();
    const beforeNarinfo = await request("/direct-idempotent.narinfo", {
      method: "PUT",
      headers: bearer("write-secret"),
      body: narInfoBody(key, "/nix/store/direct-idempotent"),
    });
    expect(beforeNarinfo.response.status).toBe(424);
    await testEnv.CACHE_BUCKET.put(stagingKeyFromPresignedUrl(upload.uploadUrl), body, { onlyIf: { etagDoesNotMatch: "*" } });
    const first = await request(`/api/uploads/${upload.uploadId}/complete`, { method: "POST", headers: bearer("write-secret") });
    expect(first.response.status).toBe(201);
    const replay = await request(`/api/uploads/${upload.uploadId}/complete`, { method: "POST", headers: bearer("write-secret") });
    expect(replay.response.status).toBe(200);
    expect((await replay.response.json<{ duplicate: boolean }>()).duplicate).toBe(true);
    const narinfo = await request("/direct-idempotent.narinfo", {
      method: "PUT",
      headers: bearer("write-secret"),
      body: narInfoBody(key, "/nix/store/direct-idempotent"),
    });
    expect(narinfo.response.status).toBe(201);
  });

  it("rejects a direct upload with a wrong digest and cleans its staging object", async () => {
    const body = new TextEncoder().encode("wrong-direct-digest");
    const init = await request("/api/uploads", {
      method: "POST",
      headers: { ...bearer("write-secret"), "Content-Type": "application/json" },
      body: JSON.stringify({ key: "nar/direct-wrong-digest.nar", size: body.byteLength, sha256: "f".repeat(64) }),
    });
    const upload = await init.response.json<{ uploadId: string; uploadUrl: string }>();
    const stagingKey = stagingKeyFromPresignedUrl(upload.uploadUrl);
    await testEnv.CACHE_BUCKET.put(stagingKey, body, { onlyIf: { etagDoesNotMatch: "*" } });
    const complete = await request(`/api/uploads/${upload.uploadId}/complete`, { method: "POST", headers: bearer("write-secret") });
    expect(complete.response.status).toBe(422);
    expect((await testEnv.DB.prepare("SELECT status, error_code FROM upload_sessions WHERE id = ?").bind(upload.uploadId).first<{ status: string; error_code: string }>())).toMatchObject({ status: "failed", error_code: "upload_digest_mismatch" });
    expect(await testEnv.CACHE_BUCKET.head(stagingKey)).not.toBeNull();
    await testEnv.DB.prepare("UPDATE upload_sessions SET expires_at = ?, updated_at = ? WHERE id = ?")
      .bind("2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", upload.uploadId).run();
    await cleanupUploadSessions(testEnv, 10);
    expect(await testEnv.CACHE_BUCKET.head(stagingKey)).toBeNull();
    expect((await request("/nar/direct-wrong-digest.nar", { method: "HEAD" })).response.status).toBe(404);
  });

  it("rejects a direct upload with a wrong size", async () => {
    const body = new TextEncoder().encode("wrong-direct-size");
    const init = await request("/api/uploads", {
      method: "POST",
      headers: { ...bearer("write-secret"), "Content-Type": "application/json" },
      body: JSON.stringify({ key: "nar/direct-wrong-size.nar", size: body.byteLength + 1, sha256: await sha256Bytes(body) }),
    });
    const upload = await init.response.json<{ uploadId: string; uploadUrl: string }>();
    const stagingKey = stagingKeyFromPresignedUrl(upload.uploadUrl);
    await testEnv.CACHE_BUCKET.put(stagingKey, body, { onlyIf: { etagDoesNotMatch: "*" } });
    const complete = await request(`/api/uploads/${upload.uploadId}/complete`, { method: "POST", headers: bearer("write-secret") });
    expect(complete.response.status).toBe(422);
    expect((await testEnv.DB.prepare("SELECT status, error_code FROM upload_sessions WHERE id = ?").bind(upload.uploadId).first<{ status: string; error_code: string }>())).toMatchObject({ status: "failed", error_code: "upload_size_mismatch" });
    expect(await testEnv.CACHE_BUCKET.head(stagingKey)).not.toBeNull();
    await testEnv.DB.prepare("UPDATE upload_sessions SET expires_at = ?, updated_at = ? WHERE id = ?")
      .bind("2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", upload.uploadId).run();
    await cleanupUploadSessions(testEnv, 10);
    expect(await testEnv.CACHE_BUCKET.head(stagingKey)).toBeNull();
  });

  it("preserves the normal PUT object when it wins the direct-upload race", async () => {
    const directBody = new TextEncoder().encode("direct-race-body");
    const key = "nar/direct-race.nar";
    const init = await request("/api/uploads", {
      method: "POST",
      headers: { ...bearer("write-secret"), "Content-Type": "application/json" },
      body: JSON.stringify({ key, size: directBody.byteLength, sha256: await sha256Bytes(directBody) }),
    });
    const upload = await init.response.json<{ uploadId: string; uploadUrl: string }>();
    const stagingKey = stagingKeyFromPresignedUrl(upload.uploadUrl);
    await testEnv.CACHE_BUCKET.put(stagingKey, directBody, { onlyIf: { etagDoesNotMatch: "*" } });
    const normal = await request(`/${key}`, { method: "PUT", headers: bearer("write-secret"), body: "normal-race-body" });
    expect(normal.response.status).toBe(201);
    const complete = await request(`/api/uploads/${upload.uploadId}/complete`, { method: "POST", headers: bearer("write-secret") });
    expect(complete.response.status).toBe(409);
    expect(new TextDecoder().decode(await (await request(`/${key}`)).response.arrayBuffer())).toBe("normal-race-body");
    await testEnv.DB.prepare("UPDATE upload_sessions SET expires_at = ?, updated_at = ? WHERE id = ?")
      .bind("2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", upload.uploadId).run();
    await cleanupUploadSessions(testEnv, 10);
  });

  it("does not treat a replaced completed object as an idempotent replay", async () => {
    const body = new TextEncoder().encode("completed-object-original");
    const key = "nar/direct-replaced-after-complete.nar";
    const init = await request("/api/uploads", {
      method: "POST",
      headers: { ...bearer("write-secret"), "Content-Type": "application/json" },
      body: JSON.stringify({ key, size: body.byteLength, sha256: await sha256Bytes(body) }),
    });
    const upload = await init.response.json<{ uploadId: string; uploadUrl: string }>();
    await testEnv.CACHE_BUCKET.put(stagingKeyFromPresignedUrl(upload.uploadUrl), body, { onlyIf: { etagDoesNotMatch: "*" } });
    expect((await request(`/api/uploads/${upload.uploadId}/complete`, { method: "POST", headers: bearer("write-secret") })).response.status).toBe(201);

    await testEnv.CACHE_BUCKET.delete(key);
    await testEnv.CACHE_BUCKET.put(key, new Uint8Array(body.byteLength).fill(88), { onlyIf: { etagDoesNotMatch: "*" } });
    const replay = await request(`/api/uploads/${upload.uploadId}/complete`, { method: "POST", headers: bearer("write-secret") });
    expect(replay.response.status).toBe(409);
    await testEnv.DB.prepare("UPDATE upload_sessions SET expires_at = ?, updated_at = ? WHERE id = ?")
      .bind("2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", upload.uploadId).run();
    await cleanupUploadSessions(testEnv, 10);
    await testEnv.CACHE_BUCKET.delete(key);
    await testEnv.DB.prepare("DELETE FROM objects WHERE r2_key = ?").bind(key).run();
  });

  it("cleans expired direct-upload staging objects", async () => {
    const body = new TextEncoder().encode("expired-direct-upload");
    const init = await request("/api/uploads", {
      method: "POST",
      headers: { ...bearer("write-secret"), "Content-Type": "application/json" },
      body: JSON.stringify({ key: "nar/direct-expired.nar", size: body.byteLength, sha256: await sha256Bytes(body) }),
    });
    expect(init.response.status).toBe(201);
    const upload = await init.response.json<{ uploadId: string; uploadUrl: string }>();
    const stagingKey = stagingKeyFromPresignedUrl(upload.uploadUrl);
    await testEnv.CACHE_BUCKET.put(stagingKey, body, { onlyIf: { etagDoesNotMatch: "*" } });
    await testEnv.DB.prepare("UPDATE upload_sessions SET expires_at = ?, updated_at = ? WHERE id = ?")
      .bind("2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", upload.uploadId).run();

    await cleanupUploadSessions(testEnv, 10);

    expect(await testEnv.CACHE_BUCKET.head(stagingKey)).toBeNull();
    expect(await testEnv.DB.prepare("SELECT id FROM upload_sessions WHERE id = ?").bind(upload.uploadId).first()).toBeNull();
  });

  it("uses strong If-Match and standard unsatisfied range responses", async () => {
    const upload = await request("/nar/conditional-semantics.nar", { method: "PUT", headers: bearer("write-secret"), body: "0123456789" });
    const etag = upload.response.headers.get("ETag") ?? "";
    const weak = await request("/nar/conditional-semantics.nar", { method: "PUT", headers: { ...bearer("write-secret"), "If-Match": `W/${etag}` }, body: "0123456789" });
    expect(weak.response.status).toBe(412);
    const invalidRange = await request("/nar/conditional-semantics.nar", { headers: { Range: "bytes=99-" } });
    expect(invalidRange.response.status).toBe(416);
    expect(invalidRange.response.headers.get("Content-Range")).toBe("bytes */10");
  });

  it("rejects incomplete narinfo metadata", async () => {
    await request("/nar/incomplete-narinfo.nar", { method: "PUT", headers: bearer("write-secret"), body: "payload" });
    const response = await request("/incomplete-narinfo.narinfo", { method: "PUT", headers: bearer("write-secret"), body: "URL: /nar/incomplete-narinfo.nar\n" });
    expect(response.response.status).toBe(422);
  });

  it("accepts whitespace-only blank lines in narinfo metadata", async () => {
    await request("/nar/whitespace-narinfo.nar", { method: "PUT", headers: bearer("write-secret"), body: "payload" });
    const response = await request("/whitespace-narinfo.narinfo", {
      method: "PUT",
      headers: bearer("write-secret"),
      body: `${narInfoBody("nar/whitespace-narinfo.nar", "/nix/store/whitespace-narinfo")}  \n\t\n`,
    });
    expect(response.response.status).toBe(201);
  });

  it("accepts Nix netrc Basic credentials for uploads", async () => {
    const upload = await request("/nar/netrc-version.nar", { method: "PUT", headers: netrcBasic("write-secret"), body: "netrc" });
    expect(upload.response.status).toBe(201);
    const invalid = await request("/nar/netrc-invalid-version.nar", { method: "PUT", headers: netrcBasic("wrong-secret"), body: "netrc" });
    expect(invalid.response.status).toBe(401);
  });

  it("requires the referenced NAR before accepting narinfo", async () => {
    const missing = await request("/missing-version.narinfo", { method: "PUT", headers: bearer("write-secret"), body: narInfoBody("nar/does-not-exist.nar", "/nix/store/missing") });
    expect(missing.response.status).toBe(424);
    await uploadPair("strict-version");
  });

  it("uses version retention after package/version registration and refreshes registration order on replay", async () => {
    const pair = await uploadPair("ttl-version");
    const beforeNar = await request(`/${pair.narKey}`);
    const beforeNarinfo = await request(`/${pair.narinfoKey}`);
    expect(beforeNar.response.headers.get("Cache-Control")).toBe("public, max-age=21600, immutable");
    expect(beforeNarinfo.response.headers.get("Cache-Control")).toBe("public, max-age=21600");
    const registration = await register("ttl-package", "2026.1", [pair.narinfoKey], { retentionDays: 2, tags: { channel: "stable" } });
    expect(registration.response.status).toBe(201);
    const afterNar = await request(`/${pair.narKey}`);
    const afterNarinfo = await request(`/${pair.narinfoKey}`);
    expect(afterNar.response.headers.get("Cache-Control")).toBe("public, max-age=172800, immutable");
    expect(afterNarinfo.response.headers.get("Cache-Control")).toBe("public, max-age=172800");
    const oldRegisteredAt = "2000-01-01T00:00:00.000Z";
    await testEnv.DB.prepare("UPDATE artifact_versions SET registered_at = ? WHERE package_name = ? AND version_name = ?")
      .bind(oldRegisteredAt, "ttl-package", "2026.1").run();
    const replay = await register("ttl-package", "2026.1", [pair.narinfoKey], { retentionDays: 3 });
    expect(replay.response.status).toBe(200);
    const replayed = await replay.response.json<{ registeredAt: string }>();
    expect(Date.parse(replayed.registeredAt)).toBeGreaterThan(Date.parse(oldRegisteredAt));
    const persisted = await testEnv.DB.prepare("SELECT registered_at FROM artifact_versions WHERE package_name = ? AND version_name = ?")
      .bind("ttl-package", "2026.1").first<{ registered_at: string }>();
    expect(persisted?.registered_at).toBe(replayed.registeredAt);
  });

  it("shows finite retention duration and remaining days separately in the admin API", async () => {
    const packageName = "retention-display-package";
    const now = Date.now();
    const versions = [
      { versionName: "aging", registeredAt: new Date(now - 36 * 60 * 60 * 1000).toISOString() },
      { versionName: "recent-1", registeredAt: new Date(now - 3 * 60 * 60 * 1000).toISOString() },
      { versionName: "recent-2", registeredAt: new Date(now - 2 * 60 * 60 * 1000).toISOString() },
      { versionName: "recent-3", registeredAt: new Date(now - 60 * 60 * 1000).toISOString() },
      { versionName: "expired", registeredAt: new Date(now - 4 * 24 * 60 * 60 * 1000).toISOString() },
    ];
    for (const version of versions) {
      await testEnv.DB.prepare(
        "INSERT INTO artifact_versions (version_id, package_name, version_name, tags_json, retention_days, registered_at, updated_at, state) VALUES (?, ?, ?, '{}', 3, ?, ?, 'active')",
      ).bind(crypto.randomUUID(), packageName, version.versionName, version.registeredAt, version.registeredAt).run();
    }
    const response = await request(`/api/admin/packages/${packageName}`, { headers: bearer("admin-secret") });
    expect(response.response.status).toBe(200);
    const body = await response.response.json<{ versions: Array<{ versionName: string; retentionState: string; retentionRemainingDays: number | null; retentionRemainingSeconds: number | null; protectedByKeepLatest: boolean }> }>();
    const aging = body.versions.find((version) => version.versionName === "aging");
    const protectedVersion = body.versions.find((version) => version.versionName === "recent-3");
    const expired = body.versions.find((version) => version.versionName === "expired");
    expect(aging).toMatchObject({ retentionState: "3 days", retentionRemainingDays: 2 });
    expect(aging?.retentionRemainingSeconds).toBeGreaterThan(129500);
    expect(aging?.retentionRemainingSeconds).toBeLessThan(129700);
    expect(protectedVersion).toMatchObject({ protectedByKeepLatest: true, retentionState: "persistent", retentionRemainingDays: null });
    expect(expired?.retentionRemainingSeconds).toBeLessThan(0);
  });

  it("marks unprotected capacity-overage versions as GC eligible in retention summaries", async () => {
    const packageName = "retention-capacity-display-package";
    const now = Date.now();
    for (let index = 0; index < 5; index += 1) {
      const registeredAt = new Date(now - (5 - index) * 1000).toISOString();
      await testEnv.DB.prepare(
        "INSERT INTO artifact_versions (version_id, package_name, version_name, tags_json, retention_days, registered_at, updated_at, state) VALUES (?, ?, ?, '{}', 30, ?, ?, 'active')",
      ).bind(`${packageName}-v${index}`, packageName, `v${index}`, registeredAt, registeredAt).run();
    }
    const policy = await request("/api/admin/policies", {
      method: "POST",
      headers: { ...bearer("admin-secret"), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "capacity-display-rule", conditions: [{ field: "pkg_name", operator: "equals", value: packageName, negate: false }], groupBy: ["pkg_name"], lastN: null, durationDays: null, capacityVersions: 2 }),
    });
    expect(policy.response.status).toBe(201);

    const response = await request(`/api/admin/packages/${packageName}`, { headers: bearer("admin-secret") });
    expect(response.response.status).toBe(200);
    const body = await response.response.json<{ versions: Array<{ versionName: string; capacityExceeded: boolean; protectedByKeepLatest: boolean }> }>();
    expect(body.versions.find((version) => version.versionName === "v0")).toMatchObject({ capacityExceeded: true, protectedByKeepLatest: false });
    expect(body.versions.find((version) => version.versionName === "v1")).toMatchObject({ capacityExceeded: true, protectedByKeepLatest: false });
    expect(body.versions.find((version) => version.versionName === "v2")).toMatchObject({ capacityExceeded: false, protectedByKeepLatest: true });
    expect(body.versions.find((version) => version.versionName === "v4")).toMatchObject({ capacityExceeded: false, protectedByKeepLatest: true });
  });

  it("reports capacity overage when overlapping capacity groups disagree", async () => {
    const packageName = "overlapping-capacity-display-package";
    const now = Date.now();
    for (let index = 0; index < 4; index += 1) {
      const registeredAt = new Date(now - (4 - index) * 1000).toISOString();
      await testEnv.DB.prepare(
        "INSERT INTO artifact_versions (version_id, package_name, version_name, tags_json, retention_days, registered_at, updated_at, state) VALUES (?, ?, ?, '{\"channel\":\"stable\"}', 30, ?, ?, 'active')",
      ).bind(`${packageName}-v${index}`, packageName, `v${index}`, registeredAt, registeredAt).run();
    }
    for (const [name, groupBy, capacityVersions] of [
      ["overlap-package-capacity-rule", ["pkg_name"], 2],
      ["overlap-channel-capacity-rule", ["pkg_tag:channel"], 100],
    ] as const) {
      const policy = await request("/api/admin/policies", {
        method: "POST",
        headers: { ...bearer("admin-secret"), "Content-Type": "application/json" },
        body: JSON.stringify({ name, conditions: [{ field: "pkg_name", operator: "equals", value: packageName, negate: false }], groupBy, lastN: null, durationDays: null, capacityVersions }),
      });
      expect(policy.response.status).toBe(201);
    }

    const response = await request(`/api/admin/packages/${packageName}`, { headers: bearer("admin-secret") });
    expect(response.response.status).toBe(200);
    const body = await response.response.json<{ versions: Array<{ versionName: string; capacityExceeded: boolean; protectedByKeepLatest: boolean }> }>();
    expect(body.versions.find((version) => version.versionName === "v0")).toMatchObject({ capacityExceeded: true, protectedByKeepLatest: false });
    expect(body.versions.find((version) => version.versionName === "v3")).toMatchObject({ capacityExceeded: false, protectedByKeepLatest: true });
  });

  it("exposes package, version, and file hierarchy and targets version operations", async () => {
    const first = await uploadPair("hierarchy-v1");
    const second = await uploadPair("hierarchy-v2");
    expect((await register("demo-package", "1.0", [first.narinfoKey], { tags: { channel: "stable" } })).response.status).toBe(201);
    expect((await register("demo-package", "2.0", [second.narinfoKey], { tags: { channel: "stable" } })).response.status).toBe(201);
    const other = await uploadPair("other-package-v1");
    expect((await register("other-package", "1.0", [other.narinfoKey])).response.status).toBe(201);

    const list = await request("/api/admin/packages", { headers: bearer("admin-secret") });
    expect(list.response.status).toBe(200);
    const listBody = await list.response.json<{ items: Array<{ packageName: string; versionCount: number; versions: Array<{ versionName: string }> }> }>();
    const demo = listBody.items.find((item) => item.packageName === "demo-package");
    expect(demo?.versionCount).toBe(2);
    expect(demo?.versions.map((version) => version.versionName).sort()).toEqual(["1.0", "2.0"]);

    const detail = await request("/api/admin/packages/demo-package/versions/1.0", { headers: bearer("admin-secret") });
    expect(detail.response.status).toBe(200);
    expect((await detail.response.json<{ files: Array<{ kind: string }> }>()).files.map((file) => file.kind).sort()).toEqual(["nar", "narinfo"]);

    const overview = await request("/api/admin/overview", { headers: bearer("admin-secret") });
    const overviewBody = await overview.response.json<{ packages: number; versions: number; pinnedVersions: number }>();
    expect(overviewBody.packages).toBeGreaterThanOrEqual(2);
    expect(overviewBody.versions).toBeGreaterThanOrEqual(3);

    const pin = await request("/api/admin/packages/demo-package/versions/1.0/pin", { method: "PUT", headers: bearer("admin-secret") });
    expect(pin.response.status).toBe(200);
    expect((await pin.response.json<{ pinned: boolean }>()).pinned).toBe(true);
    const deletion = await request("/api/admin/packages/demo-package/versions/1.0", {
      method: "DELETE",
      headers: { ...bearer("admin-secret"), "Content-Type": "application/json" },
      body: JSON.stringify({ confirmPackageName: "demo-package", confirmVersionName: "1.0", reason: "version test cleanup" }),
    });
    expect(deletion.response.status).toBe(202);
    await Promise.all(deletion.waitUntil);
    const jobId = (await deletion.response.json<{ jobId: string }>()).jobId;
    const job = await request(`/api/admin/jobs/${jobId}`, { headers: bearer("admin-secret") });
    expect((await job.response.json<{ status: string }>()).status).toBe("completed");
    expect((await request("/api/admin/packages/demo-package/versions/2.0", { headers: bearer("admin-secret") })).response.status).toBe(200);
  });

  it("locks a version as soon as deletion is queued", async () => {
    const pair = await uploadPair("deletion-lock");
    expect((await register("deletion-lock-package", "v1", [pair.narinfoKey])).response.status).toBe(201);
    const deletion = await request("/api/admin/packages/deletion-lock-package/versions/v1", {
      method: "DELETE",
      headers: { ...bearer("admin-secret"), "Content-Type": "application/json" },
      body: JSON.stringify({ confirmPackageName: "deletion-lock-package", confirmVersionName: "v1", reason: "race test" }),
    });
    expect(deletion.response.status).toBe(202);
    const blocked = await register("deletion-lock-package", "v1", [pair.narinfoKey]);
    expect(blocked.response.status).toBe(409);
    await Promise.all(deletion.waitUntil);
  });

  it("treats a concurrent deletion-job insert as an existing job", async () => {
    const versionId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const existingJobId = crypto.randomUUID();
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        "INSERT INTO artifact_versions (version_id, package_name, version_name, registered_at, updated_at, state) VALUES (?, ?, ?, ?, ?, 'active')",
      ).bind(versionId, "duplicate-delete-job-package", "v1", timestamp, timestamp),
      testEnv.DB.prepare(
        "INSERT INTO jobs (id, type, status, target_version_id, payload_json, created_at, updated_at) VALUES (?, 'delete_version', 'queued', ?, '{}', ?, ?)",
      ).bind(existingJobId, versionId, timestamp, timestamp),
    ]);

    await expect(createDeletionJob(testEnv, versionId, "admin", { reason: "race test" })).resolves.toBeNull();
    expect((await testEnv.DB.prepare("SELECT state FROM artifact_versions WHERE version_id = ?").bind(versionId).first<{ state: string }>())?.state).toBe("deleting");
    expect((await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM jobs WHERE target_version_id = ?").bind(versionId).first<{ count: number }>())?.count).toBe(1);
  });

  it("reports a busy conflict when deleting a registering version", async () => {
    const timestamp = new Date().toISOString();
    await testEnv.DB.prepare(
      "INSERT INTO artifact_versions (version_id, package_name, version_name, registered_at, updated_at, state) VALUES (?, ?, ?, ?, ?, 'registering')",
    ).bind(crypto.randomUUID(), "registering-delete-package", "v1", timestamp, timestamp).run();
    const deletion = await request("/api/admin/packages/registering-delete-package/versions/v1", {
      method: "DELETE",
      headers: { ...bearer("admin-secret"), "Content-Type": "application/json" },
      body: JSON.stringify({ confirmPackageName: "registering-delete-package", confirmVersionName: "v1", reason: "busy-state test" }),
    });
    expect(deletion.response.status).toBe(409);
    expect((await deletion.response.json<{ error: { code: string } }>()).error.code).toBe("version_busy");
    const patch = await request("/api/admin/packages/registering-delete-package/versions/v1", {
      method: "PATCH",
      headers: { ...bearer("admin-secret"), "Content-Type": "application/json" },
      body: JSON.stringify({ tags: { channel: "busy" } }),
    });
    expect(patch.response.status).toBe(409);
    expect((await patch.response.json<{ error: { code: string } }>()).error.code).toBe("version_busy");
    const pin = await request("/api/admin/packages/registering-delete-package/versions/v1/pin", {
      method: "PUT",
      headers: bearer("admin-secret"),
    });
    expect(pin.response.status).toBe(409);
    expect((await pin.response.json<{ error: { code: string } }>()).error.code).toBe("version_busy");
  });

  it("reclaims stale running jobs", async () => {
    const id = crypto.randomUUID();
    const stale = new Date(Date.now() - 16 * 60_000).toISOString();
    await testEnv.DB.prepare(
      "INSERT INTO jobs (id, type, status, payload_json, created_at, updated_at) VALUES (?, 'gc', 'running', '[\"legacy\"]', ?, ?)",
    ).bind(id, stale, stale).run();
    await runQueuedJobs(testEnv, 2);
    expect((await testEnv.DB.prepare("SELECT status FROM jobs WHERE id = ?").bind(id).first<{ status: string }>())?.status).toBe("completed");
    const payload = JSON.parse((await testEnv.DB.prepare("SELECT payload_json FROM jobs WHERE id = ?").bind(id).first<{ payload_json: string }>())?.payload_json ?? "{}");
    expect(payload[0]).toBeUndefined();
  });

  it("reuses an active GC job and drains manual GC work", async () => {
    const scheduled = await scheduleGcJob(testEnv, "test", { reason: "test" });
    const manual = await request("/api/admin/gc", { method: "POST", headers: bearer("admin-secret") });
    const body = await manual.response.json<{ jobId: string; reused: boolean }>();
    expect(manual.response.status).toBe(202);
    expect(body).toMatchObject({ jobId: scheduled.id, reused: true });
    await Promise.all(manual.waitUntil);
    expect((await testEnv.DB.prepare("SELECT status FROM jobs WHERE id = ?").bind(scheduled.id).first<{ status: string }>())?.status).toBe("completed");
    const activeGcJobs = await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM jobs WHERE type = 'gc' AND status IN ('queued', 'running', 'failed')").first<{ count: number }>();
    expect(Number(activeGcJobs?.count ?? 0)).toBe(0);
  });

  it("resumes deletion when objects are already marked deleting", async () => {
    const pair = await uploadPair("deleting-retry");
    const registration = await register("deleting-retry-package", "v1", [pair.narinfoKey]);
    expect(registration.response.status).toBe(201);
    const version = await testEnv.DB.prepare(
      "SELECT version_id FROM artifact_versions WHERE package_name = ? AND version_name = ?",
    ).bind("deleting-retry-package", "v1").first<{ version_id: string }>();
    expect(version?.version_id).toBeTruthy();
    await testEnv.DB.batch([
      testEnv.DB.prepare("UPDATE artifact_versions SET state = 'deleting' WHERE version_id = ?").bind(version?.version_id),
      testEnv.DB.prepare("UPDATE objects SET state = 'deleting' WHERE r2_key IN (?, ?)").bind(pair.narinfoKey, pair.narKey),
      testEnv.DB.prepare(
        "INSERT INTO jobs (id, type, status, target_version_id, payload_json, created_at, updated_at) VALUES (?, 'delete_version', 'queued', ?, '{}', ?, ?)",
      ).bind(crypto.randomUUID(), version?.version_id, new Date().toISOString(), new Date().toISOString()),
    ]);
    await runQueuedJobs(testEnv, 2);
    expect((await request(`/${pair.narinfoKey}`)).response.status).toBe(404);
    expect((await request(`/${pair.narKey}`)).response.status).toBe(404);
    expect((await request("/api/admin/packages/deleting-retry-package/versions/v1", { headers: bearer("admin-secret") })).response.status).toBe(404);
  });

  it("preserves shared NARs while another version references them", async () => {
    const sharedNarKey = "nar/shared-version.nar";
    const sharedNar = await request(`/${sharedNarKey}`, { method: "PUT", headers: bearer("write-secret"), body: "shared-body" });
    expect([201, 204]).toContain(sharedNar.response.status);
    const shared = { narKey: sharedNarKey, narinfoKey: "shared-version-a.narinfo" };
    const sharedNarinfo = await request(`/${shared.narinfoKey}`, { method: "PUT", headers: bearer("write-secret"), body: narInfoBody(sharedNarKey, "/nix/store/shared-version-a") });
    expect([201, 204]).toContain(sharedNarinfo.response.status);
    const secondNarinfo = "shared-version-b.narinfo";
    const second = await request(`/${secondNarinfo}`, { method: "PUT", headers: bearer("write-secret"), body: narInfoBody(sharedNarKey, "/nix/store/shared-version-b") });
    expect([201, 204]).toContain(second.response.status);
    expect((await register("shared-package", "a", [shared.narinfoKey])).response.status).toBe(201);
    expect((await register("shared-package", "b", [secondNarinfo])).response.status).toBe(201);
    const deletion = await request("/api/admin/packages/shared-package/versions/a", { method: "DELETE", headers: { ...bearer("admin-secret"), "Content-Type": "application/json" }, body: JSON.stringify({ confirmPackageName: "shared-package", confirmVersionName: "a", reason: "shared reference test" }) });
    await Promise.all(deletion.waitUntil);
    expect((await request(`/${shared.narKey}`)).response.status).toBe(200);
    expect((await request("/api/admin/packages/shared-package/versions/b", { headers: bearer("admin-secret") })).response.status).toBe(200);
  });

  it("uses seven-day retention and keeps the newest three versions per package/tag combination", async () => {
    const versions: string[] = [];
    for (const version of ["old", "middle", "new", "newest"]) {
      const pair = await uploadPair(`gc-${version}`);
      expect((await register("gc-package", version, [pair.narinfoKey], { tags: { channel: "stable" } })).response.status).toBeGreaterThanOrEqual(200);
      versions.push(version);
    }
    const base = Date.now() - 10 * 24 * 60 * 60 * 1000;
    for (let index = 0; index < versions.length; index += 1) {
      await testEnv.DB.prepare("UPDATE artifact_versions SET registered_at = ? WHERE package_name = ? AND version_name = ?")
        .bind(new Date(base + index * 1000).toISOString(), "gc-package", versions[index]).run();
    }
    const beta = await uploadPair("gc-beta-only");
    expect((await register("gc-package", "beta-only", [beta.narinfoKey], { tags: { channel: "beta" } })).response.status).toBe(201);
    await testEnv.DB.prepare("UPDATE artifact_versions SET registered_at = ? WHERE package_name = ? AND version_name = ?")
      .bind(new Date(base).toISOString(), "gc-package", "beta-only").run();
    const gc = await request("/api/admin/gc", { method: "POST", headers: bearer("admin-secret") });
    await Promise.all(gc.waitUntil);
    const latest = await request("/api/admin/packages/gc-package/versions/newest", { headers: bearer("admin-secret") });
    expect(latest.response.status).toBe(200);
    expect((await request("/api/admin/packages/gc-package/versions/old", { headers: bearer("admin-secret") })).response.status).toBe(404);
    expect((await request("/api/admin/packages/gc-package/versions/middle", { headers: bearer("admin-secret") })).response.status).toBe(200);
    expect((await request("/api/admin/packages/gc-package/versions/new", { headers: bearer("admin-secret") })).response.status).toBe(200);
  });

  it("enforces capacity independently for each group without waiting for duration", async () => {
    const packageName = "capacity-gc-package";
    const timestamp = new Date().toISOString();
    await testEnv.DB.prepare(
      "INSERT INTO artifact_packages (package_name, created_at, updated_at) VALUES (?, ?, ?)",
    ).bind(packageName, timestamp, timestamp).run();
    const versions = [
      ["a-old", "alpha"], ["a-middle", "alpha"], ["a-new", "alpha"], ["a-newest", "alpha"],
      ["b-old", "beta"], ["b-middle", "beta"], ["b-new", "beta"], ["b-newest", "beta"],
    ];
    for (const [index, [versionName, channel]] of versions.entries()) {
      const registeredAt = new Date(Date.now() - (versions.length - index) * 1000).toISOString();
      await testEnv.DB.prepare(
        "INSERT INTO artifact_versions (version_id, package_name, version_name, tags_json, registered_at, updated_at, state) VALUES (?, ?, ?, ?, ?, ?, 'active')",
      ).bind(`${packageName}-${versionName}`, packageName, versionName, JSON.stringify({ channel }), registeredAt, registeredAt).run();
    }
    const policy = await request("/api/admin/policies", {
      method: "POST",
      headers: { ...bearer("admin-secret"), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "capacity-gc-rule", conditions: [{ field: "pkg_name", operator: "equals", value: packageName, negate: false }], groupBy: ["pkg_tag:channel"], lastN: null, durationDays: null, capacityVersions: 2 }),
    });
    expect(policy.response.status).toBe(201);

    const gc = await request("/api/admin/gc", { method: "POST", headers: bearer("admin-secret") });
    await Promise.all(gc.waitUntil);

    expect((await request(`/api/admin/packages/${packageName}/versions/a-old`, { headers: bearer("admin-secret") })).response.status).toBe(404);
    expect((await request(`/api/admin/packages/${packageName}/versions/b-old`, { headers: bearer("admin-secret") })).response.status).toBe(404);
    for (const versionName of ["a-middle", "a-new", "a-newest", "b-middle", "b-new", "b-newest"]) {
      expect((await request(`/api/admin/packages/${packageName}/versions/${versionName}`, { headers: bearer("admin-secret") })).response.status).toBe(200);
    }
  });

  it("resumes capacity ranking across multiple GC pages", async () => {
    const packageName = "capacity-page-package";
    const timestamp = new Date().toISOString();
    await testEnv.DB.prepare(
      "INSERT INTO artifact_packages (package_name, created_at, updated_at) VALUES (?, ?, ?)",
    ).bind(packageName, timestamp, timestamp).run();
    const statements = Array.from({ length: 205 }, (_, index) => {
      const versionName = `v${String(index).padStart(3, "0")}`;
      const registeredAt = new Date(Date.now() - (205 - index) * 1000).toISOString();
      return testEnv.DB.prepare(
        "INSERT INTO artifact_versions (version_id, package_name, version_name, tags_json, registered_at, updated_at, state) VALUES (?, ?, ?, '{}', ?, ?, 'active')",
      ).bind(`${packageName}-${versionName}`, packageName, versionName, registeredAt, registeredAt);
    });
    for (let offset = 0; offset < statements.length; offset += 100) await testEnv.DB.batch(statements.slice(offset, offset + 100));
    const policy = await request("/api/admin/policies", {
      method: "POST",
      headers: { ...bearer("admin-secret"), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "capacity-page-rule", conditions: [{ field: "pkg_name", operator: "equals", value: packageName, negate: false }], groupBy: ["pkg_name"], lastN: null, durationDays: null, capacityVersions: 2 }),
    });
    expect(policy.response.status).toBe(201);

    const scheduled = await scheduleGcJob(testEnv, "test", { reason: "capacity-page-test" });
    await runQueuedJobs(testEnv, 4, 2);
    expect((await testEnv.DB.prepare("SELECT status FROM jobs WHERE id = ?").bind(scheduled.id).first<{ status: string }>())?.status).toBe("queued");
    await runQueuedJobs(testEnv, 10, 40);

    expect((await request(`/api/admin/packages/${packageName}/versions/v000`, { headers: bearer("admin-secret") })).response.status).toBe(404);
    expect((await request(`/api/admin/packages/${packageName}/versions/v001`, { headers: bearer("admin-secret") })).response.status).toBe(404);
    for (const versionName of ["v202", "v203", "v204"]) {
      expect((await request(`/api/admin/packages/${packageName}/versions/${versionName}`, { headers: bearer("admin-secret") })).response.status).toBe(200);
    }
  });
});
