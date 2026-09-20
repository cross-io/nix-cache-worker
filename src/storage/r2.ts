import type { Bindings } from "../env";
import { AppError } from "../domain/errors";
import { cacheControlFor, contentTypeFor, type ObjectKind } from "../domain/keys";
import { hashStream } from "../domain/sha256";
import { emitMetric } from "../observability";
import { getObject, upsertObject } from "./db";
import { createPresignedRead, directDownloadTtl } from "./presign";

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

async function digestExisting(
  env: Bindings,
  key: string,
  kind: ObjectKind,
  existing: R2Object,
  indexed: Awaited<ReturnType<typeof getObject>>,
): Promise<string> {
  if (indexed?.sha256 && indexed.size === existing.size && indexed.state === "ready") return indexed.sha256;
  const body = await env.CACHE_BUCKET.get(key);
  emitMetric("r2_get", { key, kind, operation: "get", status: body ? 200 : 404, bytes: body?.size ?? 0, duplicateCheck: true });
  if (!body?.body) throw new AppError("orphaned_object", "The object exists in R2 but cannot be read for index repair", 503);
  const digest = await hashStream(body.body);
  await upsertObject(env, { key, kind: indexed?.kind ?? kind, etag: existing.httpEtag, sha256: digest.sha256, size: existing.size });
  return digest.sha256;
}

async function duplicateResult(
  env: Bindings,
  key: string,
  kind: ObjectKind,
  incoming: { sha256: string; size: number },
  existing: R2Object,
  indexed: Awaited<ReturnType<typeof getObject>>,
): Promise<UploadResult> {
  if (indexed?.state === "deleting") throw new AppError("object_deleting", "The object is currently being deleted", 409);
  const existingSha256 = await digestExisting(env, key, kind, existing, indexed);
  if (incoming.sha256 !== existingSha256 || incoming.size !== existing.size) {
    throw new AppError("immutable_conflict", "An object with this key already exists with different content", 409);
  }
  emitMetric("r2_put", { key, kind, status: 204, duplicate: true, bytes: 0 });
  return { object: existing, duplicate: true, sha256: incoming.sha256 };
}

/**
 * Write once to the final key. The normal path is one conditional R2 PUT and
 * one D1 upsert. Only a conditional race or an idempotent replay needs a
 * follow-up HEAD/GET to compare the immutable bytes.
 */
export async function putImmutableObject(env: Bindings, key: string, kind: ObjectKind, request: Request): Promise<UploadResult> {
  if (request.headers.get("If-Match")) {
    const existing = await env.CACHE_BUCKET.head(key);
    if (!existing || !strongEtagMatches(request.headers.get("If-Match"), existing.httpEtag)) {
      throw new AppError("precondition_failed", "If-Match does not match the existing object", 412);
    }
    throw new AppError("immutable_conflict", "An object with this key already exists", 409);
  }

  if (!request.body) throw new AppError("empty_body", "PUT requests must contain a body", 400);
  const [hashBody, uploadBody] = request.body.tee();
  const hashPromise = hashStream(hashBody);
  const onlyIf: R2Conditional = { etagDoesNotMatch: request.headers.get("If-None-Match") ?? "*" };
  const object = await env.CACHE_BUCKET.put(key, uploadBody, {
    onlyIf,
    httpMetadata: httpMetadataFor(kind),
  });
  const incoming = await hashPromise;
  if (object) {
    emitMetric("r2_put", { key, kind, status: 201, duplicate: false, bytes: incoming.size });
    emitMetric("upload_bytes", { key, kind, status: 201, bytes: incoming.size });
    await upsertObject(env, { key, kind, etag: object.httpEtag, sha256: incoming.sha256, size: incoming.size });
    return { object, duplicate: false, sha256: incoming.sha256 };
  }

  const existing = await env.CACHE_BUCKET.head(key);
  emitMetric("r2_get", { key, kind, operation: "head", status: existing ? 200 : 404, bytes: 0, duplicateCheck: true });
  if (!existing) throw new AppError("upload_race", "The conditional upload failed without an observable object", 503);
  if (request.headers.has("If-None-Match")) throw new AppError("precondition_failed", "The object already exists", 412);
  return duplicateResult(env, key, kind, incoming, existing, await getObject(env, key));
}

export async function getObjectResponse(env: Bindings, request: Request, key: string, kind: ObjectKind): Promise<Response> {
  const downloadTtl = directDownloadTtl(env);
  // R2 presigned URLs preserve R2's native status, range, and validator
  // handling. A HEAD+Range request is the one binding fallback needed by Nix
  // clients that require an exact Content-Range response before downloading.
  if (!(request.method === "HEAD" && request.headers.has("Range"))) {
    const presigned = await createPresignedRead(env, key, request.method as "GET" | "HEAD", downloadTtl);
    emitMetric("r2_get", { key, kind, method: request.method, operation: "presigned_redirect", status: 307, bytes: 0 });
    return new Response(null, { status: 307, headers: { "Cache-Control": "no-store", Location: presigned.url } });
  }
  return getBindingObjectResponse(env, request, key, kind);
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
