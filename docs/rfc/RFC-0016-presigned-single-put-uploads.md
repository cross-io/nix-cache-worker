# RFC-0016: presigned single-PUT uploads for large NARs

- Status: Superseded by RFC-0022
- Date: 2026-09-19

## Context

RFC-0022 restores this session-and-staging design for NAR uploads. This RFC
remains as historical context only; its endpoint, schema, cleanup, and
migration instructions are no longer operational.

The standard Nix HTTP cache protocol sends each cache object in one HTTP PUT.
Cloudflare Workers request-body limits therefore prevent the Worker from
accepting NARs larger than the configured account limit, even though R2 can
store much larger objects.

The Worker previously used R2 multipart uploads internally, but that still sent
the client request body through the Worker. It did not bypass the inbound
request limit. A transparent redirect cannot provide a multipart protocol and
would also leave the D1 object index and immutable-write checks outside the
completion path.

## Goals and non-goals

Goals:

- allow CI to upload NARs larger than the Worker request-body limit;
- keep normal `nix copy --to` PUT, GET, HEAD, Range, and conditional semantics
  unchanged;
- keep final cache object bytes immutable and indexed only after verification;
- avoid exposing R2 credentials to upload clients;
- make completion and recovery idempotent.

Non-goals:

- changing the standard Nix client into a multipart client;
- supporting browser uploads in the initial implementation;
- supporting objects larger than the R2 single-object PUT limit;
- adding resumable or parallel multipart uploads. Those require a separate RFC.

## Design

The authenticated write API adds two endpoints:

```text
POST /api/uploads
POST /api/uploads/{uploadId}/complete
```

The initialization body is:

```json
{
  "key": "nar/example.nar",
  "size": 123456789,
  "sha256": "<lowercase sha256>"
}
```

Only `nar/*` keys are accepted. The Worker checks existing objects and active
sessions, creates a random staging key under `_nix_uploads/`, and returns a
short-lived R2 S3 presigned PUT URL. The URL signs `Content-Type` and
`If-None-Match: *`, and the client must send those headers. The R2 S3
credentials used to create the signature are Worker Secrets and are never
returned or logged.

The client uploads directly to the staging key. The staging key is not a
supported public cache path and is never indexed as a cache object.

The completion endpoint checks the staging object size, streams it to compute
SHA-256, and compares it with the declared digest. It then streams the object
through the Worker into the final R2 key with an R2 conditional create. The
final object is indexed in D1 only after the conditional write succeeds. If a
normal PUT wins a race, equal content is treated as an idempotent duplicate and
different content is rejected.

The completion endpoint can be retried after a Worker interruption. Completed
sessions return the original result. Failed or expired sessions are retained
until the presigned URL expires; bounded scheduled cleanup then deletes their
staging object and session row. Keeping the staging object present during the
URL lifetime also makes `If-None-Match: *` a tombstone against late URL reuse.

## Invariants and security

- The standard Nix PUT path remains available and unchanged.
- The presigned URL can write only one random staging key and expires after the
  configured short lifetime.
- `If-None-Match: *` prevents reuse of a presigned URL from replacing its
  staging object.
- Final object creation uses a conditional R2 write and never overwrites an
  existing key.
- The Worker recomputes SHA-256; the client-provided digest is not trusted.
- A `.narinfo` is still accepted only after the final NAR object is present and
  indexed as ready.
- Presigned URLs, R2 credentials, bearer tokens, and Authorization headers are
  excluded from logs and audit details.
- Staging objects are not served through the cache routes. Terminal staging
  objects remain present until URL expiry so the signed `If-None-Match: *`
  condition cannot be reused to recreate an object after completion; a bounded
  scheduled task then deletes the staging object and session row.

## Compatibility and migration

Add an `upload_sessions` table through a forward-only D1 migration. Existing
objects and existing clients require no data migration and no API change.
Deployments that enable the new API must configure the R2 account ID, bucket
name, and a bucket-scoped R2 S3 access key and secret as documented in the
deployment guide.

The CI flow is:

1. compute the NAR size and SHA-256;
2. initialize an upload session with the write token;
3. PUT the file directly to the returned R2 URL;
4. complete the session with the write token;
5. upload the `.narinfo` through the normal cache PUT path.

## Acceptance tests

- write authentication is required for initialization and completion;
- invalid keys, sizes, and SHA-256 values are rejected;
- initialization returns a presigned URL without exposing credentials;
- the direct staging object is not indexed or served as a cache object;
- correct size and digest complete successfully and create a ready D1 row;
- wrong size or digest is rejected;
- repeated completion is idempotent;
- final-key races preserve immutable semantics;
- an incomplete NAR still causes `.narinfo` upload to return `424`;
- a completed NAR can be followed by a normal `.narinfo` PUT;
- expired and completed staging sessions are cleaned up in bounded batches;
- existing standard PUT tests continue to pass.

## Implementation notes

AWS Signature Version 4 presigning is implemented with the Workers Web Crypto
API to avoid adding an SDK solely for URL signing. The initial default URL
lifetime is one hour and is clamped to the S3 presigning range.

The implementation is in `src/routes/uploads.ts`, `src/storage/uploads.ts`,
and `src/storage/presign.ts`. Migration `0004_presigned_upload_sessions.sql`
adds the session table and active-key uniqueness guard. Per-key write claims
are held through direct-upload preflight and completion, and long R2 streams
renew the claim while they are consumed. Terminal staging objects remain until
the presigned URL expires so `If-None-Match: *` cannot be reused to recreate
staging data; the scheduled cleanup then removes the object and session row.
The finalization path uses the Worker R2 binding to stream into a conditional
final write, preserving the existing binding-based storage boundary rather
than adding an S3 copy dependency. RFC-0019 later removed the unrelated
Worker-managed multipart path for standard PUTs; large publishing remains this
explicit direct-upload flow. Type checking, the full 49-test suite, and the
Wrangler dry-run build pass.
