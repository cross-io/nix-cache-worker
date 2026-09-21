# RFC-0019: direct large-NAR publishing and removal of Worker multipart

- Status: Superseded by RFC-0022
- Date: 2026-09-20

## Context

RFC-0022 restores the session and staging flow described by this RFC for NAR
uploads. This RFC remains historical context only.

The Worker previously implemented R2 multipart uploads for standard Nix HTTP
PUT requests above 8 MiB. That does not solve the Worker inbound request-body
limit: the full payload still reaches the Worker. RFC-0016 provides the
correct data-plane mechanism for large NARs, namely a client PUT directly to a
presigned R2 URL followed by Worker verification and finalization.

Maintaining two large-object mechanisms makes ordinary uploads more complex
and adds multipart lifecycle and retry behavior to a path intended only for
small, compatibility-oriented Nix uploads.

## Goals and non-goals

Goals:

- retain stock `nix copy --to` for small and ordinary cache objects;
- use one streaming R2 binding `put()` for that compatibility path;
- make the explicit presigned upload session the only supported path for NARs
  too large for a Worker request;
- preserve immutable conditional writes, duplicate detection, and D1 indexing.

Non-goals:

- changing the Nix HTTP upload protocol to discover presigned URLs;
- adding resumable or parallel client multipart uploads;
- accepting large standard PUTs that exceed the Workers request limit.

## Design

Remove the internal multipart threshold, part buffering, and
`createMultipartUpload()` calls from the standard PUT path. The Worker tees
the normal request stream: one branch computes SHA-256 and the other passes
through a `FixedLengthStream` into `R2Bucket.put()` with the existing immutable
conditional create. Standard PUT must include a valid `Content-Length`, as
required by the R2 binding for a streaming single write.

The R2 single-PUT maximum is 5 GiB, well above the Worker inbound limit, so R2
does not require a Worker-managed multipart implementation for the remaining
standard-upload use case. CI publishing tools must select the RFC-0016 session
API before sending a NAR that could exceed the Worker request limit.

## Invariants and security

- Standard Nix small-object PUT remains authenticated and compatible.
- The Worker does not buffer an object in memory before writing it to R2.
- Existing `If-Match`, `If-None-Match`, immutable conflict, digest, and D1
  indexing semantics stay unchanged.
- Large direct NAR uploads retain RFC-0016's staging, SHA-256 verification,
  and conditional finalization protections.

## Compatibility and migration

No schema migration or client configuration change is required for ordinary
Nix uploads. CI publishers that previously relied on a large standard PUT must
move to the documented presigned session flow. This supersedes RFC-0016's
statement that the Worker maintains an internal multipart test path.

## Acceptance tests

- a streamed standard PUT above the old 8 MiB threshold succeeds and replays
  idempotently through a single R2 binding write;
- a real Nix sub-50 MiB upload succeeds through standard `nix copy --to`;
- a Nix-generated NAR over 100 MiB succeeds through the presigned direct
  upload session and is readable by Nix;
- full typecheck, unit suite, and remote integration test pass.

## Implementation notes

Implemented in `src/storage/r2.ts`; the standard PUT test now streams an
object above the removed threshold without invoking a multipart path. RFC-0016
and the architecture, overview, and operator instructions record the new
large-publishing boundary.
