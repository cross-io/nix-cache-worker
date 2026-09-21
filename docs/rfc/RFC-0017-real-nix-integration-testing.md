# RFC-0017: Real Nix integration testing

- Status: Implemented
- Date: 2026-09-20

## Context

The local Workers Vitest suite verifies HTTP and storage behavior with local
R2/D1 simulators, but it cannot prove that an actual deployed Worker is usable
by Nix or that the direct-to-R2 large-NAR flow works against Cloudflare.

The repository has dedicated remote resources named `nix-cache-testing` for
the R2 bucket and D1 database. The Worker of the same name is intentionally
created by CI on its first deployment.

## Goals and non-goals

The integration workflow must deploy the testing Worker, use real Nix to write
and read cache entries, exercise both the standard small-object protocol and
the large direct-upload protocol, and keep all credentials in GitHub Secrets.

It is not a production deployment path, a replacement for unit tests, or an
attempt to make stock `nix copy --to` use the direct-upload API.

## Design

The `Real Nix integration` GitHub Actions workflow runs only for pushes to
`master` whose changes are not exclusively Markdown files. It uses the tracked
testing Wrangler template, resolves the existing D1 database ID by name,
applies the normal forward-only migrations, and deploys `nix-cache-testing`.

The workflow installs the Worker `READ_TOKEN`, `WRITE_TOKEN`, `ADMIN_TOKEN`,
and R2 S3 signing credentials from GitHub Secrets. It never stores those values
in a tracked Wrangler file or prints them to the workflow log.

The test script creates random 8 MiB and 128 MiB files, adds them to the real
Nix store, and checks the resulting payload bytes with `nix store cat` against
the deployed HTTP cache:

1. The small and large items are both published by the zero-compile upload
   client: every NAR goes through a staging direct-upload session
   (`POST /api/uploads`, PUT to `_nix_uploads/<uploadId>`,
   `POST /api/uploads/<uploadId>/complete` with digest verification and
   promotion), then narinfos are published and the test version is registered.
   Nix then reads both target files back from the Worker with a
   separate read-token netrc.

After the read checks, the script registers both narinfos as one temporary
version and requests its confirmed admin deletion. It polls the deletion job to
completion so successful runs do not retain their random final large NAR in R2.
The test template reduces the direct-upload URL lifetime to 15 minutes. Each
run resets the isolated D1 and R2 resources before deployment; staging
objects and upload sessions are retained until expiry and are removed by
the bounded scheduled cleanup.

The test uses `require-sigs = false` only because the fixture's generated
narinfos are unsigned. It does not relax the Worker authorization boundary:
the script first proves anonymous cache access is rejected, then real Nix
proves an invalid read-token netrc fails and retrieves both targets using
READ_TOKEN.
The test configuration enables the presigned read mode from RFC-0018, so Nix
also proves that it can retrieve both fixtures after a Worker redirect to R2.

## Invariants and security

- R2 object bytes, D1 state, and the Worker all remain isolated to the
  `nix-cache-testing` resources.
- The direct URL is handled as a bearer credential: it is kept in a shell
  variable, is never echoed, and is not uploaded as an artifact.
- The temporary Nix netrc has mode `0600` and is removed at script exit.
- Every credential, including Cloudflare deployment and R2 S3 API credentials,
  is supplied through GitHub repository Secrets.
- A concurrency group prevents two integration deployments from racing on the
  shared Worker configuration.
- Successful runs remove their temporary version and unshared objects through
  the normal authorized deletion-job path.
- Before publishing, the script records deterministic final object keys from a
  local file cache. A failed or cancelled run performs best-effort cleanup of
  only those unreferenced final objects and D1 rows. It removes an object index
  only after R2 confirms the matching deletion.

## Compatibility and migration

The production Wrangler configuration and deployment command are unchanged.
The integration configuration is a separate tracked template with only public
resource names and placeholders. No D1 schema migration is introduced beyond
the application's existing migration chain.

## Acceptance tests

- The workflow refuses to run without each required GitHub Secret.
- It fails clearly if the R2 bucket or D1 database is missing.
- Both the sub-50 MiB and the over-100 MiB NARs are uploaded by the staging
  direct-upload client and read by Nix from the deployed cache.
- A Nix-generated NAR larger than 100 MiB is uploaded by the staging session
  flow, followed by its standard narinfo PUT, and read by Nix from the deployed
  cache.
- Both Nix readbacks follow the configured presigned R2 GET/HEAD redirect.
- The direct large-NAR path returns the expected R2 Range and ETag conditional
  responses before Nix reads it.
- The integration script confirms that its direct large-NAR GET and HEAD first
  receive a signed R2 redirect without emitting the bearer URL.
- Successful tests complete their authorized deletion job and remove final test
  NARs; expired staging objects and terminal sessions are removed by the
  scheduled cleanup.
- Failed or cancelled tests make a best-effort removal of their pre-recorded,
  unreferenced final object keys.
- HUP, INT, and TERM are converted to nonzero exits before the EXIT trap runs,
  so GitHub Actions cancellation uses that failed-run cleanup path.
- The script verifies anonymous reads are rejected and uses READ_TOKEN for both
  Nix readbacks.
- The workflow does not run for Markdown-only pushes to `master`.

## Implementation notes

Implemented by `.github/workflows/nix-integration.yml`,
`wrangler.integration.jsonc`, and `scripts/integration/nix-cache-e2e.sh`.
The NAR upload path follows the staging direct-upload sessions from RFC-0022;
ordinary Worker NAR PUTs are rejected and stock `nix copy --to` against the
Worker is not used for publishing.
