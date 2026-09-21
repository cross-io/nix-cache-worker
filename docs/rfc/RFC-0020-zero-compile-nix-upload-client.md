# RFC-0020: zero-compile Nix upload client

- Status: Superseded by RFC-0022
- Date: 2026-09-20

## Context

RFC-0022 changes the direct-upload contract back to sessions and staging keys.
This RFC remains historical context only; the current client flow is
documented in RFC-0022 and the operator documentation.

RFC-0016 provides a safe direct R2 upload session, but it requires a CI
publisher to generate a NAR, calculate its digest, call multiple endpoints in
the required order, and register the resulting version. Stock `nix copy --to`
cannot discover that session and therefore cannot bypass the Worker request
body limit for large NARs.

## Goals and non-goals

Goals:

- make complete-closure publishing convenient for CI without a compiled client;
- upload all client-managed NARs through the existing presigned R2 flow;
- preserve narinfo ordering, immutable object semantics, and version
  registration;
- protect write tokens and presigned URLs from normal command output and curl
  process arguments.

Non-goals:

- changing Worker APIs, D1 schema, or stock Nix cache semantics;
- replacing ordinary `nix copy --to` compatibility uploads;
- resumable, multipart, or parallel client uploads beyond R2 single PUT.

## Design

`bin/nix-cache-upload` is a Bash 3.2-compatible executable. It accepts one or
more `nix copy` installables, an HTTPS cache origin, explicit package/version
names, optional tags and retention days, and either `NIX_CACHE_WRITE_TOKEN` or
`--token-file`.

The client invokes `nix copy --to file://…` in a private temporary directory,
then enumerates generated narinfo files. It deduplicates their referenced NAR
keys, calculates each NAR's exact byte size and SHA-256, creates an upload
session, PUTs to the returned R2 URL, and retries completion. Only after every
NAR is ready does it PUT the narinfo files through the normal Worker route and
PUT the union of narinfo keys to the existing package/version registration API.

Each NAR is sequential and must be no larger than 5 GiB. Network and transient
HTTP failures use bounded retry; a `412` R2 PUT is treated as an uncertain
success and is followed by completion. A finished rerun naturally uses the
server's immutable duplicate responses. There is no cross-process resume:
retrying a failed single PUT starts it again.

## Invariants and security

- The client never sends NAR bytes through the Worker, regardless of size.
- narinfo is not published before its referenced NAR is finalized and indexed.
- The Worker remains the authority for SHA-256 verification, conditional final
  object creation, indexing, and version membership validation.
- Token-bearing Authorization headers and presigned R2 URLs are written only
  to mode-0600 temporary curl configuration files; status output contains no
  token, header, or URL.
- Successful runs remove their temporary cache. Failed runs retain it and show
  its location so a user can inspect or rerun safely.

## Compatibility and migration

No Worker configuration, migration, or API change is required. Existing stock
Nix users continue to use `nix copy --to` and HTTP Basic/netrc authentication.
CI users may adopt the client incrementally; its `--package` and `--version`
arguments intentionally avoid inferring lifecycle identities from flake or Git
metadata.

## Acceptance tests

- shell tests cover validation, closure deduplication, direct session retries,
  `412` uncertain PUT handling, completion retry, ordered narinfo publishing,
  registration metadata, and output secrecy;
- the remote real-Nix test retains a stock small-object upload and uses the
  client for a closure containing sub-50 MiB and over-100 MiB NARs;
- typecheck, full unit suite, build, and the main-branch remote integration
  workflow pass.

## Implementation notes

Implemented as `bin/nix-cache-upload` without a new package manager or
compiled runtime. The client relies only on Bash, Nix, curl, jq, and standard
POSIX command-line utilities.
