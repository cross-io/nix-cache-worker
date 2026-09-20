# RFC-0001: v1 architecture and compatibility baseline

- Status: Implemented
- Date: 2026-08-17

## Context

The project is a storage target for CI-driven Nix package publishing. CI is
responsible for building packages. The Worker provides the standard Nix HTTP
binary-cache protocol and an authenticated management surface.

## Goals and non-goals

The v1 service must support standard Nix clients, immutable cache objects,
public reads, authenticated writes, artifact sets, tag-based retention, pins,
bounded background deletion, and an operator UI. It must not build packages or
become a general-purpose object overwrite API.

## Design

- Hono provides routing, authentication middleware, and error responses.
- R2 is the source of truth for NAR, narinfo, and cache-info object bytes.
- D1 indexes objects and stores narinfo references, artifact-set membership,
  tags, retention policy, jobs, and audit records.
- A required arbitrary `setName` identifies an artifact set. `version` is only
  an optional tag and is never parsed for ordering.
- NAR and narinfo PUTs use immutable semantics. Equal bytes are idempotent;
  different bytes for the same key conflict.
- narinfo acceptance requires an existing and indexed referenced NAR.
- GC creates persistent jobs and deletes in bounded batches while preserving
  NARs referenced by live narinfos.

## Invariants and security

Worker Secrets are the only token source. Tokens must not appear in source,
D1, URLs, browser persistent storage, or logs. Nix netrc Basic credentials are
accepted only as an HTTPS-compatible form of the same write/read secrets.
Each supplied token is SHA-256 hashed and compared through Cloudflare Workers'
`crypto.subtle.timingSafeEqual()` primitive; authentication does not use a
language-level string comparison or return early for unequal token lengths.

The public cache surface remains compatible with `nix copy --to` and
`nix copy --from`, including GET, HEAD, Range, ETag, conditional requests, and
accurate lengths.

## Compatibility and migration

Bindings and Secrets are configured through Wrangler or the Cloudflare
Dashboard. D1 schema changes are forward-only migrations. New API behavior must
not require a custom protocol from Nix clients.

## Acceptance tests

The test suite covers HTTP cache semantics, authentication, immutable retries,
narinfo consistency, artifact sets, pins, jobs, shared-NAR protection, and
structured observability. A real Nix smoke test must exercise both upload and
download against the deployed Worker.

## Implementation notes

The baseline is implemented in `src/`, `migrations/0001_initial.sql`, and the
English product contract in `README.md` and `AGENTS.md`.
