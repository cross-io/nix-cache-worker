import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { AppError } from "../domain/errors";
import { requireRole } from "../middleware/auth";
import { completeDirectUpload, issueDirectUpload, validateDirectUploadInput } from "../storage/uploads";

export const uploadRoutes = new Hono<AppEnv>();

async function parseJSON(c: Context<AppEnv>): Promise<unknown> {
  return c.req.json<unknown>().catch(() => {
    throw new AppError("invalid_json", "The request body must be JSON", 400);
  });
}

uploadRoutes.post("/api/uploads", requireRole("write"), async (c) => {
  const input = validateDirectUploadInput(await parseJSON(c));
  const result = await issueDirectUpload(c.env, input);
  return c.json(result, result.alreadyExists ? 200 : 201);
});

uploadRoutes.post("/api/uploads/complete", requireRole("write"), async (c) => {
  const input = validateDirectUploadInput(await parseJSON(c));
  const result = await completeDirectUpload(c.env, input);
  return c.json({
    key: input.key,
    status: "completed",
    etag: result.object.httpEtag,
    size: result.object.size,
    sha256: result.sha256,
    duplicate: result.duplicate,
  }, result.duplicate ? 200 : 201);
});
