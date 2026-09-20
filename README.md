# Nix Cache Worker

![Nix Cache Worker admin console](docs/assets/admin-page.png)

Nix Cache Worker is a Cloudflare Worker that provides a standard HTTP binary
cache for Nix, backed by Cloudflare R2 and D1. It is designed for CI systems
that build packages and publish them to a private, policy-managed cache.

It supports:

- standard `nix copy --to` and `nix copy --from` workflows;
- public cache reads with authenticated writes;
- a zero-compile Nix publishing client with direct-to-R2 NAR uploads;
- optional presigned R2 redirects for cache-object reads;
- package and build-version organization with tags;
- retention policies, pins, and bounded garbage collection;
- an authenticated web console for operations and administration.

## Quick start

Install dependencies and create your private deployment configuration from the
checked-in template:

```bash
npm install
cp wrangler.jsonc.example wrangler.jsonc
```

Edit `wrangler.jsonc` with your R2 bucket, D1 database, hostname, and public
signing key. The file is ignored by Git. Then authenticate Wrangler, apply the
schema, configure Worker Secrets, and deploy:

```bash
npx wrangler login
npx wrangler d1 migrations apply <D1_DATABASE_NAME> --remote
npx wrangler secret put READ_TOKEN
npx wrangler secret put WRITE_TOKEN
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put R2_S3_ACCESS_KEY_ID
npx wrangler secret put R2_S3_SECRET_ACCESS_KEY
npx wrangler deploy
```

See [`docs/deployment.md`](docs/deployment.md) for resource setup, custom
domains, signing, verification, and upgrade guidance.

## Using the cache

Reads are public by default. Nix publishers use the Worker write token through
a mode-0600 netrc entry, while management operations use the admin token. The
public home page shows the NixOS and nix-darwin client configuration example
for the deployed origin.

The admin console is available at `/admin`. It manages package versions,
retention rules, pins, garbage collection, and persistent deletion jobs.

For CI publishing, use [`bin/nix-cache-upload`](bin/nix-cache-upload). It
exports a standard local Nix file cache, sends every NAR directly to R2 through
an authenticated presigned session, publishes narinfo only after completion,
and registers the requested package/version. This does not change the standard
`nix copy --to` protocol.

```bash
NIX_CACHE_WRITE_TOKEN=... bin/nix-cache-upload \
  --to https://cache.example.org \
  --package example --version ci-123 --tag channel=main \
  nixpkgs#hello
```

Deployments may also set `DIRECT_DOWNLOAD_URL_TTL_SECONDS` to redirect
supported NAR and narinfo GET/HEAD requests to short-lived R2 URLs. Stock Nix
clients follow those redirects, so R2 supplies the authoritative object,
Range, and conditional response directly. Missing objects and older objects
with pre-existing R2 cache metadata remain on the Worker read path.

## Development

For local-only secrets, copy the example file instead of committing values:

```bash
cp .dev.vars.example .dev.vars
npm run dev
```

Run the checks with:

```bash
npm run typecheck
npm test
npm run build
```

`npm run build` performs a Wrangler dry run; it does not deploy the Worker.

## Documentation

- [Project overview](docs/overview.md) — cache protocol, API, authentication,
  retention, observability, and acceptance criteria.
- [Deployment guide](docs/deployment.md) — Cloudflare resources, migrations,
  secrets, custom domains, and verification.
- [Configuration and operations](docs/configuration.md)
- [Architecture](docs/architecture.md)
- [Remote integration tests](docs/integration-tests.md)
- [RFC history](docs/rfc/README.md)

R2 is the source of truth for cache bytes, D1 stores indexes and lifecycle
metadata, and Worker Secrets are the only source of bearer-token values.
