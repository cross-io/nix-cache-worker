import { AppError } from "./errors";

export type ObjectKind = "nar" | "narinfo" | "cache-info";

export function normalizeKeyFromUrl(url: URL): string {
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    throw new AppError("invalid_path", "The URL path is not valid UTF-8", 400);
  }
  if (pathname.includes("\0") || pathname.includes("..")) {
    throw new AppError("invalid_path", "The cache path is invalid", 400);
  }
  const key = pathname.replace(/^\/+/, "");
  if (!key || key.length > 1024) throw new AppError("invalid_path", "The cache path is invalid", 400);
  return key;
}

export function kindForKey(key: string): ObjectKind {
  if (key === "nix-cache-info") return "cache-info";
  if (key.startsWith("nar/") && key.length > 4) return "nar";
  if (/^[A-Za-z0-9._~-]+\.narinfo$/.test(key)) return "narinfo";
  throw new AppError("invalid_path", "The path is not a supported Nix cache object", 404);
}

export function cacheControlFor(kind: ObjectKind, maxAgeSeconds?: number): string {
  if (kind === "nar") return `public, max-age=${maxAgeSeconds ?? 31536000}${maxAgeSeconds === undefined || maxAgeSeconds > 0 ? ", immutable" : ""}`;
  if (kind === "narinfo") return `public, max-age=${maxAgeSeconds ?? 31536000}, immutable`;
  return `public, max-age=${maxAgeSeconds ?? 300}`;
}

export function contentTypeFor(kind: ObjectKind): string {
  if (kind === "narinfo") return "text/x-nix-narinfo; charset=utf-8";
  if (kind === "cache-info") return "text/plain; charset=utf-8";
  return "application/octet-stream";
}
