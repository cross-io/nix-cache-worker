import { Hono } from "hono";
import type { AppEnv, Bindings } from "../env";
import { AppError } from "../domain/errors";
import { emitAudit } from "../observability";
import { getVersion, now, parseTags, type VersionRow } from "../storage/db";
import { requireRole } from "../middleware/auth";

export const versionRoutes = new Hono<AppEnv>();

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;

export function validatePackageName(value: string): string {
  if (!NAME_PATTERN.test(value)) {
    throw new AppError("invalid_package_name", "packageName must be a URL-safe single path segment", 422);
  }
  return value;
}

export function validateVersionName(value: string): string {
  if (!NAME_PATTERN.test(value)) {
    throw new AppError("invalid_version_name", "versionName must be a URL-safe single path segment", 422);
  }
  return value;
}

export function validateTags(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError("invalid_tags", "tags must be an object", 422);
  const entries = Object.entries(value);
  if (entries.length > 64) throw new AppError("invalid_tags", "A version may contain at most 64 tags", 422);
  const tags: Record<string, string> = {};
  for (const [key, tagValue] of entries) {
    if (!/^[A-Za-z0-9._~-]{1,64}$/.test(key) || typeof tagValue !== "string" || tagValue.length > 256) {
      throw new AppError("invalid_tags", "Tag keys and values have invalid lengths or characters", 422);
    }
    tags[key] = tagValue;
  }
  return tags;
}

export function validateNonNegativeInteger(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new AppError(`invalid_${field}`, `${field} must be a non-negative integer`, 422);
  if (field === "retention_days" && Number(value) > 36_500) throw new AppError(`invalid_${field}`, `${field} must not exceed 36500 days`, 422);
  return Number(value);
}

async function assertMembers(env: AppEnv["Bindings"], values: unknown): Promise<string[]> {
  if (!Array.isArray(values) || values.length === 0 || values.length > 10_000 || values.some((value) => typeof value !== "string")) {
    throw new AppError("invalid_members", "narinfoKeys must contain between 1 and 10000 strings", 422);
  }
  const keys = [...new Set(values as string[])];
  for (const key of keys) {
    if (!/^[A-Za-z0-9._~-]+\.narinfo$/.test(key)) throw new AppError("invalid_members", `Invalid narinfo key: ${key}`, 422);
  }
  const ready = new Set<string>();
  for (let offset = 0; offset < keys.length; offset += 100) {
    const chunk = keys.slice(offset, offset + 100);
    const placeholders = chunk.map(() => "?").join(",");
    const result = await env.DB.prepare(
      `SELECT ni.r2_key AS narinfo_key
       FROM objects ni
       JOIN narinfo_refs r ON r.narinfo_key = ni.r2_key
       JOIN objects n ON n.r2_key = r.nar_key
       WHERE ni.r2_key IN (${placeholders})
         AND ni.kind = 'narinfo' AND ni.state = 'ready'
         AND n.kind = 'nar' AND n.state = 'ready'`,
    ).bind(...chunk).all<{ narinfo_key: string }>();
    for (const row of result.results) ready.add(row.narinfo_key);
  }
  for (const key of keys) {
    if (!ready.has(key)) throw new AppError("missing_narinfo", `The narinfo is not indexed: ${key}`, 424);
  }
  return keys;
}

export function serializeVersion(row: VersionRow): Record<string, unknown> {
  return {
    versionId: row.version_id,
    packageName: row.package_name,
    versionName: row.version_name,
    tags: parseTags(row.tags_json),
    retentionDays: row.retention_days,
    pinned: Boolean(row.pinned),
    registeredAt: row.registered_at,
    updatedAt: row.updated_at,
    state: row.state,
  };
}

