import { Hono } from "hono";
import type { AppEnv } from "../env";
import { AppError } from "../domain/errors";
import { kindForKey, normalizeKeyFromUrl } from "../domain/keys";
import { getSetting } from "../storage/db";
import { getObjectResponse, putImmutableObject } from "../storage/r2";
import { requireRole } from "../middleware/auth";
import { handleNarinfoPut } from "./narinfo";
import { emitWorkerCacheHit, matchWorkerCache, responseForRequestMethod, scheduleWorkerCachePut } from "../storage/worker-cache";
import { directDownloadTtl } from "../storage/presign";

export const cacheRoutes = new Hono<AppEnv>();

cacheRoutes.on(["GET", "HEAD"], "/nix-cache-info", async (c) => {
  const generation = await getSetting(c.env, "worker_cache_generation") ?? "0";
  const cached = await matchWorkerCache(c.req.raw, generation);
  if (cached) {
    emitWorkerCacheHit("nix-cache-info", "cache-info", c.req.raw, cached);
    return responseForRequestMethod(cached, c.req.method);
  }
  const storeDir = await getSetting(c.env, "store_dir") ?? c.env.DEFAULT_STORE_DIR ?? "/nix/store";
  const priority = await getSetting(c.env, "priority") ?? c.env.DEFAULT_PRIORITY ?? "40";
  const wantMassQuery = await getSetting(c.env, "want_mass_query") ?? c.env.DEFAULT_WANT_MASS_QUERY ?? "1";
  const body = `StoreDir: ${storeDir}\nWantMassQuery: ${wantMassQuery}\nPriority: ${priority}\n`;
  const headers = new Headers({
    "Cache-Control": "public, max-age=300",
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": String(new TextEncoder().encode(body).byteLength),
  });
  const response = new Response(c.req.method === "HEAD" ? null : body, { status: 200, headers });
  scheduleWorkerCachePut(c.executionCtx, c.req.raw, response, generation);
  return response;
});

cacheRoutes.on(["GET", "HEAD"], "/*", async (c) => {
  const key = normalizeKeyFromUrl(new URL(c.req.url));
  const kind = kindForKey(key);
  if (kind === "cache-info") throw new AppError("not_found", "The cache information route was not found", 404);
  const directDownloads = directDownloadTtl(c.env) !== null;
  const generation = await getSetting(c.env, "worker_cache_generation") ?? "0";
  if (!directDownloads) {
    const cached = await matchWorkerCache(c.req.raw, generation);
    if (cached) {
      emitWorkerCacheHit(key, kind, c.req.raw, cached);
      return responseForRequestMethod(cached, c.req.method);
    }
  }
  const response = await getObjectResponse(c.env, c.req.raw, key, kind);
  if (!directDownloads) scheduleWorkerCachePut(c.executionCtx, c.req.raw, response, generation);
  return response;
});

cacheRoutes.put("/*", requireRole("write"), async (c) => {
  const key = normalizeKeyFromUrl(new URL(c.req.url));
  const kind = kindForKey(key);
  if (kind === "cache-info") throw new AppError("method_not_allowed", "The cache information document is read-only", 405);
  if (kind === "narinfo") return handleNarinfoPut(c);
  const result = await putImmutableObject(c.env, key, kind, c.req.raw);
  if (result.duplicate) return new Response(null, { status: 204, headers: { ETag: result.object.httpEtag } });
  return new Response(null, { status: 201, headers: { ETag: result.object.httpEtag, "Content-Length": "0" } });
});
