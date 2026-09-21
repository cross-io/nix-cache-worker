import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { app } from "../src/app";
import type { Bindings } from "../src/env";
import { cleanupExpiredNarinfoReservations } from "../src/routes/narinfo";
import { cleanupUploadSessions } from "../src/storage/uploads";
import { homePage } from "../src/ui/home";

const testEnv = {
  ...env,
  READ_TOKEN: "read-secret",
  WRITE_TOKEN: "write-secret",
  ADMIN_TOKEN: "admin-secret",
  DEFAULT_RETENTION_DAYS: "7",
  DEFAULT_STORE_DIR: "/nix/store",
  DEFAULT_PRIORITY: "40",
  DEFAULT_WANT_MASS_QUERY: "1",
  R2_ACCOUNT_ID: "00000000000000000000000000000000",
  R2_BUCKET_NAME: "nix-cache-test",
  R2_S3_ACCESS_KEY_ID: "test-access-key",
  R2_S3_SECRET_ACCESS_KEY: "test-secret-key",
  DIRECT_DOWNLOAD_URL_TTL_SECONDS: "900",
} as Bindings;

beforeAll(async () => {
  const schema = `
    PRAGMA foreign_keys = ON;
    DROP TABLE IF EXISTS artifact_version_pending_members;
    DROP TABLE IF EXISTS artifact_version_members;
    DROP TABLE IF EXISTS narinfo_refs;
    DROP TABLE IF EXISTS upload_sessions;
    DROP TABLE IF EXISTS write_claims;
    DROP TABLE IF EXISTS job_object_items;
    DROP TABLE IF EXISTS gc_scan_versions;
    DROP TABLE IF EXISTS gc_policy_matches;
    DROP TABLE IF EXISTS jobs;
    DROP TABLE IF EXISTS artifact_versions;
    DROP TABLE IF EXISTS artifact_packages;
    DROP TABLE IF EXISTS objects;
    DROP TABLE IF EXISTS gc_policies;
    DROP TABLE IF EXISTS audit_log;
    CREATE TABLE artifact_packages (package_name TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE objects (r2_key TEXT PRIMARY KEY, kind TEXT NOT NULL, etag TEXT NOT NULL, sha256 TEXT, size INTEGER NOT NULL, uploaded_at TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'ready', narinfo_ref_count INTEGER NOT NULL DEFAULT 0, version_member_count INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE write_claims (r2_key TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at TEXT NOT NULL);
    CREATE TABLE upload_sessions (id TEXT PRIMARY KEY, r2_key TEXT NOT NULL, staging_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL CHECK (kind = 'nar'), expected_size INTEGER NOT NULL, expected_sha256 TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'completed', 'failed', 'expired', 'revoked')), object_etag TEXT, error_code TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, completed_at TEXT, updated_at TEXT NOT NULL);
    CREATE INDEX idx_upload_sessions_expiry ON upload_sessions(status, expires_at);
    CREATE INDEX idx_upload_sessions_key ON upload_sessions(r2_key, status, created_at DESC);
    CREATE UNIQUE INDEX idx_upload_sessions_active_key ON upload_sessions(r2_key) WHERE status = 'issued';
    CREATE TABLE narinfo_refs (narinfo_key TEXT PRIMARY KEY, nar_key TEXT NOT NULL, store_path TEXT, created_at TEXT NOT NULL);
    CREATE INDEX idx_narinfo_refs_nar ON narinfo_refs(nar_key);
    CREATE TABLE artifact_versions (version_id TEXT PRIMARY KEY, package_name TEXT NOT NULL, version_name TEXT NOT NULL, tags_json TEXT NOT NULL DEFAULT '{}', retention_days INTEGER, pinned INTEGER NOT NULL DEFAULT 0, registered_at TEXT NOT NULL, updated_at TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('registering', 'active', 'deleting', 'deleted')), registration_token TEXT, UNIQUE(package_name, version_name));
    CREATE TABLE artifact_version_members (version_id TEXT NOT NULL, narinfo_key TEXT NOT NULL, PRIMARY KEY(version_id, narinfo_key));
    CREATE INDEX idx_artifact_version_members_narinfo ON artifact_version_members(narinfo_key);
    CREATE TABLE artifact_version_pending_members (version_id TEXT NOT NULL, registration_token TEXT NOT NULL, narinfo_key TEXT NOT NULL, PRIMARY KEY(version_id, registration_token, narinfo_key));
    CREATE TABLE gc_policies (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, conditions_json TEXT NOT NULL DEFAULT '[]', group_by_json TEXT NOT NULL DEFAULT '[]', last_n INTEGER, duration_days INTEGER, capacity_versions INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE jobs (id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL, target_version_id TEXT, cursor INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, payload_json TEXT NOT NULL DEFAULT '{}', last_error TEXT, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX idx_jobs_active_delete_target ON jobs(target_version_id) WHERE type = 'delete_version' AND target_version_id IS NOT NULL AND status IN ('queued', 'running', 'failed');
    CREATE TABLE job_object_items (job_id TEXT NOT NULL, object_key TEXT NOT NULL, object_kind TEXT NOT NULL, PRIMARY KEY(job_id, object_key, object_kind));
    CREATE TABLE gc_scan_versions (job_id TEXT NOT NULL, version_id TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(job_id, version_id));
    CREATE TABLE gc_policy_matches (job_id TEXT NOT NULL, version_id TEXT NOT NULL, policy_id INTEGER NOT NULL, group_key TEXT NOT NULL, registered_at TEXT NOT NULL, keep_count INTEGER, capacity_versions INTEGER, PRIMARY KEY(job_id, version_id, policy_id));
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, actor TEXT NOT NULL, target TEXT, details_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
    INSERT INTO gc_policies (name, conditions_json, group_by_json, last_n, duration_days, capacity_versions, created_at, updated_at) VALUES ('default-package-tags', '[]', '["pkg_name","pkg_tags"]', 3, NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `;
  for (const statement of schema.split(";")) if (statement.trim()) await testEnv.DB.exec(statement);
  await Promise.all([
    "nar/shared.nar",
    "nar/immutable.nar",
    "nar/direct.nar",
    "nar/bad.nar",
  ].map((key) => testEnv.CACHE_BUCKET.delete(key)));
});

