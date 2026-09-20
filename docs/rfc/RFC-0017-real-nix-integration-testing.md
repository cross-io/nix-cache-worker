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

1. The small item is uploaded with normal `nix copy --to` and read back by Nix.
2. Nix generates a canonical file-cache NAR and narinfo for the large item.
   The script verifies that the compressed NAR exceeds 100 MiB, creates a
   direct-upload session, PUTs the NAR to its presigned R2 URL, completes the
   session, and uploads the Nix-generated narinfo through the normal PUT path.
   Nix then reads the target file back from the Worker.

After the read checks, the script registers both narinfos as one temporary
version and requests its confirmed admin deletion. It polls the deletion job to
completion so successful runs do not retain their random final large NAR in R2.
The test template reduces the direct-upload URL lifetime to 15 minutes and
runs cleanup hourly. The staging object remains until expiry and cleanup because
deleting it earlier would make its still-valid signed `If-None-Match: *` URL
reusable; its retention is therefore bounded to roughly 75 minutes.

The test uses `require-sigs = false` only because the fixture's generated
narinfos are unsigned. It does not relax the Worker authorization boundary.

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
- The direct-upload staging object remains present until its presigned URL
  expires, then the isolated Worker cleans it within the next hourly Cron run.

## Compatibility and migration

The production Wrangler configuration and deployment command are unchanged.
The integration configuration is a separate tracked template with only public
resource names and placeholders. No D1 schema migration is introduced beyond
the application's existing migration chain.

## Acceptance tests

- The workflow refuses to run without each required GitHub Secret.
- It fails clearly if the R2 bucket or D1 database is missing.
- A sub-50 MiB NAR is uploaded by `nix copy --to` and read by Nix from the
  deployed cache.
- A Nix-generated NAR larger than 100 MiB is uploaded by the presigned direct
  flow, followed by its standard narinfo PUT, and read by Nix from the deployed
  cache.
- Successful tests complete their authorized deletion job and remove final test
  NARs. Staging cleanup is deferred safely until URL expiry and the next hourly
  Cron run.
- The workflow does not run for Markdown-only pushes to `master`.

## Implementation notes

Implemented by `.github/workflows/nix-integration.yml`,
`wrangler.integration.jsonc`, and `scripts/integration/nix-cache-e2e.sh`.
