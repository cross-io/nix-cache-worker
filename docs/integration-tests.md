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

Each run resolves the D1 database UUID from its name, clears the isolated R2
bucket and D1 schema, applies the single repository migration, and deploys the
Worker. Ensure the account's
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

The test makes two Nix store entries and exercises the direct publisher plus the
authenticated narinfo and read paths:

1. An 8 MiB and a 128 MiB random payload are added to the real Nix store. The
   checked-in `bin/nix-cache-upload` client receives both paths in one
   invocation, uploads every NAR through staging direct upload and completion,
   publishes the Nix-generated narinfos through authenticated PUTs, and
   registers the temporary version. `nix store cat --store` downloads and
   verifies both target files from the Worker.

The script first confirms that an anonymous cache request is rejected. It then
uses a mode-0600 read netrc for both Nix readbacks, and gives real `nix store
cat` a separate mode-0600 netrc with an intentionally invalid token that must
fail. This proves Nix sends its Basic credential and that the configured read
secret is usable.

All NAR publishing intentionally uses the direct-upload protocol: stock `nix
copy --to` cannot discover the staging API and ordinary NAR PUT is rejected.
The testing configuration also enables five-minute presigned R2 read redirects,
so both Nix readback checks verify that Nix follows the direct data-plane URL. The
large-object case also verifies the redirected R2 Range, `If-None-Match`, and
`If-Match` responses before Nix reads the payload. It first asserts that both
GET and HEAD return a signed `307` R2 URL without logging that bearer URL.

After both reads succeed, the client has registered its narinfos as a temporary
test version and the script uses the admin deletion job to remove the version,
narinfos, and unshared final NARs. Deletion is intentionally best effort for
edge and client caches, while D1 reference counters strictly protect shared
NARs. Staging objects and upload sessions are retained until expiry and cleaned
by bounded cron work.

Before publishing, the script also materializes a local file cache and records
the deterministic final NAR/narinfo keys. If a later command fails or GitHub
Actions cancels the run, its EXIT trap uses the isolated deployment credential
to perform best-effort cleanup of only those known, unreferenced final objects
and their D1 rows. Any staging or final object that was not indexed is
explicitly removed by the cleanup path after the test has stopped using it.
The script deletes a D1 object row only after the matching R2 deletion succeeds;
on a transient R2 failure it retains the index rather than creating an
unrecoverable R2/D1 inconsistency.
The EXIT trap also converts HUP, INT, and TERM into nonzero exits so GitHub
Actions cancellation invokes the same partial-object cleanup path.
