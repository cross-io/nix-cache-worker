import type { Bindings } from "../env";
import { AppError } from "../domain/errors";
import { cacheControlFor, contentTypeFor, type ObjectKind } from "../domain/keys";
import { hashStream } from "../domain/sha256";
import { emitMetric } from "../observability";
import { getObject, upsertObject } from "./db";
import { createPresignedRead, directDownloadTtl } from "./presign";

const WRITE_CLAIM_TTL_MS = 15 * 60_000;
const WRITE_CLAIM_CLEANUP_INTERVAL_MS = 60_000;
let lastWriteClaimCleanupAt = 0;

export type UploadResult = {
  object: R2Object;
  duplicate: boolean;
  sha256: string;
};

export function httpMetadataFor(kind: ObjectKind): R2HTTPMetadata {
  return {
    contentType: contentTypeFor(kind),
    cacheControl: cacheControlFor(kind),
  };
}

function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(",").map((part) => part.trim()).some((part) => part === "*" || part === etag || part === `W/${etag}`);
}

function strongEtagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(",").map((part) => part.trim()).some((part) => part === "*" || part === etag);
}

export async function claimObjectWrite(env: Bindings, key: string): Promise<string | null> {
  const owner = crypto.randomUUID();
  const currentTime = Date.now();
  const currentTimestamp = new Date(currentTime).toISOString();
  const expiresAt = new Date(currentTime + WRITE_CLAIM_TTL_MS).toISOString();
  if (currentTime - lastWriteClaimCleanupAt >= WRITE_CLAIM_CLEANUP_INTERVAL_MS) {
    lastWriteClaimCleanupAt = currentTime;
    await env.DB.prepare("DELETE FROM write_claims WHERE expires_at < ?").bind(currentTimestamp).run();
  }
  const result = await env.DB.prepare(
    `INSERT INTO write_claims (r2_key, owner, expires_at) VALUES (?, ?, ?)
     ON CONFLICT(r2_key) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
     WHERE write_claims.expires_at < ?`,
  ).bind(key, owner, expiresAt, currentTimestamp).run();
  return result.meta.changes === 1 ? owner : null;
}

export async function renewObjectWrite(env: Bindings, key: string, owner: string): Promise<void> {
  const expiresAt = new Date(Date.now() + WRITE_CLAIM_TTL_MS).toISOString();
  const result = await env.DB.prepare("UPDATE write_claims SET expires_at = ? WHERE r2_key = ? AND owner = ?")
    .bind(expiresAt, key, owner).run();
  if (result.meta.changes === 0) throw new AppError("upload_claim_lost", "The upload claim expired or was lost", 409);
}

export async function releaseObjectWrite(env: Bindings, key: string, owner: string): Promise<void> {
  await env.DB.prepare("DELETE FROM write_claims WHERE r2_key = ? AND owner = ?").bind(key, owner).run();
}

