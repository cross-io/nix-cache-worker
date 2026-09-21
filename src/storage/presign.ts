import type { Bindings } from "../env";
import { AppError } from "../domain/errors";

const AWS_REGION = "auto";
const AWS_SERVICE = "s3";
export const MAX_PRESIGN_SECONDS = 7 * 24 * 60 * 60;

export type PresignedPut = {
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
};

export type PresignedRead = {
  url: string;
  expiresAt: string;
};

function configuredValue(value: string | undefined, name: string): string {
  if (!value) throw new AppError("direct_upload_unconfigured", `The ${name} direct-upload setting is not configured`, 503);
  return value;
}

function endpoint(env: Bindings): URL {
  if (env.R2_S3_ENDPOINT) {
    try {
      const value = new URL(env.R2_S3_ENDPOINT);
      if (value.protocol !== "https:") throw new Error("The R2 S3 endpoint must use HTTPS");
      value.pathname = value.pathname.replace(/\/+$/, "");
      return value;
    } catch {
      throw new AppError("direct_upload_unconfigured", "The R2 S3 endpoint is invalid", 503);
    }
  }
  return new URL(`https://${configuredValue(env.R2_ACCOUNT_ID, "R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`);
}

function bucket(env: Bindings): string {
  return configuredValue(env.R2_BUCKET_NAME, "R2_BUCKET_NAME");
}

function accessKeyId(env: Bindings): string {
  return configuredValue(env.R2_S3_ACCESS_KEY_ID, "R2_S3_ACCESS_KEY_ID");
}

function secretAccessKey(env: Bindings): string {
  return configuredValue(env.R2_S3_SECRET_ACCESS_KEY, "R2_S3_SECRET_ACCESS_KEY");
}

function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalPath(env: Bindings, key: string): string {
  return `/${awsEncode(bucket(env))}/${key.split("/").map(awsEncode).join("/")}`;
}

function canonicalQuery(parameters: Array<[string, string]>): string {
  return parameters
    .map(([name, value]) => [awsEncode(name), awsEncode(value)] as const)
    .sort(([leftName, leftValue], [rightName, rightValue]) => leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

function canonicalHeaderValue(value: string): string {
  return value.trim().replace(/[\t ]+/g, " ");
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return hex(new Uint8Array(digest));
}

async function hmac(key: Uint8Array, value: string | Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    asArrayBuffer(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const input = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, asArrayBuffer(input));
  return new Uint8Array(signature);
}

function timestampParts(value: Date): { short: string; long: string } {
  const iso = value.toISOString().replace(/[-:]|\.\d{3}/g, "");
  return { short: iso.slice(0, 8), long: iso.slice(0, 15) + "Z" };
}

function clampExpiry(seconds: number): number {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_PRESIGN_SECONDS) {
    throw new AppError("invalid_upload_expiry", `The direct-upload URL expiry must be between 1 and ${MAX_PRESIGN_SECONDS} seconds`, 422);
  }
  return seconds;
}

export async function createPresignedPut(
  env: Bindings,
  key: string,
  expiresInSeconds: number,
  issuedAt = new Date(),
): Promise<PresignedPut> {
  const contentType = "application/octet-stream";
  const ifNoneMatch = "*";
  const cacheControl = "public, max-age=31536000, immutable";
  const presigned = await createPresignedRequest(env, key, "PUT", expiresInSeconds, {
    "content-type": contentType,
    "if-none-match": ifNoneMatch,
    "cache-control": cacheControl,
  }, issuedAt);
  return {
    ...presigned,
    headers: { "Content-Type": contentType, "If-None-Match": ifNoneMatch, "Cache-Control": cacheControl },
  };
}

export async function createPresignedRead(
  env: Bindings,
  key: string,
  method: "GET" | "HEAD",
  expiresInSeconds: number,
  issuedAt = new Date(),
): Promise<PresignedRead> {
  return createPresignedRequest(env, key, method, expiresInSeconds, {}, issuedAt);
}

async function createPresignedRequest(
  env: Bindings,
  key: string,
  method: "GET" | "HEAD" | "PUT",
  expiresInSeconds: number,
  requestHeaders: Record<string, string>,
  issuedAt: Date,
): Promise<PresignedRead> {
  const expires = clampExpiry(expiresInSeconds);
  const target = endpoint(env);
  const host = target.host;
  const path = canonicalPath(env, key);
  const { short, long } = timestampParts(issuedAt);
  const credential = `${accessKeyId(env)}/${short}/${AWS_REGION}/${AWS_SERVICE}/aws4_request`;
  const signedHeaderNames = ["host", ...Object.keys(requestHeaders)].sort();
  const signedHeaders = signedHeaderNames.join(";");
  const query = canonicalQuery([
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Content-Sha256", "UNSIGNED-PAYLOAD"],
    ["X-Amz-Credential", credential],
    ["X-Amz-Date", long],
    ["X-Amz-Expires", String(expires)],
    ["X-Amz-SignedHeaders", signedHeaders],
  ]);
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${canonicalHeaderValue(name === "host" ? host : requestHeaders[name] ?? "")}`)
    .join("\n") + "\n";
  const canonicalRequest = [method, path, query, canonicalHeaders, signedHeaders, "UNSIGNED-PAYLOAD"].join("\n");
  const canonicalRequestHash = await sha256(canonicalRequest);
  const scope = `${short}/${AWS_REGION}/${AWS_SERVICE}/aws4_request`;
  const dateKey = await hmac(new TextEncoder().encode(`AWS4${secretAccessKey(env)}`), short);
  const regionKey = await hmac(dateKey, AWS_REGION);
  const serviceKey = await hmac(regionKey, AWS_SERVICE);
  const signingKey = await hmac(serviceKey, "aws4_request");
  const signature = hex(await hmac(signingKey, `AWS4-HMAC-SHA256\n${long}\n${scope}\n${canonicalRequestHash}`));
  const url = `${target.origin}${path}?${query}&X-Amz-Signature=${signature}`;
  const expiresAt = new Date(issuedAt.getTime() + expires * 1000).toISOString();
  return { url, expiresAt };
}

export function directUploadTtl(env: Bindings): number {
  const configured = env.DIRECT_UPLOAD_URL_TTL_SECONDS;
  if (!configured) return 60 * 60;
  const value = Number(configured);
  if (!Number.isInteger(value) || value < 60 || value > MAX_PRESIGN_SECONDS) {
    throw new AppError("invalid_upload_expiry", `DIRECT_UPLOAD_URL_TTL_SECONDS must be between 60 and ${MAX_PRESIGN_SECONDS}`, 503);
  }
  return value;
}

export function directDownloadTtl(env: Bindings): number {
  const configured = env.DIRECT_DOWNLOAD_URL_TTL_SECONDS;
  if (!configured) return 60 * 60;
  const value = Number(configured);
  if (!Number.isInteger(value) || value < 60 || value > MAX_PRESIGN_SECONDS) {
    throw new AppError("invalid_download_expiry", `DIRECT_DOWNLOAD_URL_TTL_SECONDS must be between 60 and ${MAX_PRESIGN_SECONDS}`, 503);
  }
  return value;
}
