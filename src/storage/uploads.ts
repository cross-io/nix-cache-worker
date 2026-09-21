import type { Bindings } from "../env";
import { AppError } from "../domain/errors";
import { hashStream } from "../domain/sha256";
import { kindForKey } from "../domain/keys";
import { emitMetric } from "../observability";
import { getObject, now, upsertObject } from "./db";
import {
  claimObjectWrite,
  duplicateDecisionByDigest,
  httpMetadataFor,
  releaseObjectWrite,
  streamWithWriteClaim,
  type UploadResult,
} from "./r2";
import { createPresignedPut, directUploadTtl } from "./presign";

export const DIRECT_UPLOAD_STAGING_PREFIX = "_nix_uploads/";
export const MAX_DIRECT_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;

function emitDirectR2Get(key: string, operation: "head" | "get", object: R2Object | R2ObjectBody | null): void {
  emitMetric("r2_get", { key, kind: "nar", operation, status: object ? 200 : 404, bytes: object?.size ?? 0, directUpload: true });
}

export type UploadSessionStatus = "issued" | "completed" | "failed" | "expired" | "revoked";

export type UploadSessionRow = {
  id: string;
  r2_key: string;
  staging_key: string;
  kind: "nar";
  expected_size: number;
  expected_sha256: string;
  status: UploadSessionStatus;
  object_etag: string | null;
  error_code: string | null;
  created_at: string;
  expires_at: string;
  completed_at: string | null;
  updated_at: string;
};

export type DirectUploadResult = {
  session: UploadSessionRow;
  object: R2Object;
  duplicate: boolean;
  sha256: string;
};

function assertSupportedNarKey(key: string): void {
  let kind: ReturnType<typeof kindForKey>;
  try {
    kind = kindForKey(key);
  } catch {
    throw new AppError("invalid_upload_key", "Direct uploads only support /nar/ objects", 422);
  }
  if (key.includes("\0") || key.includes("..") || kind !== "nar") {
    throw new AppError("invalid_upload_key", "Direct uploads only support /nar/ objects", 422);
  }
}

export function validateDirectUploadInput(body: unknown): { key: string; size: number; sha256: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AppError("invalid_upload", "The direct-upload request must be a JSON object", 422);
  }
  const input = body as Record<string, unknown>;
  const key = input.key;
  const size = input.size;
  const sha256 = input.sha256;
  if (typeof key !== "string" || key.length === 0 || key.length > 1024) {
    throw new AppError("invalid_upload_key", "The direct-upload key is invalid", 422);
  }
  assertSupportedNarKey(key);
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
    throw new AppError("invalid_upload_size", "The direct-upload size must be a non-negative safe integer", 422);
  }
  if (size > MAX_DIRECT_UPLOAD_BYTES) {
    throw new AppError("invalid_upload_size", "The direct-upload size must not exceed the 5 GiB R2 single-PUT limit", 422);
  }
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new AppError("invalid_upload_sha256", "The direct-upload SHA-256 must be 64 lowercase hexadecimal characters", 422);
  }
  return { key, size, sha256 };
}

export function stagingKeyForSession(id: string): string {
  return `${DIRECT_UPLOAD_STAGING_PREFIX}${id}`;
}

export async function getUploadSession(env: Bindings, id: string): Promise<UploadSessionRow | null> {
  return env.DB.prepare("SELECT * FROM upload_sessions WHERE id = ?").bind(id).first<UploadSessionRow>();
}

export async function expireStaleUploadSession(
  env: Bindings,
  key: string,
  existingOwner?: string,
): Promise<{ session: UploadSessionRow | null; blocked: boolean }> {
  const candidate = await env.DB.prepare(
    "SELECT * FROM upload_sessions WHERE r2_key = ? AND status = 'issued' ORDER BY created_at DESC LIMIT 1",
  ).bind(key).first<UploadSessionRow>();
  if (!candidate) return { session: null, blocked: false };
  if (Date.parse(candidate.expires_at) > Date.now()) return { session: candidate, blocked: false };

  const owner = existingOwner ?? await claimObjectWrite(env, key);
  if (!owner) return { session: null, blocked: true };
  try {
    const current = await getUploadSession(env, candidate.id);
    if (!current || current.status !== "issued") return { session: null, blocked: false };
    if (Date.parse(current.expires_at) > Date.now()) return { session: current, blocked: false };
    await markSessionExpired(env, current.id);
    return { session: null, blocked: false };
  } finally {
    if (!existingOwner) await releaseObjectWrite(env, key, owner);
  }
}