versionRoutes.put("/api/packages/:packageName/versions/:versionName", requireRole("write"), async (c) => {
  const packageName = validatePackageName(c.req.param("packageName"));
  const versionName = validateVersionName(c.req.param("versionName"));
  const body = await c.req.json<Record<string, unknown>>().catch(() => { throw new AppError("invalid_json", "The request body must be JSON", 400); });
  const members = await assertMembers(c.env, body.narinfoKeys);
  const tags = validateTags(body.tags);
  const retentionDays = validateNonNegativeInteger(body.retentionDays, "retention_days");
  const timestamp = now();
  const existing = await getVersion(c.env, packageName, versionName);
  if (existing?.state === "deleting") throw new AppError("version_deleting", "The version is currently being deleted", 409);
  const requestedVersionId = existing?.version_id ?? crypto.randomUUID();
  const registeredAt = timestamp;
  const registrationToken = crypto.randomUUID();
  const lockResult = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO artifact_packages (package_name, created_at, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(package_name) DO UPDATE SET updated_at = excluded.updated_at`,
    ).bind(packageName, timestamp, timestamp),
    c.env.DB.prepare(
      `INSERT INTO artifact_versions (version_id, package_name, version_name, tags_json, retention_days, pinned, registered_at, updated_at, state, registration_token)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'registering', ?)
       ON CONFLICT(package_name, version_name) DO UPDATE SET tags_json = excluded.tags_json,
         retention_days = excluded.retention_days, registered_at = excluded.registered_at,
         updated_at = excluded.updated_at, state = 'registering', registration_token = excluded.registration_token
       WHERE artifact_versions.state != 'deleting'`,
    ).bind(requestedVersionId, packageName, versionName, JSON.stringify(tags), retentionDays, existing?.pinned ?? 0, registeredAt, timestamp, registrationToken),
  ]);
  if ((lockResult[1]?.meta.changes ?? 0) !== 1) throw new AppError("version_deleting", "The version is currently being deleted", 409);
  const locked = await getVersion(c.env, packageName, versionName);
  if (!locked || locked.state !== "registering" || locked.registration_token !== registrationToken) {
    throw new AppError("version_registration_superseded", "The version registration was superseded by another request", 409);
  }
  const versionId = locked.version_id;

  try {

    await c.env.DB.prepare(
    `DELETE FROM artifact_version_pending_members
     WHERE version_id = ? AND registration_token != ? AND EXISTS (
       SELECT 1 FROM artifact_versions WHERE version_id = ? AND state = 'registering' AND registration_token = ?
     )`,
  ).bind(versionId, registrationToken, versionId, registrationToken).run();
    await c.env.DB.prepare(
      `DELETE FROM artifact_version_pending_members
       WHERE version_id = ? AND registration_token = ?`,
    ).bind(versionId, registrationToken).run();

  // Pending members carry an operation token. A concurrent registration can
  // supersede this request, but cannot interleave with its final membership
  // replacement or alter denormalized counters.
  for (let offset = 0; offset < members.length; offset += 50) {
    const statements = [];
    for (const key of members.slice(offset, offset + 50)) {
      statements.push(c.env.DB.prepare(
        `INSERT OR IGNORE INTO artifact_version_pending_members (version_id, registration_token, narinfo_key)
         SELECT ?, ?, ? WHERE EXISTS (
           SELECT 1 FROM artifact_versions
           WHERE version_id = ? AND state = 'registering' AND registration_token = ?
         ) AND EXISTS (
           SELECT 1 FROM objects ni
           JOIN narinfo_refs r ON r.narinfo_key = ni.r2_key
           JOIN objects n ON n.r2_key = r.nar_key
           WHERE ni.r2_key = ? AND ni.kind = 'narinfo' AND ni.state = 'ready'
             AND n.kind = 'nar' AND n.state = 'ready'
         )`,
      ).bind(versionId, registrationToken, key, versionId, registrationToken, key));
    }
    await c.env.DB.batch(statements);
  }
  const memberCount = await c.env.DB.prepare(
    "SELECT COUNT(*) AS count FROM artifact_version_pending_members WHERE version_id = ? AND registration_token = ?",
  ).bind(versionId, registrationToken).first<{ count: number }>();
  const current = await c.env.DB.prepare("SELECT state, registration_token FROM artifact_versions WHERE version_id = ?")
    .bind(versionId).first<{ state: string; registration_token: string | null }>();
  if (!current || current.state !== "registering" || current.registration_token !== registrationToken) {
    throw new AppError("version_registration_superseded", "The version registration was superseded by another request", 409);
  }
  if (Number(memberCount?.count ?? 0) !== members.length) {
    throw new AppError("missing_narinfo", "One or more narinfo dependencies changed while registering the version", 424);
  }

  let finalized: Awaited<ReturnType<Bindings["DB"]["batch"]>>;
  try {
    finalized = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE objects SET version_member_count = MAX(0, version_member_count - (
         SELECT COUNT(*) FROM artifact_version_members m WHERE m.version_id = ? AND m.narinfo_key = objects.r2_key
       )) WHERE kind = 'narinfo' AND r2_key IN (SELECT narinfo_key FROM artifact_version_members WHERE version_id = ?)
         AND EXISTS (SELECT 1 FROM artifact_versions WHERE version_id = ? AND state = 'registering' AND registration_token = ?)`,
    ).bind(versionId, versionId, versionId, registrationToken),
    c.env.DB.prepare(
      `DELETE FROM artifact_version_members WHERE version_id = ?
       AND EXISTS (SELECT 1 FROM artifact_versions WHERE version_id = ? AND state = 'registering' AND registration_token = ?)`,
    ).bind(versionId, versionId, registrationToken),
    c.env.DB.prepare(
      `INSERT INTO artifact_version_members (version_id, narinfo_key)
       SELECT ?, p.narinfo_key
       FROM artifact_version_pending_members p
       JOIN artifact_versions v ON v.version_id = p.version_id
         AND v.state = 'registering' AND v.registration_token = p.registration_token
       JOIN narinfo_refs r ON r.narinfo_key = p.narinfo_key
       JOIN objects ni ON ni.r2_key = p.narinfo_key AND ni.kind = 'narinfo' AND ni.state = 'ready'
       JOIN objects n ON n.r2_key = r.nar_key AND n.kind = 'nar' AND n.state = 'ready'
       WHERE p.version_id = ? AND p.registration_token = ?`,
    ).bind(versionId, versionId, registrationToken),
    c.env.DB.prepare(
      `UPDATE artifact_versions
       SET state = CASE WHEN changes() = ? THEN 'active' ELSE state END,
           registration_token = CASE WHEN changes() = ? THEN NULL ELSE registration_token END,
           updated_at = CASE WHEN changes() = ? THEN ? ELSE NULL END
       WHERE version_id = ? AND state = 'registering' AND registration_token = ?`,
    ).bind(members.length, members.length, members.length, timestamp, versionId, registrationToken),
    c.env.DB.prepare(
      `UPDATE objects SET version_member_count = version_member_count + 1
       WHERE kind = 'narinfo' AND r2_key IN (SELECT narinfo_key FROM artifact_version_members WHERE version_id = ?)
         AND EXISTS (SELECT 1 FROM artifact_versions WHERE version_id = ? AND state = 'active' AND registration_token IS NULL AND updated_at = ?)`,
    ).bind(versionId, versionId, timestamp),
    c.env.DB.prepare("DELETE FROM artifact_version_pending_members WHERE version_id = ? AND registration_token = ?").bind(versionId, registrationToken),
    ]);
  } catch {
    // The final state update deliberately violates the existing updated_at
    // NOT NULL constraint when the preceding membership INSERT did not add
    // the complete member set. D1 batches are transactional, so this rolls
    // back the replacement and preserves the previous live membership.
    throw new AppError("version_registration_failed", "The version dependencies changed before registration completed", 409);
  }
  if ((finalized[3]?.meta.changes ?? 0) !== 1) {
    throw new AppError("version_registration_failed", "The version dependencies changed before registration completed", 409);
  }
    await emitAudit(c.env, existing ? "version_update" : "version_create", c.get("role"), `${packageName}/${versionName}`, { versionId, members: members.length, tags });
    return c.json({ versionId, packageName, versionName, tags, narinfoKeys: members, retentionDays, pinned: Boolean(locked.pinned), registeredAt }, existing ? 200 : 201);
  } catch (error) {
    await c.env.DB.prepare(
      "DELETE FROM artifact_version_pending_members WHERE version_id = ? AND registration_token = ?",
    ).bind(versionId, registrationToken).run();
    throw error;
  }
});
