# AGENTS.md

## Project purpose

Nix Cache Worker is a Cloudflare Worker that implements a Nix HTTP binary cache backed by Cloudflare R2 and Cloudflare D1.

The project is a storage target for CI-driven package publishing. CI builds packages and uploads cache objects; this Worker does not build packages, schedule builds, or implement release orchestration.

## Architecture invariants

- R2 is the source of truth for cache object bytes.
- D1 stores object indexes, package/version membership, tags, retention policy, pin state, GC state, and audit metadata.
- Worker Secrets are the only source of bearer-token values.
- Cache object bytes are immutable after a successful upload.
- Artifact-set metadata and membership may be updated through authorized APIs without replacing object bytes.
- A `.narinfo` must not be accepted unless its referenced NAR exists and is indexed.
- Shared NAR payloads must not be deleted while a live narinfo still references them.
- Packages contain versions, and versions are identified by `(packageName, versionName)`. Version names are required but opaque and never parsed for ordering.
- `keepLatestVersions` ordering is based on `registered_at`, independently within each package and selector, never on version parsing.
- Hono is the HTTP routing and middleware layer; domain, storage, and job modules should use plain function interfaces when they do not need Hono context.

## Authentication and security

- Use `Authorization: Bearer <token>` for authenticated API requests. Also support Nix netrc-generated HTTP Basic credentials where the password matches the Worker Secret; document this as an HTTPS-only compatibility form.
- Keep `READ_TOKEN`, `WRITE_TOKEN`, and `ADMIN_TOKEN` in Worker Secrets.
- Never put token values in source code, D1, URLs, cookies, test snapshots, or logs.
- Never log raw `Authorization` headers.
- Anonymous cache reads are intentional; cache writes and management operations require the appropriate token.
- The management console may hold a validated admin token in same-origin `sessionStorage` for the current browser tab. It must never use `localStorage`, cookies, or cross-tab/server persistence.
- Do not add a Cloudflare API credential merely to let the application rewrite its own Worker bindings or Secrets.

## Cache compatibility

All cache changes must preserve direct compatibility with `nix copy --from`
reads. Publishing stays compatible through `bin/nix-cache-upload` and
authenticated narinfo PUTs; ordinary NAR PUT is intentionally rejected (see
RFC-0022).

Maintain support for:

- `GET` and `HEAD` cache requests.
- NAR byte ranges.
- ETag, `If-None-Match`, and `If-Match` semantics.
- Accurate `Content-Length` and `Content-Range` headers.
- Standard `/nix-cache-info`, `.narinfo`, and `/nar/*` paths.
- Authenticated `.narinfo` PUTs through the Worker; NAR payloads use the
  staging direct-upload session flow (`POST /api/uploads`, PUT to
  `_nix_uploads/<uploadId>`, `POST /api/uploads/<uploadId>/complete`).
  Ordinary `PUT /nar/*` returns `405 direct_upload_required`.

Do not introduce a custom upload protocol beyond the staging direct-upload
API as a prerequisite for normal Nix cache operation.

## Immutability and consistency

- A same-content repeated PUT may complete idempotently.
- A different-content PUT must never overwrite an existing object.
- Conditional request failures must be reported with the correct HTTP precondition status.
- Uploading a narinfo before its NAR is available must fail in strict consistency mode.
- Retries and direct-upload completion must not create duplicate or partially visible cache objects.

## Artifact sets, policies, and GC

- Treat packages as grouping containers and versions as named groups of cache objects with arbitrary tags.
- Require a version identity but do not parse software version formats.
- Version-level retention overrides matching policy durations; keep-latest protection comes from matching selectors.
- Matching policies use package, version, and tag glob patterns.
- Pinned versions are protected from automatic GC only.
- An explicit administrator deletion may remove a pinned version after confirmation and audit logging.
- Deleting a version must remove its membership metadata and only delete narinfo/NAR objects that have no remaining live references.
- GC must be bounded and retryable so one large set cannot exceed Worker or D1 execution limits.
- Persistent jobs must be safe to resume after a Worker interruption; R2 deletion and D1 cleanup must be independently retryable.

## Observability

Do not add a Prometheus server or a `/metrics` endpoint for the v1 design. Emit structured Worker log events for:

- `cache_hit`
- `cache_miss`
- `r2_get`
- `r2_put`
- `bytes_served`
- `upload_bytes`
- `auth_failure`

Include safe request, status, object-kind, and byte-count fields. Exclude tokens and authorization headers.

## Documentation and code style

- Repository documentation and code comments must be written in English.
- Keep the public behavior documented in `README.md` synchronized with the implementation.
- Every behavior, protocol, schema, retention, GC, deployment, or security
  change must add or update a numbered English RFC under `docs/rfc/` before
  implementation. Follow `docs/rfc/README.md` and record the final status and
  any implementation deviations.
- Keep architecture and operator instructions in `docs/architecture.md` and
  `docs/configuration.md` when they would otherwise overload `README.md`.
- Prefer small, explicit modules for authentication, HTTP cache semantics, R2 access, D1 indexing, package/version management, and GC.
- Avoid adding dependencies when a platform API or small local helper is sufficient.
- Keep `migrations/*.sql` forward-only and apply schema changes through Wrangler D1 migrations.

## Validation requirements

Changes affecting cache behavior should include tests for the relevant scenarios:

- Anonymous, read-token, write-token, admin-token, and Nix netrc/Basic permissions.
- GET, HEAD, Range, ETag, conditional requests, and Content-Length.
- Same-content idempotent PUT and different-content conflict.
- Missing-NAR rejection for narinfo upload.
- Direct-upload completion and retry behavior.
- Package/version registration idempotency and arbitrary tags.
- Glob selector matching and `keepLatestVersions` ordering by `registered_at` per package.
- Pin protection during automatic GC.
- Confirmed manual deletion of pinned versions.
- Shared-NAR reference protection.
- Structured metrics/log event emission without credential leakage.
- Persistent GC/delete job recovery after a stale or failed runner.

## Deployment

The supported deployment command is:

```bash
npx wrangler deploy
```

R2 bindings, D1 bindings, Cron triggers, and Worker Secrets are deployment configuration. The web console may manage runtime policy and package/version data, but must not be treated as a replacement for Wrangler or the Cloudflare Dashboard when configuring bindings or Secrets.

Useful local commands:

```bash
npm run dev
npm run typecheck
npm test
npm run build
```
