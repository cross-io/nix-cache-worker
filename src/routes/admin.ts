import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { AppError } from "../domain/errors";
import {
  effectiveRetentionDays,
  groupKey,
  isRetentionField,
  isRetentionOperator,
  matchingPolicies,
  policyConditions,
  policyGroupBy,
  type PolicyRow,
  type RetentionCondition,
  type RetentionField,
  type RetentionOperator,
} from "../domain/policy";
import { emitAudit } from "../observability";
import { getJob, createDeletionJob, findActiveDeletionJob, runQueuedJobs, scheduleGcJob, runJob } from "../jobs/jobs";
import { getVersion, now, parseTags, type VersionRow } from "../storage/db";
import { serializeVersion, validateNonNegativeInteger, validatePackageName, validateTags, validateVersionName } from "./versions";
import { requireRole } from "../middleware/auth";

export const adminRoutes = new Hono<AppEnv>();
adminRoutes.use("/api/admin/*", requireRole("admin"));

type FileRow = {
  kind: "nar" | "narinfo";
  key: string;
  size: number | null;
  state: string | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const SECOND_MS = 1000;

function remainingRetentionDays(row: VersionRow, durationDays: number): number {
  const expiresAt = Date.parse(row.registered_at) + durationDays * DAY_MS;
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / DAY_MS));
}

function remainingRetentionSeconds(row: VersionRow, durationDays: number): number {
  const remaining = (Date.parse(row.registered_at) + durationDays * DAY_MS - Date.now()) / SECOND_MS;
  return remaining < 0 ? Math.floor(remaining) : Math.ceil(remaining);
}

async function loadPolicies(env: AppEnv["Bindings"]): Promise<PolicyRow[]> {
  const result = await env.DB.prepare("SELECT * FROM gc_policies ORDER BY id").all<PolicyRow>();
  return result.results;
}

async function loadVersionsForPackage(env: AppEnv["Bindings"], packageName: string): Promise<VersionRow[]> {
  const result = await env.DB.prepare(
    "SELECT * FROM artifact_versions WHERE package_name = ? AND state != 'deleted' ORDER BY registered_at DESC, version_id DESC",
  ).bind(packageName).all<VersionRow>();
  return result.results;
}

async function loadVersionsForPackages(env: AppEnv["Bindings"], packageNames: string[]): Promise<VersionRow[]> {
  if (!packageNames.length) return [];
  const placeholders = packageNames.map(() => "?").join(",");
  const result = await env.DB.prepare(
    `SELECT * FROM artifact_versions
     WHERE state != 'deleted' AND package_name IN (${placeholders})
     ORDER BY package_name, registered_at DESC, version_id DESC`,
  ).bind(...packageNames).all<VersionRow>();
  return result.results;
}

