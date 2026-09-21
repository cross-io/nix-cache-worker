import type { Bindings } from "../env";
import { AppError } from "../domain/errors";
import {
  effectiveRetentionDays,
  groupKey,
  matchingPolicies,
  policyGroupBy,
  type PolicyRow,
} from "../domain/policy";
import { emitAudit } from "../observability";
import { now, type VersionRow } from "../storage/db";
import { claimObjectWrite, releaseObjectWrite } from "../storage/r2";
import { createDeletionJob, findActiveDeletionJob, touchJob } from "./jobs";

const MEMBER_PAGE_SIZE = 500;
const GC_PAGE_SIZE = 200;
const GC_VERSION_QUERY_BATCH_SIZE = 50;
const OBJECT_PAGE_SIZE = 100;

type MemberRow = { narinfo_key: string; nar_key: string | null };
type GcPayload = { phase?: "protect" | "evaluate"; lastVersionId?: string; policySnapshot?: PolicyRow[] };
type DeletePayload = { phase?: "members" | "objects"; automaticGc?: boolean; reason?: string };
type JobObjectRow = { object_key: string; object_kind: "nar" | "narinfo" };

async function getPolicies(env: Bindings): Promise<PolicyRow[]> {
  return (await env.DB.prepare("SELECT * FROM gc_policies ORDER BY id").all<PolicyRow>()).results;
}

function defaultRetention(env: Bindings): number {
  const value = Number(env.DEFAULT_RETENTION_DAYS ?? "7");
  return Number.isSafeInteger(value) && value >= 0 ? value : 7;
}

function parsePayload<T>(value: string, fallback: T): T {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as T : fallback;
  } catch {
    return fallback;
  }
}

async function updateJob(env: Bindings, jobId: string, payload: Record<string, unknown>, status: "queued" | "running" | "completed", cursor = 0): Promise<void> {
  await env.DB.prepare("UPDATE jobs SET status = ?, cursor = ?, payload_json = ?, updated_at = ? WHERE id = ?")
    .bind(status, cursor, JSON.stringify(payload), now(), jobId).run();
}

async function getGcPage(env: Bindings, lastVersionId: string): Promise<VersionRow[]> {
  return (await env.DB.prepare(
    `SELECT * FROM artifact_versions
     WHERE state = 'active' AND version_id > ?
     ORDER BY version_id LIMIT ?`,
  ).bind(lastVersionId, GC_PAGE_SIZE).all<VersionRow>()).results;
}