async function request(path: string, init: RequestInit = {}): Promise<{ response: Response; waitUntil: Promise<unknown>[] }> {
  const waiters: Promise<unknown>[] = [];
  const headers = new Headers(init.headers);
  if (init.method === "PUT" && typeof init.body === "string" && !headers.has("Content-Length")) {
    headers.set("Content-Length", String(new TextEncoder().encode(init.body).byteLength));
  }
  const response = await app.fetch(new Request(`https://cache.test${path}`, { ...init, headers }), testEnv, {
    waitUntil(promise: Promise<unknown>) { waiters.push(promise); },
  } as ExecutionContext);
  return { response, waitUntil: waiters };
}

function bearer(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

async function uploadNarObject(key: string, body: string): Promise<{ response: Response; waitUntil: Promise<unknown>[] }> {
  const bytes = new TextEncoder().encode(body);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const issued = await request("/api/uploads", {
    method: "POST",
    headers: { ...bearer("write-secret"), "Content-Type": "application/json" },
    body: JSON.stringify({ key, size: bytes.byteLength, sha256 }),
  });
  if (issued.response.status !== 201) return issued;
  const issuedBody = await issued.response.json<Record<string, unknown>>();
  if (issuedBody.alreadyExists === true) return issued;
  const uploadId = String(issuedBody.uploadId);
  await testEnv.CACHE_BUCKET.put(`_nix_uploads/${uploadId}`, body, {
    httpMetadata: { contentType: "application/octet-stream" },
  });
  return request(`/api/uploads/${uploadId}/complete`, {
    method: "POST",
    headers: { ...bearer("write-secret"), "Content-Type": "application/json" },
  });
}

function narInfoBody(narKey: string, storePath: string): string {
  return `StorePath: ${storePath}\nURL: /${narKey}\nCompression: none\nFileHash: sha256:0000000000000000000000000000000000000000000000000000000000000000\nFileSize: 5\nNarHash: sha256:1111111111111111111111111111111111111111111111111111111111111111\nNarSize: 5\nReferences: \n`;
}

async function uploadNarInfo(prefix: string, narKey = "nar/shared.nar"): Promise<string> {
  const key = `${prefix}.narinfo`;
  const result = await request(`/${key}`, {
    method: "PUT",
    headers: bearer("write-secret"),
    body: narInfoBody(narKey, `/nix/store/${prefix}`),
  });
  expect([201, 204]).toContain(result.response.status);
  return key;
}

describe("cache read routing", () => {
  it("requires READ_TOKEN and redirects without an existence check", async () => {
    const anonymous = await request("/nar/missing.nar");
    expect(anonymous.response.status).toBe(401);
    const redirected = await request("/nar/missing.nar", { headers: bearer("read-secret") });
    expect(redirected.response.status).toBe(307);
    expect(redirected.response.headers.get("Cache-Control")).toBe("no-store");
    expect(redirected.response.headers.get("Location")).toContain("X-Amz-Signature=");
  });

  it("allows anonymous redirects when READ_TOKEN is empty", async () => {
    const previous = testEnv.READ_TOKEN;
    testEnv.READ_TOKEN = "";
    try {
      const response = await request("/nar/not-present.nar");
      expect(response.response.status).toBe(307);
    } finally {
      testEnv.READ_TOKEN = previous;
    }
  });

  it("generates cache-info from variables without D1 settings", async () => {
    const response = await request("/nix-cache-info", { headers: bearer("read-secret") });
    expect(response.response.status).toBe(200);
    expect(await response.response.text()).toContain("StoreDir: /nix/store");
    expect(response.response.headers.get("Cache-Control")).toBe("public, max-age=300");
  });
});

describe("staging direct uploads", () => {
  it("rejects Worker NAR PUTs and requires the staging protocol", async () => {
    const response = await request("/nar/worker-upload.nar", {
      method: "PUT",
      headers: bearer("write-secret"),
      body: "hello",
    });
    expect(response.response.status).toBe(405);
    expect(await response.response.json()).toMatchObject({ error: { code: "direct_upload_required" } });
  });

  it("stages a NAR, promotes it, and makes retries idempotent", async () => {
    const issued = await request("/api/uploads", {
      method: "POST",
      headers: { ...bearer("write-secret"), "Content-Type": "application/json" },
      body: JSON.stringify({
        key: "nar/direct.nar",
        size: 5,
        sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      }),
    });
    expect(issued.response.status).toBe(201);
    const issuedBody = await issued.response.json<Record<string, unknown>>();
    expect(String(issuedBody.uploadUrl)).toContain("_nix_uploads");
    expect(String(issuedBody.uploadId)).toMatch(/^[0-9a-f-]{36}$/i);
    expect(await testEnv.DB.prepare("SELECT r2_key FROM objects WHERE r2_key = ?").bind("nar/direct.nar").first()).toBeNull();

    const uploadId = String(issuedBody.uploadId);
    const stagingRead = await request(`/_nix_uploads/${uploadId}`, { headers: bearer("read-secret") });
    expect(stagingRead.response.status).toBe(404);
    await testEnv.CACHE_BUCKET.put(`_nix_uploads/${uploadId}`, "hello", {
      httpMetadata: { contentType: "application/octet-stream" },
    });
    const completed = await request(`/api/uploads/${uploadId}/complete`, {
      method: "POST",
      headers: { ...bearer("write-secret"), "Content-Type": "application/json" },
    });
    expect(completed.response.status).toBe(201);
    expect(await testEnv.CACHE_BUCKET.head("_nix_uploads/" + uploadId)).not.toBeNull();
    expect(await testEnv.CACHE_BUCKET.head("nar/direct.nar")).not.toBeNull();

    const replay = await request(`/api/uploads/${uploadId}/complete`, {
      method: "POST",
      headers: { ...bearer("write-secret"), "Content-Type": "application/json" },
    });
    expect(replay.response.status).toBe(200);

    const same = await request("/api/uploads", {
      method: "POST",
      headers: { ...bearer("write-secret"), "Content-Type": "application/json" },
      body: JSON.stringify({
        key: "nar/direct.nar",
        size: 5,
        sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      }),
    });
    expect(same.response.status).toBe(200);
    expect(await same.response.json()).toMatchObject({ alreadyExists: true });

    const conflict = await request("/api/uploads", {
      method: "POST",
      headers: { ...bearer("write-secret"), "Content-Type": "application/json" },
      body: JSON.stringify({ key: "nar/direct.nar", size: 5, sha256: "0".repeat(64) }),
    });
    expect(conflict.response.status).toBe(409);

    const ranged = await request("/nar/direct.nar", { method: "HEAD", headers: { ...bearer("read-secret"), Range: "bytes=1-3" } });
    expect(ranged.response.status).toBe(206);
    expect(ranged.response.headers.get("Content-Range")).toBe("bytes 1-3/5");
  });

  it("rejects staging content with a wrong digest without creating a final object", async () => {
    const issued = await request("/api/uploads", {
      method: "POST",
      headers: { ...bearer("write-secret"), "Content-Type": "application/json" },
      body: JSON.stringify({ key: "nar/bad.nar", size: 5, sha256: "0".repeat(64) }),
    });
    expect(issued.response.status).toBe(201);
    const uploadId = String((await issued.response.json<Record<string, unknown>>()).uploadId);
    await testEnv.CACHE_BUCKET.put(`_nix_uploads/${uploadId}`, "hello");
    const completed = await request(`/api/uploads/${uploadId}/complete`, {
      method: "POST",
      headers: { ...bearer("write-secret"), "Content-Type": "application/json" },
    });
    expect(completed.response.status).toBe(422);
    expect(await testEnv.CACHE_BUCKET.head("nar/bad.nar")).toBeNull();
  });

  it("allows key reuse after the final object and D1 row are removed", async () => {
    const first = await uploadNarObject("nar/reusable.nar", "first");
    expect(first.response.status).toBe(201);
    await testEnv.CACHE_BUCKET.delete("nar/reusable.nar");
    await testEnv.DB.prepare("DELETE FROM objects WHERE r2_key = ?").bind("nar/reusable.nar").run();
    const second = await uploadNarObject("nar/reusable.nar", "second");
    expect(second.response.status).toBe(201);
    expect(await testEnv.CACHE_BUCKET.head("nar/reusable.nar")).not.toBeNull();
  });

  it("rejects direct uploads above R2's single-PUT limit before issuing a session", async () => {
    const response = await request("/api/uploads", {
      method: "POST",
      headers: { ...bearer("write-secret"), "Content-Type": "application/json" },
      body: JSON.stringify({ key: "nar/too-large.nar", size: 5 * 1024 * 1024 * 1024 + 1, sha256: "0".repeat(64) }),
    });
    expect(response.response.status).toBe(422);
  });

  it("rejects a final object that was created outside a session", async () => {
    await testEnv.CACHE_BUCKET.put("nar/unowned.nar", "wrong");
    const response = await request("/api/uploads", {
      method: "POST",
      headers: { ...bearer("write-secret"), "Content-Type": "application/json" },
      body: JSON.stringify({ key: "nar/unowned.nar", size: 5, sha256: "0".repeat(64) }),
    });
    expect(response.response.status).toBe(409);
  });

  it("expires abandoned sessions and removes their staging objects", async () => {
    const sessionId = "00000000-0000-4000-8000-000000000098";
    const stagingKey = `_nix_uploads/${sessionId}`;
    const expiredAt = new Date(Date.now() - 60_000).toISOString();
    await testEnv.DB.prepare(
      `INSERT INTO upload_sessions
       (id, r2_key, staging_key, kind, expected_size, expected_sha256, status, created_at, expires_at, updated_at)
       VALUES (?, ?, ?, 'nar', 5, ?, 'issued', ?, ?, ?)`,
    ).bind(
      sessionId,
      "nar/expired.nar",
      stagingKey,
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      expiredAt,
      expiredAt,
      expiredAt,
    ).run();
    await testEnv.CACHE_BUCKET.put(stagingKey, "hello");

    await cleanupUploadSessions(testEnv, 100);

    expect(await testEnv.CACHE_BUCKET.head(stagingKey)).toBeNull();
    expect(await testEnv.DB.prepare("SELECT id FROM upload_sessions WHERE id = ?").bind(sessionId).first()).toBeNull();
  });
});

describe("shared NAR reference protection", () => {
  it("rolls back a new narinfo reference when an existing unindexed object conflicts", async () => {
    await uploadNarObject("nar/narinfo-race.nar", "hello");
    await testEnv.CACHE_BUCKET.put("narinfo-race.narinfo", narInfoBody("nar/narinfo-race.nar", "/nix/store/existing"));
    const conflict = await request("/narinfo-race.narinfo", {
      method: "PUT",
      headers: bearer("write-secret"),
      body: narInfoBody("nar/narinfo-race.nar", "/nix/store/incoming"),
    });
    expect(conflict.response.status).toBe(409);
    expect(await testEnv.DB.prepare("SELECT narinfo_key FROM narinfo_refs WHERE narinfo_key = ?").bind("narinfo-race.narinfo").first()).not.toBeNull();
    const nar = await testEnv.DB.prepare("SELECT narinfo_ref_count FROM objects WHERE r2_key = ?").bind("nar/narinfo-race.nar").first<{ narinfo_ref_count: number }>();
    expect(nar?.narinfo_ref_count).toBe(1);
    await testEnv.CACHE_BUCKET.delete("narinfo-race.narinfo");
    await testEnv.DB.prepare("UPDATE objects SET uploaded_at = ? WHERE r2_key = ?").bind("2000-01-01T00:00:00.000Z", "narinfo-race.narinfo").run();
    await cleanupExpiredNarinfoReservations(testEnv);
    expect(await testEnv.DB.prepare("SELECT narinfo_key FROM narinfo_refs WHERE narinfo_key = ?").bind("narinfo-race.narinfo").first()).toBeNull();
    expect(await testEnv.DB.prepare("SELECT r2_key FROM objects WHERE r2_key = ?").bind("narinfo-race.narinfo").first()).toBeNull();
    const cleaned = await testEnv.DB.prepare("SELECT narinfo_ref_count FROM objects WHERE r2_key = ?").bind("nar/narinfo-race.nar").first<{ narinfo_ref_count: number }>();
    expect(cleaned?.narinfo_ref_count).toBe(0);
  });

  it("does not retain a pending narinfo row when its NAR dependency is absent", async () => {
    const missing = await request("/missing-dependency.narinfo", {
      method: "PUT",
      headers: bearer("write-secret"),
      body: narInfoBody("nar/not-indexed.nar", "/nix/store/missing-dependency"),
    });
    expect(missing.response.status).toBe(424);
    expect(await testEnv.DB.prepare("SELECT r2_key FROM objects WHERE r2_key = ?").bind("missing-dependency.narinfo").first()).toBeNull();
  });

  it("leaves conflicting final R2 bytes unindexed when reconciling an expired reservation", async () => {
    await uploadNarObject("nar/cleanup-expected.nar", "hello");
    await testEnv.CACHE_BUCKET.put("cleanup-mismatch.narinfo", narInfoBody("nar/unrelated.nar", "/nix/store/unrelated"));
    const conflict = await request("/cleanup-mismatch.narinfo", {
      method: "PUT",
      headers: bearer("write-secret"),
      body: narInfoBody("nar/cleanup-expected.nar", "/nix/store/cleanup-expected"),
    });
    expect(conflict.response.status).toBe(409);
    await testEnv.DB.prepare("UPDATE objects SET uploaded_at = ? WHERE r2_key = ?").bind("2000-01-01T00:00:00.000Z", "cleanup-mismatch.narinfo").run();
    await cleanupExpiredNarinfoReservations(testEnv);
    expect(await testEnv.CACHE_BUCKET.head("cleanup-mismatch.narinfo")).not.toBeNull();
    expect(await testEnv.DB.prepare("SELECT r2_key FROM objects WHERE r2_key = ?").bind("cleanup-mismatch.narinfo").first()).toBeNull();
    expect(await testEnv.DB.prepare("SELECT narinfo_key FROM narinfo_refs WHERE narinfo_key = ?").bind("cleanup-mismatch.narinfo").first()).toBeNull();
    const nar = await testEnv.DB.prepare("SELECT narinfo_ref_count FROM objects WHERE r2_key = ?").bind("nar/cleanup-expected.nar").first<{ narinfo_ref_count: number }>();
    expect(nar?.narinfo_ref_count).toBe(0);
  });

  it("keeps a shared NAR until its last narinfo reference is removed", async () => {
    const nar = await uploadNarObject("nar/shared.nar", "hello");
    expect(nar.response.status).toBe(201);
    const first = await uploadNarInfo("shared-one");
    const second = await uploadNarInfo("shared-two");
    const register = async (version: string, member: string) => request(`/api/packages/shared/versions/${version}`, {
      method: "PUT",
      headers: { ...bearer("write-secret"), "Content-Type": "application/json" },
      body: JSON.stringify({ narinfoKeys: [member] }),
    });
    expect((await register("one", first)).response.status).toBe(201);
    expect((await register("two", second)).response.status).toBe(201);
    const sessionId = "00000000-0000-4000-8000-000000000099";
    await testEnv.DB.prepare(
      `INSERT INTO upload_sessions
       (id, r2_key, staging_key, kind, expected_size, expected_sha256, status, created_at, expires_at, updated_at)
       VALUES (?, ?, ?, 'nar', 5, ?, 'issued', ?, ?, ?)`,
    ).bind(
      sessionId,
      "nar/shared.nar",
      `_nix_uploads/${sessionId}`,
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      new Date().toISOString(),
      new Date(Date.now() + 60 * 60_000).toISOString(),
      new Date().toISOString(),
    ).run();
    await testEnv.CACHE_BUCKET.put(`_nix_uploads/${sessionId}`, "hello");
    const counts = await testEnv.DB.prepare("SELECT narinfo_ref_count, version_member_count FROM objects WHERE r2_key IN (?, ?, ?) ORDER BY r2_key")
      .bind("nar/shared.nar", first, second).all<{ narinfo_ref_count: number; version_member_count: number }>();
    expect(counts.results.find((row) => row.narinfo_ref_count === 2)).toBeTruthy();

    const deletion = await request("/api/admin/packages/shared/versions/one", {
      method: "DELETE",
      headers: { ...bearer("admin-secret"), "Content-Type": "application/json" },
      body: JSON.stringify({ confirmPackageName: "shared", confirmVersionName: "one", reason: "test" }),
    });
    expect(deletion.response.status).toBe(202);
    await Promise.all(deletion.waitUntil);
    expect(await testEnv.CACHE_BUCKET.head("nar/shared.nar")).not.toBeNull();
    const ref = await testEnv.DB.prepare("SELECT narinfo_ref_count FROM objects WHERE r2_key = ?").bind("nar/shared.nar").first<{ narinfo_ref_count: number }>();
    expect(ref?.narinfo_ref_count).toBe(1);

    const finalDeletion = await request("/api/admin/packages/shared/versions/two", {
      method: "DELETE",
      headers: { ...bearer("admin-secret"), "Content-Type": "application/json" },
      body: JSON.stringify({ confirmPackageName: "shared", confirmVersionName: "two", reason: "test" }),
    });
    expect(finalDeletion.response.status).toBe(202);
    await Promise.all(finalDeletion.waitUntil);
    expect(await testEnv.CACHE_BUCKET.head("nar/shared.nar")).toBeNull();
    expect(await testEnv.DB.prepare("SELECT r2_key FROM objects WHERE r2_key = ?").bind("nar/shared.nar").first()).toBeNull();
    const revoked = await testEnv.DB.prepare("SELECT status FROM upload_sessions WHERE id = ?").bind(sessionId).first<{ status: string }>();
    expect(revoked?.status).toBe("revoked");
  });
});

describe("static pages", () => {
  it("renders the public cache setup page", async () => {
    const response = homePage("", "https://cache.test");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("cache.nixos.org");
  });
});
