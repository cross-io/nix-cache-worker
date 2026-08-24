# Deployment guide

This guide deploys Nix Cache Worker to Cloudflare Workers with R2, D1, Worker
Secrets, and an every-eight-hours garbage-collection trigger. The application does not
create or modify Cloudflare bindings and Secrets through its web console.

## Prerequisites

Install Node.js and npm, create or select a Cloudflare account, and authenticate
Wrangler:

```bash
npm install
npx wrangler login
```

The account needs permission to create or use Workers, R2, D1, and Worker
Secrets. Do not add a Cloudflare API credential to the Worker itself.

## 1. Initialize the private Wrangler file

The public repository contains a safe template, not a deployable personal
configuration:

```bash
cp wrangler.jsonc.example wrangler.jsonc
```

Edit the ignored `wrangler.jsonc` and set:

1. `name` to the Worker name you want to deploy.
2. `CACHE_BUCKET` to an R2 bucket dedicated to this cache.
3. `DB` to the D1 database name and IDs for the target environment.
4. `NIX_PUBLIC_SIGN_KEY` to the public key used by your signed narinfos, if
   signature verification is enabled.
5. An optional custom-domain route in the Cloudflare Dashboard or in the
   private Wrangler file.

The example uses placeholder resource names and the all-zero UUID only to make
the required fields obvious. Replace every placeholder before a remote
operation. The private `wrangler.jsonc` is ignored by `.gitignore`; do not
force-add it.

For local development, initialize the ignored secret file if needed:

```bash
cp .dev.vars.example .dev.vars
```

## 2. Create or select Cloudflare resources

Create an R2 bucket and a D1 database in the target Cloudflare account, or use
existing dedicated resources. Put their names and the D1 UUID in the private
Wrangler file. Keep production and preview/local resources separate when the
deployment workflow requires isolation.

The D1 binding must use `migrations_dir: "migrations"`. The Cron trigger in the
template runs at 00:00, 08:00, and 16:00 UTC and enqueues bounded GC work. The repository
now contains one squashed baseline migration; future schema changes start at
`0002`.

## 3. Apply D1 migrations

Use the exact database name from the private Wrangler file:

```bash
npx wrangler d1 migrations apply <D1_DATABASE_NAME> --remote
```

For local development, use the local binding instead:

```bash
npx wrangler d1 migrations apply <D1_DATABASE_NAME> --local
```

Migrations are forward-only. Review the migration list before applying it to a
database that already contains production data.

Existing deployments must complete the pre-squash migration chain before using
this repository version. Check the migration list from the previous revision;
an environment that has only applied the old `0001` or `0002` must first run
the old `0003` and `0004` migrations from that revision. Do not run the new
baseline against a partially migrated database. Fresh local state can apply
the single baseline directly.

## 4. Configure Worker Secrets

Set all three roles separately. Wrangler prompts for each value without placing
it in the repository:

```bash
npx wrangler secret put READ_TOKEN
npx wrangler secret put WRITE_TOKEN
npx wrangler secret put ADMIN_TOKEN
```

Use long, independently generated values. Keep them in the CI secret store or
password manager and do not put them in `vars`, D1, URLs, netrc files checked
into source control, screenshots, or logs.

## 5. Deploy

Run the supported deployment command:

```bash
npx wrangler deploy
```

`npm run build` is only a dry-run build and does not publish a Worker. The
deployment output should show the expected Worker, R2 binding, D1 binding, and
Cron trigger.

## 6. Configure a custom domain and Nix signing

Attach an HTTPS custom domain through Cloudflare after the Worker is deployed,
or configure the route in the private Wrangler file. The UI derives examples
from the request origin, so it does not require a hostname in tracked source.

If narinfos are signed, set `NIX_PUBLIC_SIGN_KEY` to the matching public key,
deploy again, and verify that the public `/` page displays the expected key.
Never upload or commit the corresponding private signing key.

## 7. Verify the deployment

Check the following in order:

```bash
curl -fsS https://cache.example.org/nix-cache-info
curl -i https://cache.example.org/
```

Then log in at `/admin`, confirm the settings and seeded retention rule, and
perform an end-to-end test from a controlled Nix client:

1. Upload a NAR with `nix copy --to` using a temporary netrc whose file mode is
   `0600`.
2. Upload or observe the corresponding narinfo.
3. Register the package/version with the write-token API.
4. Read the result with `nix copy --from` or `nix store cat --store`.
5. Test a Range request and inspect the Worker logs for safe structured events.

Replace `cache.example.org` with the real HTTPS hostname. Do not paste real
tokens into these commands or into documentation.

## Updating an existing deployment

Keep the existing ignored `wrangler.jsonc`, review source and migration
changes, apply any new D1 migration, and deploy:

```bash
npx wrangler d1 migrations apply <D1_DATABASE_NAME> --remote
npx wrangler deploy
```

Rotate a Worker Secret with the same `wrangler secret put NAME` command. A
secret rotation does not require a D1 migration. Keep old and new credentials
coordinated with CI and Nix clients during the transition.
