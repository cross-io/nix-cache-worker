import type { Bindings } from "../env";
import { AppError } from "../domain/errors";
import { now } from "../storage/db";
import { processDeleteVersion, processGc } from "./runner";

export type JobRow = {
  id: string;
  type: "gc" | "delete_version";
  status: "queued" | "running" | "failed" | "completed";
  target_version_id: string | null;
  cursor: number;
  attempts: number;
  payload_json: string;
  last_error: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type ScheduledGcJob = {
  id: string;
  status: JobRow["status"];
  created: boolean;
};

export async function createJob(env: Bindings, type: JobRow["type"], targetVersionId: string | null, actor: string, payload: Record<string, unknown> = {}): Promise<string> {
  const id = crypto.randomUUID();
  const timestamp = now();
  await env.DB.prepare(
    "INSERT INTO jobs (id, type, status, target_version_id, payload_json, created_by, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?)",
  ).bind(id, type, targetVersionId, JSON.stringify(payload), actor, timestamp, timestamp).run();
  return id;
}

export async function scheduleGcJob(env: Bindings, actor: string, payload: Record<string, unknown> = {}): Promise<ScheduledGcJob> {
  const existing = await env.DB.prepare(
    "SELECT id, status FROM jobs WHERE type = 'gc' AND status IN ('queued', 'running', 'failed') ORDER BY created_at ASC LIMIT 1",
  ).first<Pick<JobRow, "id" | "status">>();
  if (existing) return { ...existing, created: false };

  const id = crypto.randomUUID();
  const timestamp = now();
  const inserted = await env.DB.prepare(
    `INSERT INTO jobs (id, type, status, target_version_id, payload_json, created_by, created_at, updated_at)
     SELECT ?, 'gc', 'queued', NULL, ?, ?, ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM jobs WHERE type = 'gc' AND status IN ('queued', 'running', 'failed')
     )`,
  ).bind(id, JSON.stringify(payload), actor, timestamp, timestamp).run();
  if (inserted.meta.changes === 1) return { id, status: "queued", created: true };

  const concurrent = await env.DB.prepare(
    "SELECT id, status FROM jobs WHERE type = 'gc' AND status IN ('queued', 'running', 'failed') ORDER BY created_at ASC LIMIT 1",
  ).first<Pick<JobRow, "id" | "status">>();
  if (!concurrent) throw new AppError("gc_schedule_failed", "The GC job could not be scheduled", 503);
  return { ...concurrent, created: false };
}

export async function findActiveDeletionJob(env: Bindings, versionId: string): Promise<JobRow | null> {
  return env.DB.prepare(
    "SELECT * FROM jobs WHERE type = 'delete_version' AND target_version_id = ? AND status IN ('queued', 'running', 'failed') ORDER BY created_at ASC LIMIT 1",
  ).bind(versionId).first<JobRow>();
}

/**
 * Atomically lock a version for deletion and create its resumable job.
 * SQLite's changes() is evaluated by the INSERT immediately after the UPDATE,
 * so a failed conditional transition cannot leave an orphaned job row.
 */
export async function createDeletionJob(
  env: Bindings,
  targetVersionId: string,
  actor: string,
  payload: Record<string, unknown> = {},
  options: { automaticGc?: boolean; expectedUpdatedAt?: string } = {},
): Promise<string | null> {
  const id = crypto.randomUUID();
  const timestamp = now();
  const conditions = options.automaticGc
    ? "state = 'active' AND pinned = 0"
    : "state IN ('active', 'deleting')";
  const updatedAtCondition = options.expectedUpdatedAt === undefined ? "" : " AND updated_at = ?";
  const updateBindings = options.expectedUpdatedAt === undefined
    ? [timestamp, targetVersionId]
    : [timestamp, targetVersionId, options.expectedUpdatedAt];
  const insertBindings = [id, targetVersionId, JSON.stringify(payload), actor, timestamp, timestamp, targetVersionId];
  const statements = [
    env.DB.prepare(
      `UPDATE artifact_versions SET state = 'deleting', updated_at = ?
       WHERE version_id = ? AND ${conditions}${updatedAtCondition}`,
    ).bind(...updateBindings),
    env.DB.prepare(
      `INSERT OR IGNORE INTO jobs (id, type, status, target_version_id, payload_json, created_by, created_at, updated_at)
       SELECT ?, 'delete_version', 'queued', ?, ?, ?, ?, ?
       WHERE changes() = 1
         AND EXISTS (SELECT 1 FROM artifact_versions WHERE version_id = ? AND state = 'deleting')`,
    ).bind(...insertBindings),
  ];
  const results = await env.DB.batch(statements);
  return results[1]?.meta.changes === 1 ? id : null;
}

export async function getJob(env: Bindings, id: string): Promise<JobRow | null> {
  return env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first<JobRow>();
}

export async function runJob(env: Bindings, id: string): Promise<void> {
  const job = await getJob(env, id);
  if (!job || job.status === "completed") return;
  const staleBefore = new Date(Date.now() - 15 * 60_000).toISOString();
  const claimed = await env.DB.prepare(
    `UPDATE jobs SET status = 'running', attempts = attempts + 1, last_error = NULL, updated_at = ?
     WHERE id = ? AND (status IN ('queued', 'failed') OR (status = 'running' AND updated_at < ?))`,
  ).bind(now(), id, staleBefore).run();
  if (claimed.meta.changes === 0) return;
  try {
    if (job.type === "delete_version") await processDeleteVersion(env, id);
    else await processGc(env, id);
  } catch (error) {
    await env.DB.prepare("UPDATE jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?")
      .bind(error instanceof Error ? error.message : String(error), now(), id).run();
    console.error(JSON.stringify({ event: "job_error", jobId: id, message: error instanceof Error ? error.message : String(error) }));
  }
}

export async function touchJob(env: Bindings, id: string): Promise<void> {
  await env.DB.prepare("UPDATE jobs SET updated_at = ? WHERE id = ? AND status = 'running'").bind(now(), id).run();
}

export async function runQueuedJobs(env: Bindings, limit = 2, rounds = 4): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    const staleBefore = new Date(Date.now() - 15 * 60_000).toISOString();
    const jobs = await env.DB.prepare(
      `SELECT id FROM jobs
       WHERE status IN ('queued', 'failed')
          OR (status = 'running' AND updated_at < ?)
       ORDER BY updated_at ASC LIMIT ?`,
    ).bind(staleBefore, limit).all<{ id: string }>();
    if (jobs.results.length === 0) return;
    for (const job of jobs.results) await runJob(env, job.id);
  }
}
