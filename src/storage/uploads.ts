import type { Bindings } from "../env";
import { AppError } from "../domain/errors";
import { kindForKey } from "../domain/keys";
import { hashStream } from "../domain/sha256";
import { emitMetric } from "../observability";
import { getObject, upsertObject } from "./db";
import { createPresignedPut, directUploadTtl } from "./presign";

export type DirectUploadInput = { key: string; size: number; sha256: string };

function assertSupportedNarKey(key: string): void {
  try {
    if (kindForKey(key) !== "nar" || key.includes("\0") || key.includes("..")) throw new Error("invalid");
  } catch {
    throw new AppError("invalid_upload_key", "Direct uploads only support /nar/ objects", 422);
  }
}

export function validateDirectUploadInput(body: unknown): DirectUploadInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new AppError("invalid_upload", "The direct-upload request must be a JSON object", 422);
  const input = body as Record<string, unknown>;
  if (typeof input.key !== "string" || input.key.length === 0 || input.key.length > 1024) throw new AppError("invalid_upload_key", "The direct-upload key is invalid", 422);
  assertSupportedNarKey(input.key);
  if (typeof input.size !== "number" || !Number.isSafeInteger(input.size) || input.size < 0) throw new AppError("invalid_upload_size", "The direct-upload size must be a non-negative safe integer", 422);
  if (typeof input.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(input.sha256)) throw new AppError("invalid_upload_sha256", "The direct-upload SHA-256 must be 64 lowercase hexadecimal characters", 422);
  return { key: input.key, size: input.size, sha256: input.sha256 };
}

export async function issueDirectUpload(env: Bindings, input: DirectUploadInput): Promise<Record<string, unknown>> {
  const existing = await env.CACHE_BUCKET.head(input.key);
  emitMetric("r2_get", { key: input.key, kind: "nar", operation: "head", status: existing ? 200 : 404, bytes: 0, directUpload: true });
  if (existing) {
    const indexed = await getObject(env, input.key);
    if (indexed?.state === "deleting") throw new AppError("object_deleting", "The object is currently being deleted", 409);
    if (indexed?.sha256 === input.sha256 && indexed.size === input.size && indexed.state === "ready") {
      return { key: input.key, size: input.size, sha256: input.sha256, etag: existing.httpEtag, alreadyExists: true };
    }
    throw new AppError("immutable_conflict", "An object with this key already exists with different or unindexed content", 409);
  }
  const presigned = await createPresignedPut(env, input.key, directUploadTtl(env));
  return {
    key: input.key,
    size: input.size,
    sha256: input.sha256,
    uploadUrl: presigned.url,
    uploadHeaders: presigned.headers,
    expiresAt: presigned.expiresAt,
    alreadyExists: false,
  };
}

export async function completeDirectUpload(env: Bindings, input: DirectUploadInput): Promise<{ object: R2Object; sha256: string; duplicate: boolean }> {
  const object = await env.CACHE_BUCKET.head(input.key);
  emitMetric("r2_get", { key: input.key, kind: "nar", operation: "head", status: object ? 200 : 404, bytes: 0, directUpload: true });
  if (!object) throw new AppError("upload_not_found", "The final R2 object was not found", 424);
  const indexed = await getObject(env, input.key);
  if (indexed?.state === "deleting") throw new AppError("object_deleting", "The object is currently being deleted", 409);
  if (indexed?.state === "ready" && (indexed.sha256 !== input.sha256 || indexed.size !== input.size)) {
    throw new AppError("immutable_conflict", "An object with this key already exists with different content", 409);
  }
  const body = await env.CACHE_BUCKET.get(input.key);
  emitMetric("r2_get", { key: input.key, kind: "nar", operation: "get", status: body ? 200 : 404, bytes: body?.size ?? 0, directUpload: true });
  if (!body?.body) throw new AppError("upload_not_found", "The final R2 object could not be read", 424);
  const digest = await hashStream(body.body);
  if (digest.size !== input.size || digest.sha256 !== input.sha256) {
    await env.CACHE_BUCKET.delete(input.key);
    throw new AppError("upload_digest_mismatch", "The final R2 object does not match the declared size or SHA-256", 422);
  }
  await upsertObject(env, {
    key: input.key,
    kind: "nar",
    etag: object.httpEtag,
    sha256: digest.sha256,
    size: digest.size,
    state: "ready",
  });
  if (!(indexed?.state === "ready" && indexed.sha256 === digest.sha256)) {
    emitMetric("upload_bytes", { key: input.key, kind: "nar", status: 201, bytes: digest.size, directUpload: true });
  }
  return { object, sha256: digest.sha256, duplicate: indexed?.state === "ready" && indexed.sha256 === digest.sha256 };
}
