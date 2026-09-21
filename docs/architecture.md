# Architecture

Nix Cache Worker is deliberately split into a cheap read plane and an
authenticated management plane. R2 is authoritative for bytes; D1 is an
index and lifecycle control plane. Public object reads never query D1.

## Request paths

```text
Anonymous Nix read (READ_TOKEN empty)
  ├─ R2 Custom Domain + CDN ───────────────> R2
  └─ Worker ──307 presigned URL────────────> R2

Authenticated Nix read (READ_TOKEN set)
  Worker ──auth + 307 presigned URL─────────> R2

CI/Admin write
  Worker ──conditional PUT / D1 batch───────> R2 + D1
```

When `READ_TOKEN` is non-empty, the deployment must not expose an R2 Custom
Domain for the cache: it would bypass Worker authentication. When it is empty,
the Custom Domain is optional and is usually the lowest-cost read entry point.

The Worker validates the cache key and creates a presigned GET/HEAD URL. It
does not call D1 or R2 `HEAD` before redirecting, and it returns
`Cache-Control: no-store` on the redirect. R2 supplies the final status,
ETag, conditional response, range response, and 404. `HEAD + Range` uses a
binding fallback because some Nix clients need exact `Content-Range` metadata
before downloading. Worker Cache is used only for the generated
`/nix-cache-info` response.

## Cache objects

NAR and narinfo keys are immutable after a successful conditional R2 PUT.
They are stored with:

```text
Cache-Control: public, max-age=31536000, immutable
```

The same metadata is used by promoted staging NAR uploads. The R2 Custom Domain
should use a Cache Rule covering `/nix-cache-info`, `/*.narinfo`, and `/nar/*`
with a long edge TTL and cached 404s. `/nix-cache-info` uses a short five-minute
client cache lifetime because deployment variables can change; the edge rule
may still keep it warm. Deletion does not bump a generation or invalidate edge
caches. A CDN, presigned URL, or client may therefore return a stale object
after deletion; this is intentional best-effort behavior.

`/nix-cache-info` is generated from Wrangler variables by the Worker. For an
R2 Custom Domain, deployment writes the same bytes to the `nix-cache-info` R2
object. It is not stored in D1 and is not part of retention or GC. The Worker
Cache key includes the three public cache-info values, so a configuration change
uses a new key without reintroducing a D1 generation lookup.

## Uploads

NAR payloads use the stateful direct-upload flow:

1. `POST /api/uploads` validates the final key, size, and SHA-256, creates an
   `upload_sessions` row, and returns an `uploadId` plus a presigned PUT for
   `_nix_uploads/<uploadId>`.
2. CI uploads the bytes directly to that random staging key with
   `If-None-Match: *`.
3. `POST /api/uploads/<uploadId>/complete` reads and hashes the staging object,
   checks the final key, then conditionally streams the staging bytes to the
   immutable final NAR key and indexes it in D1.
4. Completed, failed, expired, and revoked sessions retain their staging object
   until the session expiry and are then cleaned up by bounded cron work.

Staging keys are never exposed by cache reads and never appear in `objects`.
A same-content completion retry is idempotent; different final content is an
immutable conflict. A wrong staging digest never creates a final object.
Final-key key reuse is allowed after the R2 object and D1 row have been removed.

NAR `PUT /nar/*` is deliberately rejected with `405 direct_upload_required`.
Narinfo PUT remains a Worker operation because it must parse the referenced NAR
and atomically maintain `narinfo_refs` and `narinfo_ref_count`.
The bundled `bin/nix-cache-upload` client is the supported publisher.

## D1 lifecycle model

The single migration creates `objects`, `narinfo_refs`, package/version
membership, retention policies, jobs, `job_object_items`, GC snapshots, and
audit metadata. `objects` stores both `narinfo_ref_count` and
`version_member_count`, so GC does not need a per-object `COUNT(*)` scan.

Membership changes and counter changes use the same D1 batch. A NAR can enter
the deletion state only while it is ready and `narinfo_ref_count = 0`. The
deletion job obtains the same short-lived write claim used by upload completion,
revokes issued upload sessions for the key, deletes R2, and then deletes the D1
object row. There is no tombstone and the final key may be reused after
cleanup. If a job is interrupted, the deleting row and job item remain
retryable.

Versions are identified by `(package_name, version_name)`; names are opaque.
Retention and pinning are used only by GC and never affect HTTP response TTLs.
`DEFAULT_RETENTION_DAYS` is a Worker variable rather than a D1 setting.

## Admin and observability

The admin console manages versions, policies, pins, and GC. Deployment values
are changed with Wrangler and redeployed; there is no settings table or
settings API. Worker logs emit safe structured `cache_hit`, `cache_miss`,
`r2_get`, `r2_put`, `bytes_served`, `upload_bytes`, and `auth_failure` events.
Tokens and raw authorization headers are never logged.
