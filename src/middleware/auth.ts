import { createMiddleware } from "hono/factory";
import type { MiddlewareHandler } from "hono";
import type { AppEnv, Bindings } from "../env";

export type Role = "anonymous" | "read" | "write" | "admin";

const roleRank: Record<Role, number> = {
  anonymous: 0,
  read: 1,
  write: 2,
  admin: 3,
};

const missingSecretWarnings = new Set<string>();
const encoder = new TextEncoder();

// The standard DOM lib does not yet declare Cloudflare's Worker-specific API.
// @cloudflare/workers-types does, but Vitest also brings its DOM declaration.
interface WorkerSubtleCrypto extends SubtleCrypto {
  timingSafeEqual(a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView): boolean;
}

async function secureEqual(left: string, right: string): Promise<boolean> {
  // Hashing first fixes both operands to the same length before using the
  // Workers-provided constant-time primitive, so token length is not exposed.
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  return (crypto.subtle as WorkerSubtleCrypto).timingSafeEqual(leftHash, rightHash);
}

function configuredSecret(env: Bindings, name: keyof Pick<Bindings, "READ_TOKEN" | "WRITE_TOKEN" | "ADMIN_TOKEN">): string | undefined {
  const value = env[name];
  if (!value && !missingSecretWarnings.has(name)) {
    missingSecretWarnings.add(name);
    console.error(JSON.stringify({ event: "configuration_error", secret: name, message: "Authentication role disabled because its Worker Secret is missing" }));
  }
  return value;
}

export async function authenticate(request: Request, env: Bindings): Promise<Role> {
  const authorization = request.headers.get("Authorization");
  if (!authorization) return "anonymous";

  const value = authorization.trim();
  const bearer = /^Bearer\s+(.+)$/i.exec(value);
  let token: string | undefined = bearer?.[1];

  // Nix's stock HTTP uploader reads credentials from netrc and sends them as
  // Basic authentication. The password is still the Worker Secret token.
  if (!token) {
    const basic = /^Basic\s+(.+)$/i.exec(value);
    if (basic) {
      try {
        const decoded = atob(basic[1]);
        const separator = decoded.indexOf(":");
        if (separator >= 0) token = decoded.slice(separator + 1);
      } catch {
        return "anonymous";
      }
    }
  }
  if (!token) return "anonymous";

  const admin = configuredSecret(env, "ADMIN_TOKEN");
  const write = configuredSecret(env, "WRITE_TOKEN");
  const read = configuredSecret(env, "READ_TOKEN");
  const [isAdmin, isWrite, isRead] = await Promise.all([
    admin ? secureEqual(token, admin) : false,
    write ? secureEqual(token, write) : false,
    read ? secureEqual(token, read) : false,
  ]);
  if (isAdmin) return "admin";
  if (isWrite) return "write";
  if (isRead) return "read";
  return "anonymous";
}

export const authMiddleware: MiddlewareHandler<AppEnv> = createMiddleware<AppEnv>(async (c, next) => {
  const authorization = c.req.header("Authorization");
  const role = await authenticate(c.req.raw, c.env);
  if (authorization && role === "anonymous") {
    throw new AuthError("invalid_token", "The authorization credential is invalid", 401);
  }
  c.set("role", role);
  await next();
});

export function requireRole(required: Exclude<Role, "anonymous">): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    const role = c.get("role") ?? "anonymous";
    if (roleRank[role] < roleRank[required]) {
      throw new AuthError("insufficient_permission", "The token does not have sufficient permission", 403);
    }
    await next();
  });
}

/** Require cache-read authentication only when READ_TOKEN is configured. */
export function requireCacheRead(): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (c.env.READ_TOKEN && roleRank[c.get("role") ?? "anonymous"] < roleRank.read) {
      throw new AuthError("read_auth_required", "A read token is required for cache reads", 401);
    }
    await next();
  });
}

export class AuthError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: 401 | 403) {
    super(message);
    this.name = "AuthError";
  }
}
