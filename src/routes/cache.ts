import { Hono } from "hono";
import type { AppEnv } from "../env";
import { AppError } from "../domain/errors";
import { cacheControlFor, kindForKey, normalizeKeyFromUrl } from "../domain/keys";
import { requireCacheRead, requireRole } from "../middleware/auth";
import { getObjectResponse } from "../storage/r2";
import { handleNarinfoPut } from "./narinfo";
import { emitWorkerCacheHit, matchWorkerCache, responseForRequestMethod, scheduleWorkerCachePut } from "../storage/worker-cache";

export const cacheRoutes = new Hono<AppEnv>();

function cacheInfoVariant(env: AppEnv["Bindings"]): string {
  return [
    env.DEFAULT_STORE_DIR ?? "/nix/store",
    env.DEFAULT_WANT_MASS_QUERY ?? "1",
    env.DEFAULT_PRIORITY ?? "40",
  ].join("\u0000");
}

cacheRoutes.use("/*", requireCacheRead());

cacheRoutes.on(["GET", "HEAD"], "/nix-cache-info", async (c) => {
  const storeDir = c.env.DEFAULT_STORE_DIR ?? "/nix/store";
  const priority = c.env.DEFAULT_PRIORITY ?? "40";
  const wantMassQuery = c.env.DEFAULT_WANT_MASS_QUERY ?? "1";
  const body = `StoreDir: ${storeDir}\nWantMassQuery: ${wantMassQuery}\nPriority: ${priority}\n`;
  const variant = cacheInfoVariant(c.env);
  const cached = await matchWorkerCache(c.req.raw, variant);
  if (cached) {
    emitWorkerCacheHit("nix-cache-info", "cache-info", c.req.raw, cached);
    return responseForRequestMethod(cached, c.req.method);
  }
  const headers = new Headers({
    "Cache-Control": cacheControlFor("cache-info"),
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": String(new TextEncoder().encode(body).byteLength),
  });
  const response = new Response(c.req.method === "HEAD" ? null : body, { status: 200, headers });
  scheduleWorkerCachePut(c.executionCtx, c.req.raw, response, variant);
  return response;
});

cacheRoutes.on(["GET", "HEAD"], "/*", async (c) => {
  const key = normalizeKeyFromUrl(new URL(c.req.url));
  const kind = kindForKey(key);
  if (kind === "cache-info") throw new AppError("not_found", "The cache information route was not found", 404);
  return getObjectResponse(c.env, c.req.raw, key, kind);
});

cacheRoutes.put("/*", requireRole("write"), async (c) => {
  const key = normalizeKeyFromUrl(new URL(c.req.url));
  const kind = kindForKey(key);
  if (kind === "cache-info") throw new AppError("method_not_allowed", "The cache information document is read-only", 405);
  if (kind === "narinfo") return handleNarinfoPut(c);
  throw new AppError("direct_upload_required", "NAR objects must be uploaded through the direct-upload API", 405);
});
