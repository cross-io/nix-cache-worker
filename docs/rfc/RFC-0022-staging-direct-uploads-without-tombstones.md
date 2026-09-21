# RFC-0022: staging direct uploads without tombstones

- Status: Implemented
- Date: 2026-09-21

## Context

The best-effort read rebuild removed staging sessions and used final-key
presigned PUTs. A final-key URL can still be used after the corresponding D1
row has been deleted, so safe deletion required a permanent tombstone and a
delay equal to the maximum presigned URL lifetime. This keeps deleted keys in
D1 and prevents immediate key reuse.

This repository is undergoing a deliberate non-compatible rebuild and may
clear D1, R2, and cache state before deployment.

## Goals and non-goals

Goals:

- keep NAR bytes out of the Worker request body;
- prevent an issued upload URL from writing directly to a public final key;
- remove final-key tombstones and allow key reuse after deletion;
- preserve immutable NAR promotion and shared-NAR reference protection;
- keep narinfo PUT in the Worker because it must update D1 references atomically.

Non-goals:

- preserving ordinary `nix copy --to` NAR PUT publishing;
- multipart or resumable uploads above R2's single-PUT limit;
- individual revocation of an already-issued R2 presigned URL.

## Design

`POST /api/uploads` accepts `key`, `size`, and lowercase SHA-256, creates an
`upload_sessions` row, and returns an `uploadId` plus a presigned PUT for
`_nix_uploads/<uploadId>`. The URL uses `If-None-Match: *` and is never a
public cache object.

The client PUTs directly to the staging key, then calls
`POST /api/uploads/<uploadId>/complete`. Completion claims the final key,
checks the session and staging object, hashes the staged bytes, compares any
existing final object, and conditionally streams the staged bytes to the final
NAR key. Only after successful promotion does it upsert `objects` and mark the
session completed. Same-content retries are idempotent; conflicts and digest
mismatches do not overwrite final bytes.

Ordinary `PUT /nar/*` returns `405 direct_upload_required`. `.narinfo` PUT
continues through the Worker and uses a D1 batch to reserve the narinfo,
validate the ready NAR, and increment `narinfo_ref_count`.

Upload sessions have `issued`, `completed`, `failed`, `expired`, and `revoked`
states. Terminal sessions and their staging objects are cleaned after expiry
by bounded scheduled work. Deletion revokes issued sessions for the final key,
obtains the same short-lived `write_claims` lock, deletes R2, and then deletes
the `objects` row. Object states are only `pending`, `ready`, and `deleting`;
there is no `deleted`, `orphaned`, or tombstone state. A later upload may reuse
the key after R2 and D1 cleanup.

## Invariants and security

- A staging object is never indexed or served through a cache path.
- A session can promote only its own random staging key and declared digest.
- An issued session revoked by deletion cannot promote a late staging upload.
- R2 deletion and final D1 row deletion are serialized with promotion by
  `write_claims`.
- A NAR is deleted only when `narinfo_ref_count = 0`.
- Tokens remain Worker Secrets and never appear in URLs or logs.

An R2 presigned staging URL cannot be individually revoked, but it cannot
promote bytes after its session is revoked. A late staging object is harmless
and is removed by expiry cleanup.

## Compatibility and migration

This is a full rebuild. Apply the single `migrations/0001_initial.sql` to a
new or fully cleared D1 database, clear all R2 objects including old
`_nix_uploads/` data, and redeploy. No final-key upload endpoint, ordinary NAR
PUT behavior, tombstone, or old migration state is retained.

## Acceptance tests

- NAR Worker PUT returns `405 direct_upload_required`.
- Staging issue, direct PUT, completion, retry, digest mismatch, and conflict
  behavior are covered.
- Staging objects are absent from `objects` and are cleaned after expiry.
- Deletion revokes active sessions, removes R2 before the D1 row, and allows
  final-key reuse.
- GC and narinfo publication preserve shared-NAR reference counts.
- The bundled client and real-Nix integration flow use staging completion.

## Implementation notes

The implementation restores `upload_sessions`, transient `write_claims`, and
the cron cleanup hook, removes final-key completion, and updates the client,
integration script, schema, documentation, and local tests. The read-plane
best-effort behavior from RFC-0021 remains unchanged.