async function listPackageNames(env: AppEnv["Bindings"], query: string, limit: number, offset: number): Promise<{ names: string[]; total: number }> {
  const escapedQuery = query.replace(/[!%_]/g, (character) => `!${character}`);
  const pattern = `%${escapedQuery}%`;
  const where = `state != 'deleted' AND (
    package_name COLLATE NOCASE LIKE ? ESCAPE '!' OR version_name COLLATE NOCASE LIKE ? ESCAPE '!' OR tags_json COLLATE NOCASE LIKE ? ESCAPE '!'
  )`;
  const [total, names] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(DISTINCT package_name) AS count FROM artifact_versions WHERE ${where}`)
      .bind(pattern, pattern, pattern).first<{ count: number }>(),
    env.DB.prepare(`SELECT DISTINCT package_name FROM artifact_versions WHERE ${where} ORDER BY package_name LIMIT ? OFFSET ?`)
      .bind(pattern, pattern, pattern, limit, offset).all<{ package_name: string }>(),
  ]);
  return { names: names.results.map((row) => row.package_name), total: Number(total?.count ?? 0) };
}

async function fallbackRetention(env: AppEnv["Bindings"]): Promise<number> {
  const value = Number(env.DEFAULT_RETENTION_DAYS ?? "7");
  return Number.isSafeInteger(value) && value >= 0 ? value : 7;
}

async function getVersionFiles(env: AppEnv["Bindings"], versionId: string): Promise<FileRow[]> {
  const result = await env.DB.prepare(
    `SELECT m.narinfo_key, r.nar_key,
            ni.size AS narinfo_size, ni.state AS narinfo_state,
            n.size AS nar_size, n.state AS nar_state
     FROM artifact_version_members m
     JOIN narinfo_refs r ON r.narinfo_key = m.narinfo_key
     LEFT JOIN objects ni ON ni.r2_key = m.narinfo_key
     LEFT JOIN objects n ON n.r2_key = r.nar_key
     WHERE m.version_id = ? ORDER BY m.narinfo_key`,
  ).bind(versionId).all<{
    narinfo_key: string;
    nar_key: string;
    narinfo_size: number | null;
    narinfo_state: string | null;
    nar_size: number | null;
    nar_state: string | null;
  }>();
  const files = new Map<string, FileRow>();
  for (const row of result.results) {
    if (!files.has(row.narinfo_key)) files.set(row.narinfo_key, { kind: "narinfo", key: row.narinfo_key, size: row.narinfo_size, state: row.narinfo_state });
    if (!files.has(row.nar_key)) files.set(row.nar_key, { kind: "nar", key: row.nar_key, size: row.nar_size, state: row.nar_state });
  }
  return [...files.values()].sort((left, right) => left.key.localeCompare(right.key));
}

async function versionSummary(
  env: AppEnv["Bindings"],
  row: VersionRow,
  protectedIds: Set<string>,
  capacityExceededIds: Set<string>,
  policies: PolicyRow[],
  fallback: number,
  includeFiles = false,
): Promise<Record<string, unknown>> {
  const files = await getVersionFiles(env, row.version_id);
  const bytes = files.reduce((sum, file) => sum + (file.size ?? 0), 0);
  const protectedByKeepLatest = protectedIds.has(row.version_id);
  const retentionDays = effectiveRetentionDays(row, policies, fallback);
  const isPersistent = row.pinned || protectedByKeepLatest;
  const capacityExceeded = !isPersistent && capacityExceededIds.has(row.version_id);
  const result: Record<string, unknown> = {
    ...serializeVersion(row),
    fileCount: files.length,
    bytes,
    effectiveRetentionDays: retentionDays,
    protectedByKeepLatest,
    capacityExceeded,
    retentionState: isPersistent ? "persistent" : `${retentionDays} days`,
    retentionRemainingDays: isPersistent ? null : remainingRetentionDays(row, retentionDays),
    retentionRemainingSeconds: isPersistent ? null : remainingRetentionSeconds(row, retentionDays),
  };
  if (includeFiles) result.files = files;
  return result;
}

async function protectedVersionIdsForRows(env: AppEnv["Bindings"], rows: VersionRow[], policies: PolicyRow[]): Promise<Set<string>> {
  const targets = new Map<string, number>();
  for (const row of rows) {
    for (const policy of matchingPolicies(row, policies)) {
      const fields = policyGroupBy(policy);
      const count = policy.last_n ?? 0;
      if (!fields || count <= 0) continue;
      targets.set(`${policy.id}:${groupKey(row, fields)}`, count);
    }
  }
  if (!targets.size) return new Set();
  const latest = new Map<string, Array<{ versionId: string; registeredAt: string }>>();
  let lastVersionId = "";
  while (true) {
    const page = await env.DB.prepare(
      `SELECT * FROM artifact_versions WHERE state = 'active' AND version_id > ? ORDER BY version_id LIMIT 200`,
    ).bind(lastVersionId).all<VersionRow>();
    for (const candidate of page.results) {
      for (const policy of matchingPolicies(candidate, policies)) {
        const fields = policyGroupBy(policy);
        if (!fields) continue;
        const targetKey = `${policy.id}:${groupKey(candidate, fields)}`;
        const target = targets.get(targetKey);
        if (!target) continue;
        const list = latest.get(targetKey) ?? [];
        const item = { versionId: candidate.version_id, registeredAt: candidate.registered_at };
        if (list.length < target) {
          list.push(item);
          if (list.length === target) list.sort(compareRegisteredVersions);
        } else {
          const worst = list[list.length - 1];
          if (worst && compareRegisteredVersions(item, worst) < 0) {
            list[list.length - 1] = item;
            list.sort(compareRegisteredVersions);
          }
        }
        latest.set(targetKey, list);
      }
    }
    if (page.results.length < 200) break;
    lastVersionId = page.results[page.results.length - 1].version_id;
  }
  const protectedIds = new Set<string>();
  for (const list of latest.values()) for (const item of list) protectedIds.add(item.versionId);
  return protectedIds;
}

async function capacityExceededVersionIdsForRows(env: AppEnv["Bindings"], rows: VersionRow[], policies: PolicyRow[]): Promise<Set<string>> {
  const targets = new Map<string, number>();
  for (const row of rows) {
    if (row.state !== "active") continue;
    for (const policy of matchingPolicies(row, policies)) {
      const fields = policyGroupBy(policy);
      if (policy.capacity_versions == null || !fields) continue;
      targets.set(`${policy.id}:${groupKey(row, fields)}`, policy.capacity_versions);
    }
  }
  if (!targets.size) return new Set();

  const newest = new Map<string, Array<{ versionId: string; registeredAt: string }>>();
  let lastVersionId = "";
  while (true) {
    const page = await env.DB.prepare(
      `SELECT * FROM artifact_versions WHERE state = 'active' AND version_id > ? ORDER BY version_id LIMIT 200`,
    ).bind(lastVersionId).all<VersionRow>();
    for (const candidate of page.results) {
      for (const policy of matchingPolicies(candidate, policies)) {
        const fields = policyGroupBy(policy);
        if (!fields || policy.capacity_versions == null) continue;
        const targetKey = `${policy.id}:${groupKey(candidate, fields)}`;
        const capacity = targets.get(targetKey);
        if (capacity === undefined || capacity <= 0) continue;
        const list = newest.get(targetKey) ?? [];
        const item = { versionId: candidate.version_id, registeredAt: candidate.registered_at };
        if (list.length < capacity) {
          list.push(item);
          if (list.length === capacity) list.sort(compareRegisteredVersions);
        } else {
          const worst = list[list.length - 1];
          if (worst && compareRegisteredVersions(item, worst) < 0) {
            list[list.length - 1] = item;
            list.sort(compareRegisteredVersions);
          }
        }
        newest.set(targetKey, list);
      }
    }
    if (page.results.length < 200) break;
    lastVersionId = page.results[page.results.length - 1].version_id;
  }

  const keptByTarget = new Map<string, Set<string>>();
  for (const [targetKey, list] of newest) {
    keptByTarget.set(targetKey, new Set(list.map((item) => item.versionId)));
  }
  const exceededIds = new Set<string>();
  for (const row of rows) {
    if (row.state !== "active") continue;
    for (const policy of matchingPolicies(row, policies)) {
      const fields = policyGroupBy(policy);
      if (policy.capacity_versions == null || !fields) continue;
      const targetKey = `${policy.id}:${groupKey(row, fields)}`;
      if (targets.has(targetKey) && !keptByTarget.get(targetKey)?.has(row.version_id)) {
        exceededIds.add(row.version_id);
        break;
      }
    }
  }
  return exceededIds;
}

function packageItems(versions: VersionRow[], query: string): Map<string, VersionRow[]> {
  const groups = new Map<string, VersionRow[]>();
  for (const row of versions) {
    const tags = parseTags(row.tags_json);
    const haystack = `${row.package_name} ${row.version_name} ${row.tags_json} ${JSON.stringify(tags)}`.toLowerCase();
    if (query && !haystack.includes(query)) continue;
    const group = groups.get(row.package_name) ?? [];
    group.push(row);
    groups.set(row.package_name, group);
  }
  return groups;
}

function compareRegisteredVersions(left: { versionId: string; registeredAt: string }, right: { versionId: string; registeredAt: string }): number {
  return right.registeredAt.localeCompare(left.registeredAt) || right.versionId.localeCompare(left.versionId);
}

async function packageResponse(
  env: AppEnv["Bindings"],
  packageName: string,
  rows: VersionRow[],
  policies: PolicyRow[],
  fallback: number,
  protectedIds?: Set<string>,
  capacityExceededIds?: Set<string>,
): Promise<Record<string, unknown>> {
  const effectiveProtectedIds = protectedIds ?? await protectedVersionIdsForRows(env, rows, policies);
  const effectiveCapacityExceededIds = capacityExceededIds ?? await capacityExceededVersionIdsForRows(env, rows, policies);
  const versions = await Promise.all(rows.map((row) => versionSummary(env, row, effectiveProtectedIds, effectiveCapacityExceededIds, policies, fallback)));
  return {
    packageName,
    versionCount: versions.length,
    pinnedVersionCount: versions.filter((version) => version.pinned).length,
    bytes: versions.reduce((sum, version) => sum + Number(version.bytes ?? 0), 0),
    versions,
  };
}

adminRoutes.get("/api/admin/overview", async (c) => {
  const defaultRetentionDays = await fallbackRetention(c.env);
  const [versions, objects, unclassified] = await Promise.all([
    c.env.DB.prepare(
      `SELECT COUNT(*) AS version_count,
              COUNT(DISTINCT package_name) AS package_count,
              COALESCE(SUM(pinned), 0) AS pinned_count
       FROM artifact_versions WHERE state = 'active'`,
    ).first<{ version_count: number; package_count: number; pinned_count: number }>(),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS object_count, COALESCE(SUM(size), 0) AS bytes,
              COALESCE(SUM(CASE WHEN kind = 'narinfo' THEN 1 ELSE 0 END), 0) AS narinfo_count,
              COALESCE(SUM(CASE WHEN kind = 'nar' THEN 1 ELSE 0 END), 0) AS nar_count
       FROM objects WHERE state = 'ready'`,
    ).first<{ object_count: number; bytes: number; narinfo_count: number; nar_count: number }>(),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS object_count, COALESCE(SUM(o.size), 0) AS bytes
       FROM objects o
       WHERE o.state = 'ready'
         AND NOT EXISTS (
           SELECT 1 FROM artifact_version_members m
           JOIN artifact_versions v ON v.version_id = m.version_id
           WHERE v.state = 'active'
             AND (m.narinfo_key = o.r2_key
               OR m.narinfo_key IN (SELECT r.narinfo_key FROM narinfo_refs r WHERE r.nar_key = o.r2_key))
         )`,
    ).first<{ object_count: number; bytes: number }>(),
  ]);
  return c.json({
    packages: Number(versions?.package_count ?? 0),
    versions: Number(versions?.version_count ?? 0),
    pinnedVersions: Number(versions?.pinned_count ?? 0),
    cacheObjects: Number(objects?.object_count ?? 0),
    narinfos: Number(objects?.narinfo_count ?? 0),
    nars: Number(objects?.nar_count ?? 0),
    indexedBytes: Number(objects?.bytes ?? 0),
    unclassifiedObjects: Number(unclassified?.object_count ?? 0),
    unclassifiedBytes: Number(unclassified?.bytes ?? 0),
    defaultRetentionDays,
  });
});

adminRoutes.get("/api/admin/packages", async (c) => {
  const query = c.req.query("q")?.toLowerCase() ?? "";
  const requestedLimit = Number(c.req.query("limit") ?? "50");
  const requestedOffset = Number(c.req.query("offset") ?? "0");
  const limit = Number.isSafeInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 50;
  const offset = Number.isSafeInteger(requestedOffset) ? Math.max(requestedOffset, 0) : 0;
  const [{ names: selectedNames, total }, policies, fallback] = await Promise.all([
    listPackageNames(c.env, query, limit, offset),
    loadPolicies(c.env),
    fallbackRetention(c.env),
  ]);
  const versions = await loadVersionsForPackages(c.env, selectedNames);
  const groups = packageItems(versions, query);
  const protectedIds = await protectedVersionIdsForRows(c.env, versions, policies);
  const capacityExceededIds = await capacityExceededVersionIdsForRows(c.env, versions, policies);
  return c.json({
    items: await Promise.all(selectedNames.map((packageName) => packageResponse(c.env, packageName, groups.get(packageName) ?? [], policies, fallback, protectedIds, capacityExceededIds))),
    total,
    offset,
    limit,
  });
});

adminRoutes.get("/api/admin/packages/:packageName/versions/:versionName", async (c) => {
  const packageName = validatePackageName(c.req.param("packageName"));
  const versionName = validateVersionName(c.req.param("versionName"));
  const row = await getVersion(c.env, packageName, versionName);
  if (!row || row.state === "deleted") throw new AppError("not_found", "The version was not found", 404);
  const [policies, fallback] = await Promise.all([loadPolicies(c.env), fallbackRetention(c.env)]);
  const protectedIds = await protectedVersionIdsForRows(c.env, [row], policies);
  const capacityExceededIds = await capacityExceededVersionIdsForRows(c.env, [row], policies);
  return c.json(await versionSummary(c.env, row, protectedIds, capacityExceededIds, policies, fallback, true));
});

adminRoutes.get("/api/admin/packages/:packageName", async (c) => {
  const packageName = validatePackageName(c.req.param("packageName"));
  const [rows, policies, fallback] = await Promise.all([loadVersionsForPackage(c.env, packageName), loadPolicies(c.env), fallbackRetention(c.env)]);
  if (!rows.length) throw new AppError("not_found", "The package was not found", 404);
  const protectedIds = await protectedVersionIdsForRows(c.env, rows, policies);
  const capacityExceededIds = await capacityExceededVersionIdsForRows(c.env, rows, policies);
  return c.json(await packageResponse(c.env, packageName, rows, policies, fallback, protectedIds, capacityExceededIds));
});

adminRoutes.patch("/api/admin/packages/:packageName/versions/:versionName", async (c) => {
  const packageName = validatePackageName(c.req.param("packageName"));
  const versionName = validateVersionName(c.req.param("versionName"));
  const row = await getVersion(c.env, packageName, versionName);
  if (!row || row.state === "deleted") throw new AppError("not_found", "The version was not found", 404);
  if (row.state === "deleting") throw new AppError("version_deleting", "The version is currently being deleted", 409);
  const body = await c.req.json<Record<string, unknown>>().catch(() => { throw new AppError("invalid_json", "The request body must be JSON", 400); });
  const tags = body.tags === undefined ? parseTags(row.tags_json) : validateTags(body.tags);
  const retentionDays = body.retentionDays === undefined ? row.retention_days : validateNonNegativeInteger(body.retentionDays, "retention_days");
  const updateResult = await c.env.DB.prepare("UPDATE artifact_versions SET tags_json = ?, retention_days = ?, updated_at = ? WHERE version_id = ? AND state = 'active'")
    .bind(JSON.stringify(tags), retentionDays, now(), row.version_id).run();
  if (updateResult.meta.changes !== 1) {
    const current = await getVersion(c.env, packageName, versionName);
    if (current?.state === "deleting") throw new AppError("version_deleting", "The version is currently being deleted", 409);
    throw new AppError("version_busy", "The version changed before the update could be applied", 409, { state: current?.state ?? "missing" });
  }
  await emitAudit(c.env, "version_update", c.get("role"), `${packageName}/${versionName}`, { versionId: row.version_id, tags, retentionDays });
  const updated = await getVersion(c.env, packageName, versionName);
  if (!updated) throw new AppError("not_found", "The version was not found", 404);
  const [policies, fallback] = await Promise.all([loadPolicies(c.env), fallbackRetention(c.env)]);
  const protectedIds = await protectedVersionIdsForRows(c.env, [updated], policies);
  const capacityExceededIds = await capacityExceededVersionIdsForRows(c.env, [updated], policies);
  return c.json(await versionSummary(c.env, updated, protectedIds, capacityExceededIds, policies, fallback));
});

async function setPin(c: Context<AppEnv>, pinned: boolean): Promise<Response> {
  const packageName = validatePackageName(c.req.param("packageName") ?? "");
  const versionName = validateVersionName(c.req.param("versionName") ?? "");
  const row = await getVersion(c.env, packageName, versionName);
  if (!row || row.state === "deleted") throw new AppError("not_found", "The version was not found", 404);
  if (row.state === "deleting") throw new AppError("version_deleting", "The version is currently being deleted", 409);
  const updated = await c.env.DB.prepare("UPDATE artifact_versions SET pinned = ?, updated_at = ? WHERE version_id = ? AND state = 'active'").bind(pinned ? 1 : 0, now(), row.version_id).run();
  if (updated.meta.changes !== 1) {
    const current = await getVersion(c.env, packageName, versionName);
    if (current?.state === "deleting") throw new AppError("version_deleting", "The version is currently being deleted", 409);
    throw new AppError("version_busy", "The version changed before the pin state could be updated", 409, { state: current?.state ?? "missing" });
  }
  await emitAudit(c.env, pinned ? "version_pin" : "version_unpin", c.get("role"), `${packageName}/${versionName}`, { versionId: row.version_id });
  return c.json({ versionId: row.version_id, packageName, versionName, pinned });
}

adminRoutes.put("/api/admin/packages/:packageName/versions/:versionName/pin", async (c) => setPin(c, true));
adminRoutes.delete("/api/admin/packages/:packageName/versions/:versionName/pin", async (c) => setPin(c, false));

adminRoutes.delete("/api/admin/packages/:packageName/versions/:versionName", async (c) => {
  const packageName = validatePackageName(c.req.param("packageName"));
  const versionName = validateVersionName(c.req.param("versionName"));
  const body = await c.req.json<{ confirmPackageName?: string; confirmVersionName?: string; reason?: string }>().catch(() => { throw new AppError("invalid_json", "The request body must be JSON", 400); });
  if (body.confirmPackageName !== packageName || body.confirmVersionName !== versionName) {
    throw new AppError("confirmation_required", "confirmPackageName and confirmVersionName must match the target", 422);
  }
  if (typeof body.reason !== "string" || !body.reason.trim() || body.reason.length > 512) throw new AppError("reason_required", "A deletion reason is required", 422);
  const row = await getVersion(c.env, packageName, versionName);
  if (!row || row.state === "deleted") throw new AppError("not_found", "The version was not found", 404);
  const existingJob = await findActiveDeletionJob(c.env, row.version_id);
  if (existingJob) {
    await c.env.DB.prepare("UPDATE artifact_versions SET state = 'deleting', updated_at = ? WHERE version_id = ? AND state IN ('registering', 'active')")
      .bind(now(), row.version_id).run();
    c.executionCtx.waitUntil(runJob(c.env, existingJob.id));
    return c.json({ jobId: existingJob.id, status: existingJob.status, versionId: row.version_id, packageName, versionName }, 202);
  }
  const jobId = await createDeletionJob(c.env, row.version_id, c.get("role"), {
    reason: body.reason,
    packageName,
    versionName,
    pinned: Boolean(row.pinned),
    automaticGc: false,
  });
  if (!jobId) {
    const racedJob = await findActiveDeletionJob(c.env, row.version_id);
    if (!racedJob) {
      const current = await getVersion(c.env, packageName, versionName);
      if (current?.state === "deleting") throw new AppError("version_deleting", "The version is currently being deleted", 409);
      throw new AppError("version_busy", "The version changed before deletion could be locked", 409, { state: current?.state ?? "missing" });
    }
    c.executionCtx.waitUntil(runJob(c.env, racedJob.id));
    return c.json({ jobId: racedJob.id, status: racedJob.status, versionId: row.version_id, packageName, versionName }, 202);
  }
  await emitAudit(c.env, "version_delete_requested", c.get("role"), `${packageName}/${versionName}`, { versionId: row.version_id, jobId, reason: body.reason, pinned: Boolean(row.pinned) });
  c.executionCtx.waitUntil(runJob(c.env, jobId));
  return c.json({ jobId, status: "queued", versionId: row.version_id, packageName, versionName }, 202);
});

adminRoutes.get("/api/admin/jobs/:jobId", async (c) => {
  const job = await getJob(c.env, c.req.param("jobId"));
  if (!job) throw new AppError("not_found", "The job was not found", 404);
  return c.json(job);
});

adminRoutes.post("/api/admin/gc", async (c) => {
  const scheduled = await scheduleGcJob(c.env, c.get("role"), { reason: "manual" });
  await emitAudit(c.env, "gc_requested", c.get("role"), null, { jobId: scheduled.id, reused: !scheduled.created });
  c.executionCtx.waitUntil(runQueuedJobs(c.env, 4, 8));
  return c.json({ jobId: scheduled.id, status: scheduled.status, reused: !scheduled.created }, 202);
});

type PolicyPayload = {
  name: string;
  conditions: RetentionCondition[];
  groupBy: RetentionField[];
  lastN: number | null;
  durationDays: number | null;
  capacityVersions: number | null;
};

const MAX_KEEP_LATEST_VERSIONS = 100_000;
const MAX_RETENTION_DAYS = 36_500;

function validatePolicyBody(body: Record<string, unknown>): PolicyPayload {
  const name = typeof body.name === "string" ? body.name : "";
  if (!/^[A-Za-z0-9._~-]{1,64}$/.test(name)) throw new AppError("invalid_policy", "Policy name is invalid", 422);
  const rawConditions = body.conditions ?? [];
  if (!Array.isArray(rawConditions) || rawConditions.length > 32) throw new AppError("invalid_policy", "conditions must contain at most 32 items", 422);
  const conditions: RetentionCondition[] = [];
  for (const item of rawConditions) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new AppError("invalid_policy", "A condition must be an object", 422);
    const condition = item as Record<string, unknown>;
    if (typeof condition.field !== "string" || !isRetentionField(condition.field)) throw new AppError("invalid_policy", "A condition field is invalid", 422);
    if (typeof condition.operator !== "string" || !isRetentionOperator(condition.operator)) throw new AppError("invalid_policy", "A condition operator is invalid", 422);
    if (typeof condition.value !== "string" || condition.value.length > 256) throw new AppError("invalid_policy", "A condition value is invalid", 422);
    if (condition.negate !== undefined && typeof condition.negate !== "boolean") throw new AppError("invalid_policy", "A condition negate flag is invalid", 422);
    conditions.push({ field: condition.field, operator: condition.operator, value: condition.value, negate: condition.negate === true });
  }

  const rawGroupBy = body.groupBy ?? [];
  if (!Array.isArray(rawGroupBy) || rawGroupBy.length > 16 || rawGroupBy.some((field) => typeof field !== "string" || !isRetentionField(field))) {
    throw new AppError("invalid_policy", "groupBy contains an invalid field", 422);
  }
  const groupBy = [...new Set(rawGroupBy as string[])] as RetentionField[];

  const parse = (value: unknown, field: string, maximum: number, unit: string): number | null => {
    if (value === null || value === undefined) return null;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
      throw new AppError("invalid_policy", `${field} must be a non-negative integer no greater than ${maximum} ${unit}`, 422);
    }
    return value;
  };
  const lastN = parse(body.lastN, "lastN", MAX_KEEP_LATEST_VERSIONS, "versions");
  const durationDays = parse(body.durationDays, "durationDays", MAX_RETENTION_DAYS, "days");
  const capacityVersions = parse(body.capacityVersions, "capacityVersions", MAX_KEEP_LATEST_VERSIONS, "versions");
  if (lastN === null && durationDays === null && capacityVersions === null) {
    throw new AppError("invalid_policy", "Set lastN, durationDays, capacityVersions, or at least one action", 422);
  }
  return { name, conditions, groupBy, lastN, durationDays, capacityVersions };
}

function serializePolicy(row: PolicyRow): Record<string, unknown> {
  const conditions = policyConditions(row) ?? [];
  const groupBy = policyGroupBy(row) ?? [];
  return {
    id: row.id,
    name: row.name,
    conditions,
    groupBy,
    lastN: row.last_n,
    durationDays: row.duration_days,
    capacityVersions: row.capacity_versions,
  };
}

adminRoutes.get("/api/admin/policies", async (c) => {
  const result = await c.env.DB.prepare("SELECT * FROM gc_policies ORDER BY id").all<PolicyRow>();
  return c.json({ items: result.results.map(serializePolicy) });
});

adminRoutes.post("/api/admin/policies", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => { throw new AppError("invalid_json", "The request body must be JSON", 400); });
  const policy = validatePolicyBody(body);
  const timestamp = now();
  const result = await c.env.DB.prepare(
    "INSERT INTO gc_policies (name, conditions_json, group_by_json, last_n, duration_days, capacity_versions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(policy.name, JSON.stringify(policy.conditions), JSON.stringify(policy.groupBy), policy.lastN, policy.durationDays, policy.capacityVersions, timestamp, timestamp).run();
  await emitAudit(c.env, "policy_create", c.get("role"), policy.name);
  return c.json({ id: result.meta.last_row_id, ...policy }, 201);
});

adminRoutes.put("/api/admin/policies/:policyId", async (c) => {
  const id = Number(c.req.param("policyId"));
  if (!Number.isSafeInteger(id)) throw new AppError("invalid_policy", "Policy ID is invalid", 422);
  const body = await c.req.json<Record<string, unknown>>().catch(() => { throw new AppError("invalid_json", "The request body must be JSON", 400); });
  const policy = validatePolicyBody(body);
  const result = await c.env.DB.prepare(
    "UPDATE gc_policies SET name = ?, conditions_json = ?, group_by_json = ?, last_n = ?, duration_days = ?, capacity_versions = ?, updated_at = ? WHERE id = ?",
  ).bind(policy.name, JSON.stringify(policy.conditions), JSON.stringify(policy.groupBy), policy.lastN, policy.durationDays, policy.capacityVersions, now(), id).run();
  if (result.meta.changes === 0) throw new AppError("not_found", "The policy was not found", 404);
  await emitAudit(c.env, "policy_update", c.get("role"), String(id));
  return c.json({ id, ...policy });
});

adminRoutes.delete("/api/admin/policies/:policyId", async (c) => {
  const id = Number(c.req.param("policyId"));
  if (!Number.isSafeInteger(id)) throw new AppError("invalid_policy", "Policy ID is invalid", 422);
  const result = await c.env.DB.prepare("DELETE FROM gc_policies WHERE id = ?").bind(id).run();
  if (result.meta.changes === 0) throw new AppError("not_found", "The policy was not found", 404);
  await emitAudit(c.env, "policy_delete", c.get("role"), String(id));
  return c.body(null, 204);
});
