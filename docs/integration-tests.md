# Remote integration tests

The `Real Nix integration` workflow deploys an isolated Cloudflare test cache
and proves that real Nix can read the cache entries it uploads. It is separate
from the local Vitest suite and never uses production R2, D1, Worker, or token
values.

## Fixed test resources

The workflow expects these existing Cloudflare resources in the account
selected by `CLOUDFLARE_ACCOUNT_ID`:

| Resource | Name |
| --- | --- |
| R2 bucket | `nix-cache-testing` |
| D1 database | `nix-cache-testing` |
| Worker | `nix-cache-testing` (created by the workflow if absent) |

The first run resolves the D1 database UUID from its name, applies all
repository migrations, and deploys the Worker. Ensure the account's
`workers.dev` hostname is enabled, or point `NIX_CACHE_TESTING_URL` at an
already-configured HTTPS custom domain for that Worker.

## Required GitHub repository Secrets

Create every value below as a GitHub Actions repository Secret. The workflow
checks their presence before changing Cloudflare state and never writes them to
the repository or logs.

| Secret | Purpose |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | CI API token with access to deploy Workers, bind/read the test R2 bucket, apply D1 migrations, and update Worker Secrets. |
| `CLOUDFLARE_ACCOUNT_ID` | Account containing the dedicated test resources. |
| `NIX_CACHE_TESTING_URL` | HTTPS origin for `nix-cache-testing`, without a trailing path. |
| `NIX_CACHE_TESTING_READ_TOKEN` | Test Worker `READ_TOKEN` value. |
| `NIX_CACHE_TESTING_WRITE_TOKEN` | Test Worker `WRITE_TOKEN` value used by Nix and the direct-upload API. |
| `NIX_CACHE_TESTING_ADMIN_TOKEN` | Test Worker `ADMIN_TOKEN` value. |
| `R2_S3_ACCESS_KEY_ID` | R2 S3 API access key scoped to `nix-cache-testing`. |
| `R2_S3_SECRET_ACCESS_KEY` | Matching R2 S3 API secret key. |

Use separate random Worker tokens for this environment. The R2 S3 credential
must grant object read/write only for the test bucket; it is used by the Worker
to issue presigned URLs and is not a replacement for the Cloudflare deployment
token.

For example, add a value without placing it in shell history:

```bash
gh secret set NIX_CACHE_TESTING_WRITE_TOKEN --repo cross-io/nix-cache-worker
```

Run the command once for each required name and enter the secret on standard
input. Do not add these values to `wrangler.jsonc`, `.dev.vars`, or GitHub
Actions variables.

## Trigger and coverage

The workflow runs only on pushes to `master`. `paths-ignore: "**/*.md"` means
a Markdown-only push does not trigger it; a push that includes code and
Markdown still runs the test. A concurrency group cancels an older in-flight
test deployment before a newer push can reconfigure the shared Worker.

The test makes two Nix store entries and exercises both publisher interfaces:

1. An 8 MiB random payload is added to the real Nix store. `nix copy --to`
   uploads it through the normal HTTP cache protocol, and `nix store cat --store`
   retrieves the target file from the deployed Worker and verifies its SHA-256.
2. A 128 MiB random payload is added to the real Nix store. The checked-in
   `bin/nix-cache-upload` client receives both paths in one invocation. It
   creates its own local file cache, confirms one generated NAR is over 100 MiB,
   uploads NARs through `POST /api/uploads` and presigned R2 PUTs, publishes the
   Nix-generated narinfos through normal authenticated PUTs, and registers the
   temporary version. `nix store cat --store` downloads and verifies the large
   target file from the Worker.

The client-managed large case intentionally uses the direct-upload protocol:
stock `nix copy --to` cannot discover or use this API, and routing its 100+ MiB
request through the Worker would not validate the purpose of the feature. The testing
configuration also enables five-minute presigned R2 read redirects, so both
Nix readback checks verify that Nix follows the direct data-plane URL. The
large-object case also verifies the redirected R2 Range, `If-None-Match`, and
`If-Match` responses before Nix reads the payload. It first asserts that both
GET and HEAD return a signed `307` R2 URL without logging that bearer URL.

After both reads succeed, the client has registered its narinfos as a temporary
test version and the script uses the admin deletion job to remove the version,
narinfos, and unshared final NARs. A direct-upload staging object cannot be removed until
its signed URL expires: deleting it earlier would let a holder of that URL reuse
the signed `If-None-Match: *` PUT. The isolated test configuration therefore
uses a 15-minute direct-upload URL and an hourly Cron cleanup, bounding staging
retention to roughly 75 minutes without changing the production schedule.