export async function createUploadSession(
  env: Bindings,
  input: { key: string; size: number; sha256: string },
): Promise<{ session: UploadSessionRow; presigned: Awaited<ReturnType<typeof createPresignedPut>> }> {
  const id = crypto.randomUUID();
  const createdAt = now();
  const ttl = directUploadTtl(env);
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
  const stagingKey = stagingKeyForSession(id);
  const presigned = await createPresignedPut(env, stagingKey, ttl, new Date(createdAt));
  await env.DB.prepare(
    `INSERT INTO upload_sessions (
       id, r2_key, staging_key, kind, expected_size, expected_sha256, status,
       created_at, expires_at, updated_at
     ) VALUES (?, ?, ?, 'nar', ?, ?, 'issued', ?, ?, ?)`,
  ).bind(id, input.key, stagingKey, input.size, input.sha256, createdAt, expiresAt, createdAt).run();
  const session = await getUploadSession(env, id);
  if (!session) throw new AppError("upload_session_failed", "The upload session could not be created", 503);
  return { session, presigned };
}

async function markSessionFailed(env: Bindings, id: string, errorCode: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE upload_sessions SET status = 'failed', error_code = ?, updated_at = ? WHERE id = ? AND status = 'issued'",
  ).bind(errorCode, now(), id).run();
}

async function markSessionExpired(env: Bindings, id: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE upload_sessions SET status = 'expired', error_code = 'upload_expired', updated_at = ? WHERE id = ? AND status = 'issued'",
  ).bind(now(), id).run();
}

async function markSessionCompleted(env: Bindings, id: string, etag: string): Promise<UploadSessionRow> {
  await env.DB.prepare(
    `UPDATE upload_sessions
     SET status = 'completed', object_etag = ?, completed_at = ?, updated_at = ?, error_code = NULL
     WHERE id = ? AND status = 'issued'`,
  ).bind(etag, now(), now(), id).run();
  const session = await getUploadSession(env, id);
  if (!session || session.status !== "completed") throw new AppError("upload_session_failed", "The upload session could not be completed", 503);
  return session;
}

async function deleteStagingObject(env: Bindings, session: UploadSessionRow): Promise<boolean> {
  try {
    await env.CACHE_BUCKET.delete(session.staging_key);
    return true;
  } catch (error) {
    console.error(JSON.stringify({
      event: "direct_upload_cleanup_error",
      sessionId: session.id,
      message: error instanceof Error ? error.message : String(error),
    }));
    return false;
  }
}

function uploadMismatch(code: string, message: string): AppError {
  return new AppError(code, message, 422);
}

async function compareOrRepairExisting(
  env: Bindings,
  session: UploadSessionRow,
  incoming: { sha256: string; size: number },
  existing: R2Object,
  indexed: Awaited<ReturnType<typeof getObject>>,
  owner: string,
): Promise<DirectUploadResult> {
  let result: UploadResult;
  try {
    result = await duplicateDecisionByDigest(env, session.r2_key, "nar", incoming, existing, indexed, owner);
  } catch (error) {
    if (error instanceof AppError && error.code === "immutable_conflict") {
      await markSessionFailed(env, session.id, "immutable_conflict");
    }
    throw error;
  }
  const completedSession = await markSessionCompleted(env, session.id, result.object.httpEtag);
  return { session: completedSession, ...result };
}

