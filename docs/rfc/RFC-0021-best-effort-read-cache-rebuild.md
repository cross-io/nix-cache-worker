# RFC-0021: best-effort read cache rebuild

- Status: Superseded
- Date: 2026-09-21

## Context

The previous design made public reads depend on D1 generation and retention
lookups, and sometimes performed an R2 `HEAD` before serving a request. Those
checks increase request and D1 row costs on the hottest path. Cache deletion
also cannot synchronously invalidate every CDN, browser, or presigned URL.

The deployment is allowed to replace the D1 database, remove all R2 objects,
and discard all old cache entries. This RFC therefore replaces the old upload,
read, and schema compatibility layers instead of preserving them.

## Goals and non-goals

The design minimizes Worker, R2, and D1 operations while retaining Nix HTTP
semantics, authenticated reads when configured, immutable object keys, and
strict protection for shared NAR payloads. It explicitly accepts stale reads
after deletion.

It does not provide read-after-delete guarantees, cache invalidation, old
staging-upload compatibility, upload sessions, or a D1-backed read index.

## Design

### Read paths

The Worker validates a cache key and, when `READ_TOKEN` is non-empty, requires
read, write, or admin authentication. It then returns a `307` redirect to a
presigned R2 URL without querying D1 or calling R2 `HEAD`; R2 produces the final
`200`, `206`, `304`, `404`, or `412` response. Redirects are `no-store` and are
never placed in Worker Cache. A binding fallback remains available for
`HEAD` requests carrying `Range`, where the exact response metadata cannot be
represented by a redirect in the target Nix client.

When `READ_TOKEN` is empty, anonymous Worker redirects and an R2 Custom Domain
are both valid entry points. A Custom Domain is forbidden when read
authentication is enabled because it bypasses the Worker. The Custom Domain
deployment uses a long edge Cache Rule for `/nix-cache-info`, narinfo, and NAR
paths, including stale 404s. The Worker and R2 cache-info object use
`public, max-age=300` because deployment values can change; the edge rule may
still retain the response longer.

`/nix-cache-info` is generated from Wrangler variables by the Worker. A
deployment helper writes the same bytes to the R2 `nix-cache-info` object for a
Custom Domain entry point. Neither path reads D1 settings or participates in a
cache generation scheme. The Worker Cache key includes the public cache-info
values so configuration changes select a new key without a D1 lookup.

### Writes and direct upload

NAR and narinfo objects are written directly to their final R2 keys with a
conditional immutable PUT and `public, max-age=31536000, immutable` metadata.
The large-NAR API issues a presigned PUT for the final key and uses a separate
completion call containing the key, size, and SHA-256. Completion performs one
R2 `HEAD`, one R2 `GET` for verification, and then repairs or inserts the D1
index. A digest mismatch leaves the key untouched because a stateless caller
cannot prove it owns bytes written through a valid presigned URL; an operator
may clean up that unindexed key.

### D1 and shared references

The single initial migration stores object metadata and denormalized reference
counters. `narinfo_refs` and NAR `narinfo_ref_count` are changed in the same
D1 batch as narinfo publication or reference removal. Version membership and
narinfo `version_member_count` are changed together as well.

Deletion may mark a NAR for R2 removal only when it is ready and its
`narinfo_ref_count` is zero. The D1 row becomes a permanent deleted tombstone,
and the job waits for the maximum permitted seven-day direct-upload URL
lifetime before deleting R2.
This prevents an already-issued `If-None-Match: *` PUT from recreating a key
after the R2 delete. R2 deletion and final tombstone update are independent,
bounded, retryable job steps. A stale CDN response does not affect these
database invariants.

A failed narinfo PUT retains a D1 reference reservation so a concurrent writer
cannot detach a shared NAR. After 15 minutes it is eligible for reconciliation
by the next scheduled maintenance run; if final R2 bytes are present, that run
finishes their ready index instead. The grace period is a safety lower bound,
not a promise of immediate cleanup between the normal eight-hour GC runs.

### Retention and jobs

Retention is used only by GC. `DEFAULT_RETENTION_DAYS` is a Worker variable;
there is no settings table. GC policy snapshots use one match table carrying
both keep-latest and capacity information. Version deletion uses one combined
`job_object_items` table.

## Invariants and security

- R2 is authoritative for bytes; D1 indexes only ready, immutable objects.
- A different-content write to an existing key is an immutable conflict.
- Read tokens never appear in URLs, D1, logs, or response bodies.
- Authenticated reads cannot use a public R2 Custom Domain.
- A live narinfo reference always protects its shared NAR from GC.
- Deletion is best effort for external caches and strict for D1 reference state.

## Compatibility and migration

This is a deliberate full rebuild. Remove the old migration files and create a
fresh D1 database from `migrations/0001_initial.sql`. Before deployment, empty
the old D1 database, all old R2 objects (including `_nix_uploads/`), and any
edge cache entries. No staging object, upload session, generation key, or old
API endpoint is migrated.

## Acceptance tests

- Authenticated and anonymous Worker reads redirect without D1 or R2 `HEAD`.
- Missing objects reach R2 and return `404`; redirects are not cached by Worker.
- Static cache metadata uses a five-minute client TTL and no longer depends on retention.
- Final-key direct upload and completion are idempotent and digest checked.
- Shared NAR reference counters protect the last live reference under GC.
- A fresh database is created by the single migration.
- Bounded delete and GC jobs resume after interruption and retry R2 failures.

## Implementation notes

The read-plane portions of this RFC remain implemented. RFC-0022 supersedes
the final-key upload and permanent-tombstone portions by restoring random
staging sessions and removing the deleted-object state.
