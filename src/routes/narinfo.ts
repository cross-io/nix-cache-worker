import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { AppError } from "../domain/errors";
import { parseNarInfo } from "../domain/narinfo";
import { kindForKey, normalizeKeyFromUrl } from "../domain/keys";
import { requireRole } from "../middleware/auth";
import { now, upsertObject } from "../storage/db";
import { putImmutableObject } from "../storage/r2";

export const narinfoRoutes = new Hono<AppEnv>();

const RESERVATION_GRACE_MS = 15 * 60_000;

async function reserveNarinfoReference(c: Context<AppEnv>, key: string, narKey: string, storePath: string): Promise<void> {
  const timestamp = now();
  const transaction = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT OR IGNORE INTO objects (r2_key, kind, etag, sha256, size, uploaded_at, state, narinfo_ref_count, version_member_count)
       VALUES (?, 'narinfo', '', NULL, 0, ?, 'pending', 0, 0)`,
    ).bind(key, timestamp),
    c.env.DB.prepare(
      `INSERT INTO narinfo_refs (narinfo_key, nar_key, store_path, created_at)
       SELECT ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM objects WHERE r2_key = ? AND kind = 'nar' AND state = 'ready')
         AND EXISTS (SELECT 1 FROM objects WHERE r2_key = ? AND kind = 'narinfo' AND state IN ('pending', 'ready'))
       ON CONFLICT(narinfo_key) DO NOTHING`,
    ).bind(key, narKey, storePath, timestamp, narKey, key),
    c.env.DB.prepare(
      `UPDATE objects SET narinfo_ref_count = narinfo_ref_count + 1
       WHERE r2_key = ? AND kind = 'nar' AND state = 'ready' AND changes() = 1`,
    ).bind(narKey),
  ]);
  if ((transaction[1]?.meta.changes ?? 0) === 1) {
    if ((transaction[2]?.meta.changes ?? 0) !== 1) throw new AppError("narinfo_reference_failed", "The NAR reference counter could not be updated", 409);
    return;
  }
  const existingRef = await c.env.DB.prepare("SELECT nar_key FROM narinfo_refs WHERE narinfo_key = ?").bind(key).first<{ nar_key: string }>();
  if (!existingRef || existingRef.nar_key !== narKey) {
    await c.env.DB.prepare(
      "DELETE FROM objects WHERE r2_key = ? AND state = 'pending' AND NOT EXISTS (SELECT 1 FROM narinfo_refs WHERE narinfo_key = ?)",
    ).bind(key, key).run();
    throw new AppError("missing_nar_dependency", "The narinfo references a missing or deleting NAR", 424, { narKey });
  }
  // Retrying a pending request renews its lease before it touches R2. The
  // cleanup batch compares this timestamp, so it cannot reclaim a live retry.
  await c.env.DB.prepare(
    `UPDATE objects SET uploaded_at = ?
     WHERE r2_key = ? AND state = 'pending'
       AND EXISTS (SELECT 1 FROM narinfo_refs WHERE narinfo_key = ? AND nar_key = ?)`,
  ).bind(timestamp, key, key, narKey).run();
}

/**
 * A failed PUT deliberately leaves its short-lived reservation in place. That
 * makes a competing request safe: no request can remove the NAR reference
 * while another worker may already have written the final narinfo bytes. Cron
 * makes reservations eligible for reclamation after the maximum job-staleness
 * window. The next scheduled maintenance run performs the bounded cleanup.
 */
export async function cleanupExpiredNarinfoReservations(env: AppEnv["Bindings"]): Promise<void> {
  const cutoff = new Date(Date.now() - RESERVATION_GRACE_MS).toISOString();
  const pending = await env.DB.prepare(
    `SELECT ni.r2_key AS narinfo_key, r.nar_key
     FROM objects ni JOIN narinfo_refs r ON r.narinfo_key = ni.r2_key
     WHERE ni.kind = 'narinfo' AND ni.state = 'pending' AND ni.uploaded_at < ?
     ORDER BY ni.uploaded_at LIMIT 100`,
  ).bind(cutoff).all<{ narinfo_key: string; nar_key: string }>();
  for (const reservation of pending.results) {
    const object = await env.CACHE_BUCKET.head(reservation.narinfo_key);
    if (object) {
      const body = await env.CACHE_BUCKET.get(reservation.narinfo_key);
      let parsedNarKey: string | null = null;
      if (body?.body) {
        try {
          parsedNarKey = parseNarInfo(await new Response(body.body).text()).narKey;
        } catch {
          parsedNarKey = null;
        }
      }
      const referencedNar = parsedNarKey === reservation.nar_key
        ? await env.DB.prepare("SELECT r2_key FROM objects WHERE r2_key = ? AND kind = 'nar' AND state = 'ready'").bind(parsedNarKey).first()
        : null;
      if (referencedNar) {
        // A terminated worker may have stored R2 bytes before it could finish
        // D1 indexing. Publish only bytes that prove they use the reservation's
        // still-ready NAR; unknown final-key bytes remain unindexed.
        if (!await upsertObject(env, {
          key: reservation.narinfo_key,
          kind: "narinfo",
          etag: object.httpEtag,
          sha256: null,
          size: object.size,
          state: "ready",
        })) continue;
        continue;
      }
    }
    await discardExpiredNarinfoReservation(env, reservation, cutoff);
  }
}

async function discardExpiredNarinfoReservation(
  env: AppEnv["Bindings"],
  reservation: { narinfo_key: string; nar_key: string },
  cutoff: string,
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE objects SET narinfo_ref_count = MAX(0, narinfo_ref_count - 1)
       WHERE r2_key = ? AND kind = 'nar' AND EXISTS (
         SELECT 1 FROM narinfo_refs r JOIN objects ni ON ni.r2_key = r.narinfo_key
         WHERE r.narinfo_key = ? AND r.nar_key = ? AND ni.state = 'pending' AND ni.uploaded_at < ?
       )`,
    ).bind(reservation.nar_key, reservation.narinfo_key, reservation.nar_key, cutoff),
    env.DB.prepare(
      `DELETE FROM narinfo_refs WHERE narinfo_key = ? AND nar_key = ?
       AND EXISTS (SELECT 1 FROM objects WHERE r2_key = ? AND state = 'pending' AND uploaded_at < ?)`,
    ).bind(reservation.narinfo_key, reservation.nar_key, reservation.narinfo_key, cutoff),
    env.DB.prepare(
      "DELETE FROM objects WHERE r2_key = ? AND state = 'pending' AND uploaded_at < ? AND NOT EXISTS (SELECT 1 FROM narinfo_refs WHERE narinfo_key = ?)",
    ).bind(reservation.narinfo_key, cutoff, reservation.narinfo_key),
  ]);
}

export async function handleNarinfoPut(c: Context<AppEnv>): Promise<Response> {
  const key = normalizeKeyFromUrl(new URL(c.req.url));
  if (kindForKey(key) !== "narinfo") throw new AppError("invalid_path", "The narinfo route only accepts .narinfo objects", 404);
  const bodyCopy = c.req.raw.clone();
  const parsed = parseNarInfo(await bodyCopy.text());
  await reserveNarinfoReference(c, key, parsed.narKey, parsed.storePath);
  const narObject = await c.env.CACHE_BUCKET.head(parsed.narKey);
  if (!narObject) {
    throw new AppError("missing_nar_dependency", "The narinfo references a missing NAR", 424, { narKey: parsed.narKey });
  }
  const result = await putImmutableObject(c.env, key, "narinfo", c.req.raw, { allowPending: true });
  return new Response(null, { status: result.duplicate ? 204 : 201, headers: { ETag: result.object.httpEtag } });
}

narinfoRoutes.put("/*", requireRole("write"), handleNarinfoPut);