export async function completeUploadSession(env: Bindings, id: string): Promise<DirectUploadResult> {
  const session = await getUploadSession(env, id);
  if (!session) throw new AppError("upload_session_not_found", "The direct-upload session was not found", 404);
  if (session.status === "expired") throw new AppError("upload_expired", "The direct-upload session has expired", 410);
  if (session.status === "failed") throw new AppError("upload_failed", "The direct-upload session has failed", 409, { errorCode: session.error_code });
  if (session.status === "revoked") throw new AppError("upload_revoked", "The direct-upload session was revoked because its final key was deleted", 409);
  if (session.status !== "completed" && Date.parse(session.expires_at) <= Date.now()) {
    await markSessionExpired(env, id);
    throw new AppError("upload_expired", "The direct-upload session has expired", 410);
  }

  const owner = await claimObjectWrite(env, session.r2_key);
  if (!owner) throw new AppError("upload_in_progress", "Another upload for this object is in progress", 409);
  try {
    if (session.status === "completed") {
      const object = await env.CACHE_BUCKET.head(session.r2_key);
      emitDirectR2Get(session.r2_key, "head", object);
      if (!object) throw new AppError("upload_object_missing", "The completed upload object is missing", 503);
      const indexed = await getObject(env, session.r2_key);
      if (indexed?.state === "deleting") throw new AppError("object_deleting", "The object is currently being deleted", 409);
      const current = await env.CACHE_BUCKET.get(session.r2_key);
      emitDirectR2Get(session.r2_key, "get", current);
      if (!current?.body) throw new AppError("upload_object_missing", "The completed upload object is missing", 503);
      const digest = await hashStream(streamWithWriteClaim(env, session.r2_key, owner, current.body, object.size));
      if (digest.size !== session.expected_size || digest.sha256 !== session.expected_sha256) {
        throw new AppError("immutable_conflict", "The completed upload object no longer matches the upload session", 409);
      }
      if (!indexed?.sha256 || indexed.state !== "ready") {
        await upsertObject(env, {
          key: session.r2_key,
          kind: "nar",
          etag: object.httpEtag,
          sha256: digest.sha256,
          size: object.size,
          state: "ready",
        });
      }
      emitMetric("r2_put", { key: session.r2_key, kind: "nar", status: 204, duplicate: true, bytes: 0, directUpload: true });
      return { session, object, duplicate: true, sha256: digest.sha256 };
    }
    const staging = await env.CACHE_BUCKET.head(session.staging_key);
    emitDirectR2Get(session.staging_key, "head", staging);
    if (!staging) throw new AppError("upload_not_ready", "The direct-upload object has not arrived at R2", 409);
    if (staging.size !== session.expected_size) {
      await markSessionFailed(env, id, "upload_size_mismatch");
      throw uploadMismatch("upload_size_mismatch", "The uploaded object size does not match the declared size");
    }

    const stagedBody = await env.CACHE_BUCKET.get(session.staging_key);
    emitDirectR2Get(session.staging_key, "get", stagedBody);
    if (!stagedBody?.body) throw new AppError("upload_not_ready", "The direct-upload object could not be read from R2", 503);
    const incoming = await hashStream(streamWithWriteClaim(env, session.r2_key, owner, stagedBody.body, staging.size));
    if (incoming.size !== session.expected_size) {
      await markSessionFailed(env, id, "upload_size_mismatch");
      throw uploadMismatch("upload_size_mismatch", "The uploaded object size does not match the declared size");
    }
    if (incoming.sha256 !== session.expected_sha256) {
      await markSessionFailed(env, id, "upload_digest_mismatch");
      throw uploadMismatch("upload_digest_mismatch", "The uploaded object SHA-256 does not match the declared digest");
    }

    const existing = await env.CACHE_BUCKET.head(session.r2_key);
    emitDirectR2Get(session.r2_key, "head", existing);
    const indexed = await getObject(env, session.r2_key);
    if (indexed?.state === "deleting") throw new AppError("object_deleting", "The object is currently being deleted", 409);
    if (existing) return await compareOrRepairExisting(env, session, incoming, existing, indexed, owner);

    const source = await env.CACHE_BUCKET.get(session.staging_key);
    emitDirectR2Get(session.staging_key, "get", source);
    if (!source?.body) throw new AppError("upload_not_ready", "The direct-upload object disappeared before finalization", 503);
    const object = await env.CACHE_BUCKET.put(session.r2_key, streamWithWriteClaim(env, session.r2_key, owner, source.body, source.size), {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: httpMetadataFor("nar"),
    });
    if (!object) {
      const raced = await env.CACHE_BUCKET.head(session.r2_key);
      emitDirectR2Get(session.r2_key, "head", raced);
      if (!raced) throw new AppError("upload_race", "The conditional finalization failed without an observable object", 503);
      return await compareOrRepairExisting(env, session, incoming, raced, await getObject(env, session.r2_key), owner);
    }
    emitMetric("r2_put", { key: session.r2_key, kind: "nar", status: 201, duplicate: false, bytes: incoming.size, directUpload: true });
    emitMetric("upload_bytes", { key: session.r2_key, kind: "nar", status: 201, bytes: incoming.size, directUpload: true });
    if (!await upsertObject(env, {
      key: session.r2_key,
      kind: "nar",
      etag: object.httpEtag,
      sha256: incoming.sha256,
      size: object.size,
    })) {
      await env.CACHE_BUCKET.delete(session.r2_key);
      throw new AppError("object_deleting", "The object is currently being deleted", 409);
    }
    const completedSession = await markSessionCompleted(env, id, object.httpEtag);
    return { session: completedSession, object, duplicate: false, sha256: incoming.sha256 };
  } finally {
    await releaseObjectWrite(env, session.r2_key, owner);
  }
}

export async function cleanupUploadSessions(env: Bindings, limit = 100): Promise<void> {
  const timestamp = now();
  const rows = await env.DB.prepare(
    `SELECT * FROM upload_sessions
     WHERE status IN ('completed', 'failed', 'expired', 'revoked')
        OR (status = 'issued' AND expires_at <= ?)
     ORDER BY updated_at ASC LIMIT ?`,
  ).bind(timestamp, limit).all<UploadSessionRow>();
  for (const row of rows.results) {
    if (row.status !== "issued" && Date.parse(row.expires_at) > Date.now()) continue;
    if (row.status === "issued") {
      const owner = await claimObjectWrite(env, row.r2_key);
      if (!owner) continue;
      try {
        const current = await getUploadSession(env, row.id);
        if (!current || current.status !== "issued" || Date.parse(current.expires_at) > Date.now()) continue;
        await markSessionExpired(env, row.id);
        if (await deleteStagingObject(env, current)) {
          await env.DB.prepare("DELETE FROM upload_sessions WHERE id = ? AND status = 'expired'").bind(row.id).run();
        }
      } finally {
        await releaseObjectWrite(env, row.r2_key, owner);
      }
      continue;
    }
    if (await deleteStagingObject(env, row)) {
      await env.DB.prepare(
        "DELETE FROM upload_sessions WHERE id = ? AND status IN ('completed', 'failed', 'expired', 'revoked') AND expires_at <= ?",
      ).bind(row.id, timestamp).run();
    }
  }
}
