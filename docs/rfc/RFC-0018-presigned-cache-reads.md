# RFC-0018: presigned cache reads

- Status: Superseded by RFC-0021
- Date: 2026-09-20

## Context

RFC-0021 replaces the optional, metadata-sensitive redirect mode with a fixed
best-effort read path. This RFC remains historical context only; its fallback,
TTL, and metadata guidance is no longer operational.

R2 is the source of truth for immutable cache bytes, but serving every NAR and
narinfo through the Worker makes the Worker a data-plane hop. A short-lived R2
S3 presigned URL can safely give a cache client direct access to one immutable
cache-object key without disclosing R2 credentials.

The standard Nix HTTP upload protocol cannot use the same mechanism
transparently. A `307` response to an HTTP PUT still requires the original
request to reach the Worker, and stock `nix copy --to` has no upload-session
discovery step. Large publishing therefore remains the explicit direct-upload
API from RFC-0016.

## Goals and non-goals

Goals:

- optionally redirect supported NAR and narinfo GET/HEAD requests to short-lived
  R2 S3 presigned URLs;
- preserve Nix GET, HEAD, Range, ETag, and conditional-read compatibility by
  forwarding those requests to R2;
- keep the Worker out of the cache-byte download path when configured;
- avoid caching bearer URLs at the Worker or CDN.

Non-goals:

- replacing the standard Nix PUT protocol;
- exposing R2 credentials or an object-listing capability to cache clients;
- making arbitrary R2 keys or staging objects publicly reachable.

## Design

When `DIRECT_DOWNLOAD_URL_TTL_SECONDS` is configured, the Worker validates the
public cache path, signs a GET or HEAD URL for that one R2 key, and responds
with `307 Temporary Redirect`, `Location`, and
`Cache-Control: no-store`. The signature covers the method and R2 host. Range
and HTTP conditional headers are deliberately not signed, so the client can
forward them to R2, which supplies the final cache-object response. Because
R2's S3 `HEAD` does not apply `Range`, HEAD requests with a Range header remain
on the binding-backed path to preserve `206`, `Content-Range`, and
`Content-Length` semantics.

The Worker does not consult or populate `caches.default` for a redirect. It
does not make D1 readiness part of the direct-read decision: a cache object
whose stored R2 metadata is `Cache-Control: no-store` receives a redirect, and
R2 returns the authoritative final response. Missing and legacy-metadata
objects use the binding-backed path. Staging keys and arbitrary R2 keys are not
valid cache paths and remain unreachable through this route.

The setting is optional. Deployments without it retain binding-backed Worker
read responses. Enabling it requires the same bucket-scoped R2 S3 read/write
credentials already used for direct uploads.

R2 object metadata uses `Cache-Control: no-store`. Objects uploaded before
this feature retain their existing metadata and remain on the binding-backed
path, where the Worker calculates retention-aware response policy at read time.
Direct R2 reads therefore cannot cache bytes beyond a policy update or
deletion, and enabling the setting requires no metadata-rewrite migration.

## Invariants and security

- R2 remains the source of truth for object existence and bytes; the redirect
  path does not depend on an asynchronously replicated D1 read.
- URLs are bearer credentials, have a bounded TTL, and are never logged.
- Redirect responses are explicitly non-cacheable so a proxy cannot replay an
  expired signed URL.
- No R2 object bytes, S3 access key, secret key, or raw Authorization header
  are included in structured Worker logs.
- Upload behavior is unchanged: stock Nix PUT remains supported for ordinary
  objects, while large NAR publishing uses RFC-0016's session API.

## Compatibility and migration

No D1 migration is necessary. Set `DIRECT_DOWNLOAD_URL_TTL_SECONDS` to an
integer from 60 seconds through seven days, deploy, and verify that the chosen
Nix client follows HTTPS redirects. Existing deployments may omit the setting
to retain Worker-proxied reads.

## Acceptance tests

- a ready indexed object produces a method-specific 307 R2 URL;
- the URL contains no R2 secret and the redirect is `no-store`;
- the Worker returns the final 404 for missing cache objects;
- unit tests retain the binding-backed read path when the setting is absent;
- the real Nix integration test reads both the standard small upload and the
  direct large upload through the configured redirect path, and verifies the
  direct large-NAR GET/HEAD redirect, Range, and ETag conditional responses.

## Implementation notes

Implemented in `src/storage/presign.ts`, `src/storage/r2.ts`, and
`src/routes/cache.ts`. The integration Worker enables a five-minute URL TTL;
production templates default to fifteen minutes.
