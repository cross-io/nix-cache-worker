# Configuration and operations

Start from the ignored deployment template:

```bash
cp wrangler.jsonc.example wrangler.jsonc
```

## Bindings and variables

The Worker needs one R2 binding, one D1 binding, and the Cron trigger. The
single `migrations/0001_initial.sql` file is the complete schema for a fresh
database.

```text
DEFAULT_STORE_DIR=/nix/store
DEFAULT_PRIORITY=40
DEFAULT_WANT_MASS_QUERY=1
DEFAULT_RETENTION_DAYS=7
R2_ACCOUNT_ID=<cloudflare-account-id>
R2_BUCKET_NAME=<cache-bucket-name>
R2_S3_ENDPOINT=<optional-https-r2-s3-endpoint>
DIRECT_UPLOAD_URL_TTL_SECONDS=3600
DIRECT_DOWNLOAD_URL_TTL_SECONDS=900
NIX_PUBLIC_SIGN_KEY=<optional-public-signing-key>
```

`DIRECT_DOWNLOAD_URL_TTL_SECONDS` is the lifetime of Worker-generated R2 read
URLs. Use a value between 60 seconds and seven days. R2 S3 credentials are
required for presigning and belong in Worker Secrets, not in D1, source code,
URLs, cookies, or logs.

`DEFAULT_STORE_DIR`, `DEFAULT_PRIORITY`, and `DEFAULT_WANT_MASS_QUERY` form
the static `/nix-cache-info` response. The Worker does not read settings from
D1. If an R2 Custom Domain is enabled, write the same response to the R2
`nix-cache-info` object during deployment.

## Authentication and read modes

Configure independent secrets as needed:

```bash
npx wrangler secret put READ_TOKEN
npx wrangler secret put WRITE_TOKEN
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put R2_S3_ACCESS_KEY_ID
npx wrangler secret put R2_S3_SECRET_ACCESS_KEY
```

When `READ_TOKEN` is empty, anonymous Worker reads are allowed and an R2
Custom Domain may be used as a direct anonymous entry point. When it is
non-empty, `GET` and `HEAD` cache paths require read, write, or admin
authentication and always redirect through the Worker. Do not expose a public
R2 Custom Domain in that mode.

Read redirects use `Cache-Control: no-store`; final NAR and narinfo objects use
immutable one-year metadata, while `/nix-cache-info` uses a five-minute client
cache lifetime. Deletion is best effort: CDN, browser, and
presigned URL caches may continue to return old bytes or 404s.

The Worker also accepts Nix netrc-generated Basic credentials where the
password equals the appropriate Worker Secret. Use Basic only over HTTPS.

## R2 Custom Domain cache rule

The Custom Domain is optional. If enabled, create one Cache Rule covering:

```text
/nix-cache-info
/*.narinfo
/nar/*
```

Set an edge TTL of about one year, enable caching of 404 responses, and use
the R2 object metadata as the browser/client cache policy. There is no Worker
cache-generation key to invalidate. Clear old edge cache and delete old R2
objects before deploying the new schema.

To publish cache-info for the Custom Domain, generate the same bytes as the
Worker response and run an R2 object upload, for example:

```bash
printf 'StoreDir: %s\nWantMassQuery: %s\nPriority: %s\n' \
  "$DEFAULT_STORE_DIR" "$DEFAULT_WANT_MASS_QUERY" "$DEFAULT_PRIORITY" > /tmp/nix-cache-info
npx wrangler r2 object put "$R2_BUCKET_NAME/nix-cache-info" \
  --remote \
  --file /tmp/nix-cache-info \
  --content-type 'text/plain; charset=utf-8' \
  --cache-control 'public, max-age=300'
```

## Publishing

NAR payloads must use the bundled staging direct-upload client:

```bash
NIX_CACHE_WRITE_TOKEN=... bin/nix-cache-upload \
  --to https://cache.example.org \
  --package example --version ci-123 \
  nixpkgs#hello
```

The client creates a local Nix file cache, uploads each unique NAR to a random
`_nix_uploads/<uploadId>` staging key, calls
`POST /api/uploads/<uploadId>/complete`, then publishes narinfo through the
Worker and registers the version. Ordinary `PUT /nar/*` requests return
`405 direct_upload_required`; there is no Worker NAR upload compatibility path.

## Direct NAR upload API

Request a staging presigned URL:

```http
POST /api/uploads
Authorization: Bearer <WRITE_TOKEN>
Content-Type: application/json

{"key":"nar/example.nar","size":123,"sha256":"<lowercase sha256>"}
```

The response contains `uploadId`, `expiresAt`, `uploadUrl`, and `uploadHeaders`.
PUT the exact bytes to the returned random staging URL using the returned
headers, then complete that session:

```http
POST /api/uploads/<uploadId>/complete
Authorization: Bearer <WRITE_TOKEN>
```

Completion verifies the staging size and SHA-256, conditionally promotes it to
the final key, and upserts the D1 object index. A wrong staging digest never
creates a final object. Completion is idempotent after successful promotion.
Terminal sessions and staging objects are cleaned after expiry. Deleting a
final object removes its D1 row after R2 deletion, so the key can be reused and
no tombstone is retained.

## Lifecycle and retention

Register versions with a complete narinfo member list. Membership counters and
NAR reference counters are maintained in D1 batches. Shared NARs are deleted
only after their last live narinfo reference is removed. GC and deletion are
persistent, bounded, and retryable.

Retention values affect only GC. Change `DEFAULT_RETENTION_DAYS` and other
deployment values through Wrangler; change policies and pins through the admin
APIs. No deployment setting is stored in D1.

## Verification

```bash
curl -i https://cache.example.org/nix-cache-info
curl -i -H "Authorization: Bearer $READ_TOKEN" https://cache.example.org/nar/missing.nar
npm run typecheck
npm test
npm run build
```

Never log or commit tokens, presigned URLs, or raw Authorization headers.