async function recordGcPage(env: Bindings, jobId: string, versions: VersionRow[], policies: PolicyRow[]): Promise<void> {
  const statements = [];
  for (const row of versions) {
    statements.push(env.DB.prepare(
      "INSERT OR REPLACE INTO gc_scan_versions (job_id, version_id, updated_at) VALUES (?, ?, ?)",
    ).bind(jobId, row.version_id, row.updated_at));
    for (const policy of matchingPolicies(row, policies)) {
      const fields = policyGroupBy(policy);
      if (!fields) continue;
      statements.push(env.DB.prepare(
        `INSERT OR REPLACE INTO gc_policy_matches
         (job_id, version_id, policy_id, group_key, registered_at, keep_count, capacity_versions)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        jobId,
        row.version_id,
        policy.id,
        groupKey(row, fields),
        row.registered_at,
        policy.last_n,
        policy.capacity_versions,
      ));
    }
  }
  for (let offset = 0; offset < statements.length; offset += 100) await env.DB.batch(statements.slice(offset, offset + 100));
}

async function protectedVersionIds(env: Bindings, jobId: string, versions: VersionRow[]): Promise<Set<string>> {
  if (!versions.length) return new Set();
  const protectedIds = new Set<string>();
  for (let offset = 0; offset < versions.length; offset += GC_VERSION_QUERY_BATCH_SIZE) {
    const batch = versions.slice(offset, offset + GC_VERSION_QUERY_BATCH_SIZE);
    const placeholders = batch.map(() => "?").join(",");
    const result = await env.DB.prepare(
      `SELECT DISTINCT version_id FROM (
         SELECT version_id, keep_count,
           ROW_NUMBER() OVER (PARTITION BY policy_id, group_key ORDER BY registered_at DESC, version_id DESC) AS position
         FROM gc_policy_matches
         WHERE job_id = ? AND keep_count IS NOT NULL
       ) ranked
       WHERE keep_count > 0 AND position <= keep_count
         AND version_id IN (${placeholders})`,
    ).bind(jobId, ...batch.map((row) => row.version_id)).all<{ version_id: string }>();
    for (const row of result.results) protectedIds.add(row.version_id);
  }
  return protectedIds;
}

async function capacityExcessVersionIds(env: Bindings, jobId: string, versions: VersionRow[]): Promise<Set<string>> {
  if (!versions.length) return new Set();
  const excessIds = new Set<string>();
  for (let offset = 0; offset < versions.length; offset += GC_VERSION_QUERY_BATCH_SIZE) {
    const batch = versions.slice(offset, offset + GC_VERSION_QUERY_BATCH_SIZE);
    const placeholders = batch.map(() => "?").join(",");
    const result = await env.DB.prepare(
      `SELECT version_id FROM (
         SELECT version_id, capacity_versions,
           ROW_NUMBER() OVER (PARTITION BY policy_id, group_key ORDER BY registered_at DESC, version_id DESC) AS position
         FROM gc_policy_matches
         WHERE job_id = ? AND capacity_versions IS NOT NULL
       ) ranked
       WHERE capacity_versions IS NOT NULL AND position > capacity_versions
         AND version_id IN (${placeholders})`,
    ).bind(jobId, ...batch.map((row) => row.version_id)).all<{ version_id: string }>();
    for (const row of result.results) excessIds.add(row.version_id);
  }
  return excessIds;
}

async function gcSnapshots(env: Bindings, jobId: string, versions: VersionRow[]): Promise<Map<string, string>> {
  if (!versions.length) return new Map();
  const snapshots = new Map<string, string>();
  for (let offset = 0; offset < versions.length; offset += GC_VERSION_QUERY_BATCH_SIZE) {
    const batch = versions.slice(offset, offset + GC_VERSION_QUERY_BATCH_SIZE);
    const placeholders = batch.map(() => "?").join(",");
    const result = await env.DB.prepare(
      `SELECT version_id, updated_at FROM gc_scan_versions
       WHERE job_id = ? AND version_id IN (${placeholders})`,
    ).bind(jobId, ...batch.map((row) => row.version_id)).all<{ version_id: string; updated_at: string }>();
    for (const row of result.results) snapshots.set(row.version_id, row.updated_at);
  }
  return snapshots;
}

async function completeGc(env: Bindings, jobId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM gc_policy_matches WHERE job_id = ?").bind(jobId),
    env.DB.prepare("DELETE FROM gc_scan_versions WHERE job_id = ?").bind(jobId),
    env.DB.prepare("UPDATE jobs SET status = 'completed', updated_at = ? WHERE id = ?").bind(now(), jobId),
  ]);
}

export async function processGc(env: Bindings, jobId: string): Promise<void> {
  const job = await env.DB.prepare("SELECT payload_json FROM jobs WHERE id = ?").bind(jobId).first<{ payload_json: string }>();
  if (!job) throw new AppError("invalid_job", "The GC job does not exist", 500);
  const payload = parsePayload<GcPayload>(job.payload_json, { phase: "protect", lastVersionId: "" });
  const policies = payload.policySnapshot ?? await getPolicies(env);
  await touchJob(env, jobId);

  if ((payload.phase ?? "protect") === "protect") {
    const versions = await getGcPage(env, payload.lastVersionId ?? "");
    await recordGcPage(env, jobId, versions, policies);
    if (versions.length === GC_PAGE_SIZE) {
      await updateJob(env, jobId, { ...payload, policySnapshot: policies, phase: "protect", lastVersionId: versions.at(-1)?.version_id ?? "" }, "queued");
      return;
    }
    await updateJob(env, jobId, { ...payload, policySnapshot: policies, phase: "evaluate", lastVersionId: "" }, "queued");
    return;
  }

  const versions = await getGcPage(env, payload.lastVersionId ?? "");
  const protectedIds = await protectedVersionIds(env, jobId, versions);
  const capacityExcessIds = await capacityExcessVersionIds(env, jobId, versions);
  const snapshots = await gcSnapshots(env, jobId, versions);
  const retentionDays = defaultRetention(env);
  const timestamp = Date.now();
  for (const row of versions) {
    const snapshotUpdatedAt = snapshots.get(row.version_id);
    if (!snapshotUpdatedAt || snapshotUpdatedAt !== row.updated_at || row.pinned || protectedIds.has(row.version_id)) continue;
    const retention = effectiveRetentionDays(row, policies, retentionDays);
    if (!capacityExcessIds.has(row.version_id) && timestamp - Date.parse(row.registered_at) < retention * 24 * 60 * 60 * 1000) continue;
    if (await findActiveDeletionJob(env, row.version_id)) continue;
    await createDeletionJob(env, row.version_id, "gc", {
      reason: "retention",
      packageName: row.package_name,
      versionName: row.version_name,
      automaticGc: true,
    }, { automaticGc: true, expectedUpdatedAt: row.updated_at });
    await touchJob(env, jobId);
  }
  if (versions.length === GC_PAGE_SIZE) {
    await updateJob(env, jobId, { ...payload, policySnapshot: policies, phase: "evaluate", lastVersionId: versions.at(-1)?.version_id ?? "" }, "queued");
    return;
  }
  await completeGc(env, jobId);
}

async function enqueueDeleteItems(env: Bindings, jobId: string, versionId: string, offset: number): Promise<number> {
  const members = await env.DB.prepare(
    `SELECT m.narinfo_key, r.nar_key
     FROM artifact_version_members m
     LEFT JOIN narinfo_refs r ON r.narinfo_key = m.narinfo_key
     WHERE m.version_id = ? ORDER BY m.narinfo_key LIMIT ? OFFSET ?`,
  ).bind(versionId, MEMBER_PAGE_SIZE, offset).all<MemberRow>();
  const statements = [];
  for (const member of members.results) {
    statements.push(env.DB.prepare(
      "INSERT OR IGNORE INTO job_object_items (job_id, object_key, object_kind) VALUES (?, ?, 'narinfo')",
    ).bind(jobId, member.narinfo_key));
    if (member.nar_key) statements.push(env.DB.prepare(
      "INSERT OR IGNORE INTO job_object_items (job_id, object_key, object_kind) VALUES (?, ?, 'nar')",
    ).bind(jobId, member.nar_key));
  }
  for (let index = 0; index < statements.length; index += 100) await env.DB.batch(statements.slice(index, index + 100));
  return members.results.length;
}

async function detachVersionMembers(env: Bindings, jobId: string, versionId: string): Promise<void> {
  // This transaction removes membership and narinfo references while updating
  // both denormalized counters. Re-running it is harmless because the rows are
  // gone after the first successful batch.
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE objects SET version_member_count = MAX(0, version_member_count - (
         SELECT COUNT(*) FROM artifact_version_members m WHERE m.version_id = ? AND m.narinfo_key = objects.r2_key
       )) WHERE kind = 'narinfo' AND r2_key IN (SELECT narinfo_key FROM artifact_version_members WHERE version_id = ?)`,
    ).bind(versionId, versionId),
    env.DB.prepare("DELETE FROM artifact_version_members WHERE version_id = ?").bind(versionId),
    env.DB.prepare(
      `UPDATE objects SET narinfo_ref_count = MAX(0, narinfo_ref_count - (
         SELECT COUNT(*) FROM narinfo_refs r
         JOIN job_object_items i ON i.job_id = ? AND i.object_kind = 'narinfo' AND i.object_key = r.narinfo_key
         WHERE r.nar_key = objects.r2_key
           AND NOT EXISTS (SELECT 1 FROM artifact_version_members m WHERE m.narinfo_key = r.narinfo_key)
       )) WHERE kind = 'nar'`,
    ).bind(jobId),
    env.DB.prepare(
      `DELETE FROM narinfo_refs
       WHERE narinfo_key IN (SELECT object_key FROM job_object_items WHERE job_id = ? AND object_kind = 'narinfo')
         AND NOT EXISTS (SELECT 1 FROM artifact_version_members m WHERE m.narinfo_key = narinfo_refs.narinfo_key)`,
    ).bind(jobId),
  ]);
}

async function markObjectDeleting(env: Bindings, item: JobObjectRow): Promise<boolean> {
  const guard = item.object_kind === "narinfo"
    ? `kind = 'narinfo' AND version_member_count = 0
       AND NOT EXISTS (SELECT 1 FROM artifact_version_members m WHERE m.narinfo_key = objects.r2_key)
       AND NOT EXISTS (SELECT 1 FROM narinfo_refs r WHERE r.narinfo_key = objects.r2_key)`
    : "kind = 'nar' AND narinfo_ref_count = 0";
  const result = await env.DB.prepare(
    `UPDATE objects SET state = 'deleting'
     WHERE r2_key = ? AND state IN ('ready', 'deleting') AND ${guard}`,
  ).bind(item.object_key).run();
  return result.meta.changes === 1;
}

async function revokeUploadSessions(env: Bindings, key: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE upload_sessions
     SET status = 'revoked', error_code = 'object_deleting', updated_at = ?
     WHERE r2_key = ? AND status = 'issued'`,
  ).bind(now(), key).run();
}

async function processDeleteObjects(env: Bindings, jobId: string): Promise<boolean> {
  const rows = await env.DB.prepare(
    "SELECT object_key, object_kind FROM job_object_items WHERE job_id = ? ORDER BY object_kind, object_key LIMIT ?",
  ).bind(jobId, OBJECT_PAGE_SIZE).all<JobObjectRow>();
  if (!rows.results.length) return true;
  let lastHeartbeat = Date.now();
  let deferred = false;
  for (let index = 0; index < rows.results.length; index += 1) {
    const item = rows.results[index];
    if (Date.now() - lastHeartbeat >= 60_000) {
      await touchJob(env, jobId);
      lastHeartbeat = Date.now();
    }
    const owner = await claimObjectWrite(env, item.object_key);
    if (!owner) {
      deferred = true;
      continue;
    }
    try {
      const deleting = await markObjectDeleting(env, item);
      if (deleting) {
        await revokeUploadSessions(env, item.object_key);
        await env.CACHE_BUCKET.delete(item.object_key);
        await env.DB.prepare(
          "DELETE FROM objects WHERE r2_key = ? AND state = 'deleting'",
        ).bind(item.object_key).run();
      }
    } finally {
      await releaseObjectWrite(env, item.object_key, owner);
    }
    await env.DB.prepare("DELETE FROM job_object_items WHERE job_id = ? AND object_key = ? AND object_kind = ?")
      .bind(jobId, item.object_key, item.object_kind).run();
  }
  await touchJob(env, jobId);
  return !deferred && rows.results.length < OBJECT_PAGE_SIZE;
}

async function finishDeleteVersion(env: Bindings, jobId: string, version: VersionRow): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM job_object_items WHERE job_id = ?").bind(jobId),
    env.DB.prepare("UPDATE artifact_versions SET state = 'deleted', updated_at = ? WHERE version_id = ?").bind(now(), version.version_id),
    env.DB.prepare("UPDATE jobs SET status = 'completed', updated_at = ? WHERE id = ?").bind(now(), jobId),
  ]);
  await emitAudit(env, "version_deleted", "job", `${version.package_name}/${version.version_name}`, { jobId, versionId: version.version_id });
}

export async function processDeleteVersion(env: Bindings, jobId: string): Promise<void> {
  const job = await env.DB.prepare("SELECT target_version_id, cursor, payload_json FROM jobs WHERE id = ?")
    .bind(jobId).first<{ target_version_id: string | null; cursor: number; payload_json: string }>();
  if (!job?.target_version_id) throw new AppError("invalid_job", "The delete job has no target version", 500);
  const payload = parsePayload<DeletePayload>(job.payload_json, {});
  const version = await env.DB.prepare("SELECT * FROM artifact_versions WHERE version_id = ?")
    .bind(job.target_version_id).first<VersionRow>();
  if (!version || version.state === "deleted") {
    await updateJob(env, jobId, payload, "completed");
    return;
  }
  if (payload.automaticGc && version.pinned && version.state === "active") {
    await updateJob(env, jobId, payload, "completed");
    return;
  }
  if (version.state !== "deleting") {
    await env.DB.prepare("UPDATE artifact_versions SET state = 'deleting', updated_at = ? WHERE version_id = ? AND state IN ('registering', 'active')")
      .bind(now(), version.version_id).run();
  }
  const phase = payload.phase ?? "members";
  if (phase === "members") {
    const count = await enqueueDeleteItems(env, jobId, version.version_id, job.cursor);
    if (count === MEMBER_PAGE_SIZE) {
      await updateJob(env, jobId, { ...payload, phase: "members" }, "queued", job.cursor + count);
      return;
    }
    await detachVersionMembers(env, jobId, version.version_id);
    await updateJob(env, jobId, { ...payload, phase: "objects" }, "queued");
  }
  const complete = await processDeleteObjects(env, jobId);
  if (complete) {
    const current = await env.DB.prepare("SELECT * FROM artifact_versions WHERE version_id = ?").bind(version.version_id).first<VersionRow>();
    await finishDeleteVersion(env, jobId, current ?? version);
  } else {
    await updateJob(env, jobId, { ...payload, phase: "objects" }, "queued");
  }
}
