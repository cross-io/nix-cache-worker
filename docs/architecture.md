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

The same metadata is used by direct final-key uploads. The R2 Custom Domain
should use a Cache Rule covering `/nix-cache-info`, `/*.narinfo`, and `/nar/*`
with a long edge TTL and cached 404s. Deletion does not bump a generation or
invalidate edge caches. A CDN, presigned URL, or client may therefore return a
stale object after deletion; this is intentional best-effort behavior.

`/nix-cache-info` is generated from Wrangler variables by the Worker. For an
R2 Custom Domain, deployment writes the same bytes to the `nix-cache-info` R2
object. It is not stored in D1 and is not part of retention or GC.

## Uploads

Normal Nix PUTs stream one conditional write to the final key and then upsert
the D1 object index. A same-content replay is idempotent; different content is
an immutable conflict. A narinfo PUT first verifies that its referenced NAR is
ready in both R2 and D1, then atomically creates `narinfo_refs` and increments
the NAR's `narinfo_ref_count`.

Large NARs use a stateless final-key flow:

1. `POST /api/uploads` validates key, size, and SHA-256 and returns a
   presigned PUT for the final `nar/<...>` key.
2. CI sends one PUT with `If-None-Match: *` and the returned headers.
3. `POST /api/uploads/complete` performs R2 `HEAD`, streams R2 `GET` to hash
   the object, and upserts `objects` after verification.

There are no staging keys, upload sessions, staging cleanup jobs, or
`_nix_uploads/` objects in the new deployment. A wrong digest or size deletes
the final object before returning an error.

## D1 lifecycle model

The single migration creates `objects`, `narinfo_refs`, package/version
membership, retention policies, jobs, `job_object_items`, GC snapshots, and
audit metadata. `objects` stores both `narinfo_ref_count` and
`version_member_count`, so GC does not need a per-object `COUNT(*)` scan.

Membership changes and counter changes use the same D1 batch. A NAR can enter
the deletion state only while it is ready and `narinfo_ref_count = 0`. R2
deletion and final D1 cleanup are independent retryable job steps. If a job is
interrupted after a D1 state transition or an R2 delete, retrying is safe.

Versions are identified by `(package_name, version_name)`; names are opaque.
Retention and pinning are used only by GC and never affect HTTP response TTLs.
`DEFAULT_RETENTION_DAYS` is a Worker variable rather than a D1 setting.

## Admin and observability

The admin console manages versions, policies, pins, and GC. Deployment values
are changed with Wrangler and redeployed; there is no settings table or
settings API. Worker logs emit safe structured `cache_hit`, `cache_miss`,
`r2_get`, `r2_put`, `bytes_served`, `upload_bytes`, and `auth_failure` events.
Tokens and raw authorization headers are never logged.
