import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { AppError } from "../domain/errors";
import { requireRole } from "../middleware/auth";
import { hashStream } from "../domain/sha256";
import { getObject, upsertObject } from "../storage/db";
import { emitMetric } from "../observability";
import { createPresignedPut, directUploadTtl } from "../storage/presign";
import { claimObjectWrite, releaseObjectWrite, streamWithWriteClaim } from "../storage/r2";
import {
  createUploadSession,
  expireStaleUploadSession,
  completeUploadSession,
  validateDirectUploadInput,
  type UploadSessionRow,
} from "../storage/uploads";

export const uploadRoutes = new Hono<AppEnv>();

function sessionResponse(session: UploadSessionRow, presigned: Awaited<ReturnType<typeof createPresignedPut>>) {
  return {
    uploadId: session.id,
    key: session.r2_key,
    size: session.expected_size,
    sha256: session.expected_sha256,
    uploadUrl: presigned.url,
    uploadHeaders: presigned.headers,
    expiresAt: session.expires_at,
    alreadyExists: false,
  };
}

async function parseJSON(c: Context<AppEnv>): Promise<unknown> {
  return c.req.json<unknown>().catch(() => {
    throw new AppError("invalid_json", "The request body must be JSON", 400);
  });
}

uploadRoutes.post("/api/uploads", requireRole("write"), async (c) => {
  const input = validateDirectUploadInput(await parseJSON(c));
  const owner = await claimObjectWrite(c.env, input.key);
  if (!owner) throw new AppError("upload_in_progress", "Another upload for this object is in progress", 409);
  try {
    const existing = await c.env.CACHE_BUCKET.head(input.key);
    emitMetric("r2_get", { key: input.key, kind: "nar", operation: "head", status: existing ? 200 : 404, bytes: 0, directUpload: true });
    const indexed = await getObject(c.env, input.key);
    if (indexed?.state === "deleting") throw new AppError("object_deleting", "The object is currently being deleted", 409);
    if (existing) {
      let existingSha256 = indexed?.sha256;
      if (!existingSha256) {
        const body = await c.env.CACHE_BUCKET.get(input.key);
        emitMetric("r2_get", { key: input.key, kind: "nar", operation: "get", status: body ? 200 : 404, bytes: body?.size ?? 0, directUpload: true });
        if (body?.body) existingSha256 = (await hashStream(streamWithWriteClaim(c.env, input.key, owner, body.body, existing.size))).sha256;
      }
      if (existingSha256 === input.sha256 && existing.size === input.size) {
        if (!indexed || indexed.state !== "ready" || indexed.sha256 !== existingSha256) {
          await upsertObject(c.env, {
            key: input.key,
            kind: "nar",
            etag: existing.httpEtag,
            sha256: existingSha256,
            size: existing.size,
            state: "ready",
          });
        }
        return c.json({ uploadId: null, key: input.key, size: input.size, sha256: input.sha256, etag: existing.httpEtag, alreadyExists: true }, 200);
      }
      throw new AppError("immutable_conflict", "An object with this key already exists with different or unindexed content", 409);
    }

    const stale = await expireStaleUploadSession(c.env, input.key, owner);
    if (stale.blocked) throw new AppError("upload_in_progress", "Another upload for this object is in progress", 409);
    const active = stale.session;
    if (active) {
      if (active.expected_size !== input.size || active.expected_sha256 !== input.sha256) {
        throw new AppError("upload_in_progress", "A different direct upload for this object is already in progress", 409);
      }
      const ttl = Math.max(1, Math.ceil((Date.parse(active.expires_at) - Date.now()) / 1000));
      const presigned = await createPresignedPut(c.env, active.staging_key, Math.min(ttl, directUploadTtl(c.env)));
      return c.json(sessionResponse(active, presigned), 200);
    }

    const created = await createUploadSession(c.env, input);
    return c.json(sessionResponse(created.session, created.presigned), 201);
  } finally {
    await releaseObjectWrite(c.env, input.key, owner);
  }
});

uploadRoutes.post("/api/uploads/:uploadId/complete", requireRole("write"), async (c) => {
  const id = c.req.param("uploadId");
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AppError("upload_session_not_found", "The direct-upload session was not found", 404);
  const result = await completeUploadSession(c.env, id);
  return c.json({
    uploadId: result.session.id,
    key: result.session.r2_key,
    status: "completed",
    etag: result.object.httpEtag,
    size: result.object.size,
    sha256: result.sha256,
    duplicate: result.duplicate,
  }, result.duplicate ? 200 : 201);
});
