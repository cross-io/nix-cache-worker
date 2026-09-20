import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { AppError } from "../domain/errors";
import { parseNarInfo } from "../domain/narinfo";
import { kindForKey, normalizeKeyFromUrl } from "../domain/keys";
import { requireRole } from "../middleware/auth";
import { getObject, now } from "../storage/db";
import { putImmutableObject } from "../storage/r2";

export const narinfoRoutes = new Hono<AppEnv>();

export async function handleNarinfoPut(c: Context<AppEnv>): Promise<Response> {
  const key = normalizeKeyFromUrl(new URL(c.req.url));
  if (kindForKey(key) !== "narinfo") throw new AppError("invalid_path", "The narinfo route only accepts .narinfo objects", 404);
  const bodyCopy = c.req.raw.clone();
  const parsed = parseNarInfo(await bodyCopy.text());
  const narObject = await c.env.CACHE_BUCKET.head(parsed.narKey);
  const narIndex = await getObject(c.env, parsed.narKey);
  if (!narObject || !narIndex || narIndex.kind !== "nar" || narIndex.state !== "ready") {
    throw new AppError("missing_nar_dependency", "The narinfo references a missing NAR", 424, { narKey: parsed.narKey });
  }

  const result = await putImmutableObject(c.env, key, "narinfo", c.req.raw);
  const timestamp = now();
  const transaction = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO narinfo_refs (narinfo_key, nar_key, store_path, created_at)
       SELECT ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM objects WHERE r2_key = ? AND kind = 'nar' AND state = 'ready')
       ON CONFLICT(narinfo_key) DO NOTHING`,
    ).bind(key, parsed.narKey, parsed.storePath, timestamp, parsed.narKey),
    c.env.DB.prepare(
      `UPDATE objects SET narinfo_ref_count = narinfo_ref_count + 1
       WHERE r2_key = ? AND kind = 'nar' AND state = 'ready' AND changes() = 1`,
    ).bind(parsed.narKey),
  ]);
  if ((transaction[0]?.meta.changes ?? 0) === 0) {
    const existingRef = await c.env.DB.prepare("SELECT nar_key FROM narinfo_refs WHERE narinfo_key = ?").bind(key).first<{ nar_key: string }>();
    if (!existingRef || existingRef.nar_key !== parsed.narKey) {
      throw new AppError("narinfo_reference_failed", "The narinfo dependency changed before its reference was recorded", 409);
    }
  } else if ((transaction[1]?.meta.changes ?? 0) !== 1) {
    throw new AppError("narinfo_reference_failed", "The NAR reference counter could not be updated", 409);
  }
  return new Response(null, { status: result.duplicate ? 204 : 201, headers: { ETag: result.object.httpEtag } });
}

narinfoRoutes.put("/*", requireRole("write"), handleNarinfoPut);