export function streamWithWriteClaim(
  env: Bindings,
  key: string,
  owner: string,
  body: ReadableStream<Uint8Array>,
  length?: number,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let lastRenewedAt = Date.now();
  const renewing = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (Date.now() - lastRenewedAt >= WRITE_CLAIM_TTL_MS / 3) {
          await renewObjectWrite(env, key, owner);
          lastRenewedAt = Date.now();
        }
        if (result.done) {
          controller.close();
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        await reader.cancel(error).catch(() => undefined);
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  if (length === undefined) return renewing;
  const fixed = new FixedLengthStream(length);
  void renewing.pipeTo(fixed.writable).catch(() => undefined);
  return fixed.readable;
}

async function digestExisting(
  env: Bindings,
  key: string,
  kind: ObjectKind,
  existing: R2Object,
  indexed: Awaited<ReturnType<typeof getObject>>,
  owner?: string,
): Promise<string> {
  if (indexed?.sha256 && indexed.size === existing.size && indexed.state === "ready") return indexed.sha256;
  const body = await env.CACHE_BUCKET.get(key);
  emitMetric("r2_get", { key, kind, operation: "get", status: body ? 200 : 404, bytes: body?.size ?? 0, duplicateCheck: true });
  if (!body?.body) throw new AppError("orphaned_object", "The object exists in R2 but cannot be read for index repair", 503);
  const digest = await hashStream(owner ? streamWithWriteClaim(env, key, owner, body.body, existing.size) : body.body);
  // A pending narinfo row is a short-lived reference reservation. Do not
  // publish it while comparing a conflicting replay: its caller must be able
  // to roll the reservation back without leaving a live narinfo reference.
  if (indexed?.state !== "pending") {
    if (!await upsertObject(env, { key, kind: indexed?.kind ?? kind, etag: existing.httpEtag, sha256: digest.sha256, size: existing.size })) {
      throw new AppError("object_deleting", "The object is currently being deleted", 409);
    }
  }
  return digest.sha256;
}

export async function duplicateDecisionByDigest(
  env: Bindings,
  key: string,
  kind: ObjectKind,
  incoming: { sha256: string; size: number },
  existing: R2Object,
  indexed: Awaited<ReturnType<typeof getObject>>,
  owner?: string,
): Promise<UploadResult> {
  if (indexed?.state === "deleting") throw new AppError("object_deleting", "The object is currently being deleted", 409);
  const existingSha256 = await digestExisting(env, key, kind, existing, indexed, owner);
  if (incoming.sha256 !== existingSha256 || incoming.size !== existing.size) {
    throw new AppError("immutable_conflict", "An object with this key already exists with different content", 409);
  }
  if (indexed?.state === "pending") {
    if (!await upsertObject(env, { key, kind, etag: existing.httpEtag, sha256: existingSha256, size: existing.size })) {
      throw new AppError("object_deleting", "The object is currently being deleted", 409);
    }
  }
  emitMetric("r2_put", { key, kind, status: 204, duplicate: true, bytes: 0 });
  return { object: existing, duplicate: true, sha256: incoming.sha256 };
}

async function discardCreatedObject(env: Bindings, key: string, kind: ObjectKind, etag: string): Promise<void> {
  const current = await env.CACHE_BUCKET.head(key);
  emitMetric("r2_get", { key, kind, operation: "head", status: current ? 200 : 404, bytes: 0, cleanup: "conflicting_put" });
  if (current?.httpEtag === etag) {
    await env.CACHE_BUCKET.delete(key);
    emitMetric("r2_put", { key, kind, status: 204, duplicate: false, bytes: 0, cleanup: "conflicting_put" });
  }
}

/**
 * Write once to the final key. The normal path is one conditional R2 PUT and
 * one D1 upsert. Only a conditional race or an idempotent replay needs a
 * follow-up HEAD/GET to compare the immutable bytes.
 */
export async function putImmutableObject(
  env: Bindings,
  key: string,
  kind: ObjectKind,
  request: Request,
  options: { allowPending?: boolean } = {},
): Promise<UploadResult> {
  const owner = await claimObjectWrite(env, key);
  if (!owner) throw new AppError("upload_in_progress", "Another upload for this object is in progress", 409);
  try {
    const indexed = await getObject(env, key);
    if (indexed && indexed.kind !== kind) throw new AppError("immutable_conflict", "An object with this key already exists with a different kind", 409);
    if (indexed?.state === "deleting") throw new AppError("object_deleting", "The object is currently being deleted", 409);
    if (indexed?.state === "pending" && !options.allowPending) {
      throw new AppError("object_uploading", "The object is currently being uploaded", 409);
    }

    const ifMatch = request.headers.get("If-Match");
    const ifNoneMatch = request.headers.get("If-None-Match");
    if (ifMatch) {
      const existing = await env.CACHE_BUCKET.head(key);
      if (!existing || !strongEtagMatches(ifMatch, existing.httpEtag)) {
        throw new AppError("precondition_failed", "If-Match does not match the existing object", 412);
      }
      if (ifNoneMatch && etagMatches(ifNoneMatch, existing.httpEtag)) {
        throw new AppError("precondition_failed", "If-None-Match matches the existing object", 412);
      }
      if (!request.body) throw new AppError("empty_body", "PUT requests must contain a body", 400);
      const incoming = await hashStream(request.body);
      return duplicateDecisionByDigest(env, key, kind, incoming, existing, indexed, owner);
    }

    if (!request.body) throw new AppError("empty_body", "PUT requests must contain a body", 400);
    const [hashBody, uploadBody] = request.body.tee();
    const hashPromise = hashStream(hashBody);
    const onlyIf: R2Conditional = { etagDoesNotMatch: "*" };
    const object = await env.CACHE_BUCKET.put(key, uploadBody, {
      onlyIf,
      httpMetadata: httpMetadataFor(kind),
    });
    const incoming = await hashPromise;
    if (object) {
      if (indexed?.state === "ready" && (
        !indexed.sha256 || indexed.size !== incoming.size || indexed.sha256 !== incoming.sha256
      )) {
        await discardCreatedObject(env, key, kind, object.httpEtag);
        throw new AppError("immutable_conflict", "The D1 index already contains different immutable content", 409);
      }
      emitMetric("r2_put", { key, kind, status: 201, duplicate: false, bytes: incoming.size });
      emitMetric("upload_bytes", { key, kind, status: 201, bytes: incoming.size });
      if (!await upsertObject(env, { key, kind, etag: object.httpEtag, sha256: incoming.sha256, size: incoming.size })) {
        await env.CACHE_BUCKET.delete(key);
        throw new AppError("object_deleting", "The object is currently being deleted", 409);
      }
      return { object, duplicate: false, sha256: incoming.sha256 };
    }

    const existing = await env.CACHE_BUCKET.head(key);
    emitMetric("r2_get", { key, kind, operation: "head", status: existing ? 200 : 404, bytes: 0, duplicateCheck: true });
    if (!existing) throw new AppError("upload_race", "The conditional upload failed without an observable object", 503);
    if (ifNoneMatch && etagMatches(ifNoneMatch, existing.httpEtag)) {
      throw new AppError("precondition_failed", "If-None-Match matches the existing object", 412);
    }
    return duplicateDecisionByDigest(env, key, kind, incoming, existing, await getObject(env, key), owner);
  } finally {
    await releaseObjectWrite(env, key, owner);
  }
}

export async function getObjectResponse(env: Bindings, request: Request, key: string, kind: ObjectKind): Promise<Response> {
  // R2 presigned URLs preserve R2's native status, range, and validator
  // handling. A HEAD+Range request is the one binding fallback needed by Nix
  // clients that require an exact Content-Range response before downloading.
  if (request.method === "HEAD" && request.headers.has("Range")) return getBindingObjectResponse(env, request, key, kind);
  const downloadTtl = directDownloadTtl(env);
  const presigned = await createPresignedRead(env, key, request.method as "GET" | "HEAD", downloadTtl);
  emitMetric("r2_get", { key, kind, method: request.method, operation: "presigned_redirect", status: 307, bytes: 0 });
  return new Response(null, { status: 307, headers: { "Cache-Control": "no-store", Location: presigned.url } });
}

async function getBindingObjectResponse(env: Bindings, request: Request, key: string, kind: ObjectKind): Promise<Response> {
  const head = await env.CACHE_BUCKET.head(key);
  emitMetric("r2_get", { key, kind, method: request.method, operation: "head", status: head ? 200 : 404, bytes: 0, rangeFallback: true });
  if (!head) {
    emitMetric("cache_miss", { key, kind, method: request.method, status: 404, bytes: 0 });
    return new Response(null, { status: 404 });
  }
  const ifMatch = request.headers.get("If-Match");
  if (ifMatch && !strongEtagMatches(ifMatch, head.httpEtag)) return new Response(null, { status: 412, headers: { ETag: head.httpEtag } });
  if (etagMatches(request.headers.get("If-None-Match"), head.httpEtag)) {
    return new Response(null, { status: 304, headers: { ETag: head.httpEtag, "Cache-Control": cacheControlFor(kind) } });
  }
  let range: ReturnType<typeof parseRangeHeader>;
  try {
    range = parseRangeHeader(request.headers.get("Range") ?? "", head.size);
  } catch (error) {
    if (error instanceof AppError && error.status === 416) {
      return new Response(null, { status: 416, headers: { ETag: head.httpEtag, "Accept-Ranges": "bytes", "Content-Range": `bytes */${head.size}`, "Content-Length": "0" } });
    }
    throw error;
  }
  const headers = new Headers({
    ETag: head.httpEtag,
    "Cache-Control": cacheControlFor(kind),
    "Accept-Ranges": "bytes",
    "Content-Type": contentTypeFor(kind),
    "Last-Modified": head.uploaded.toUTCString(),
    "Content-Length": String(range.length),
    "Content-Range": `bytes ${range.start}-${range.end}/${head.size}`,
  });
  if (request.method === "HEAD") return new Response(null, { status: 206, headers });
  const object = await env.CACHE_BUCKET.get(key, { range: { offset: range.offset, length: range.length } });
  if (!object?.body) return new Response(null, { status: 404 });
  emitMetric("r2_get", { key, kind, method: request.method, operation: "get", status: 206, bytes: range.length, rangeFallback: true });
  emitMetric("bytes_served", { key, kind, method: "GET", status: 206, bytes: range.length, rangeFallback: true });
  return new Response(object.body, { status: 206, headers });
}

function parseRangeHeader(header: string, size: number): { offset: number; length: number; start: number; end: number } {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) throw new AppError("invalid_range", "Only one byte range is supported", 416);
  const startText = match[1];
  const endText = match[2];
  if (!startText && !endText) throw new AppError("invalid_range", "The byte range is invalid", 416);
  if (!startText) {
    const suffix = Number(endText);
    if (!Number.isInteger(suffix) || suffix <= 0 || size === 0) throw new AppError("invalid_range", "The byte range is unsatisfiable", 416);
    const length = Math.min(suffix, size);
    return { offset: size - length, length, start: size - length, end: size - 1 };
  }
  const start = Number(startText);
  const end = endText ? Number(endText) : size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= size || end < start) throw new AppError("invalid_range", "The byte range is unsatisfiable", 416);
  const boundedEnd = Math.min(end, size - 1);
  return { offset: start, length: boundedEnd - start + 1, start, end: boundedEnd };
}
