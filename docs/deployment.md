# Deployment guide

This deployment intentionally rebuilds the cache. It accepts clearing the D1
database, all R2 objects, old CDN entries, and all old staging data.

## Prerequisites

Install Node.js, create or select a Cloudflare account, and authenticate
Wrangler:

```bash
npm install
npx wrangler login
```

The account needs Workers, R2, D1, and Worker Secret permissions. The Worker
does not need a Cloudflare API credential.

## 1. Create the resources

Create a new R2 bucket and a new D1 database when possible. Otherwise, use
read-only inspection and explicitly clear the existing deployment before
continuing:

```bash
npx wrangler r2 bucket create <R2_BUCKET_NAME>
npx wrangler d1 create <D1_DATABASE_NAME>
```

Copy and edit the ignored deployment file:

```bash
cp wrangler.jsonc.example wrangler.jsonc
```

Set the Worker name, R2 bucket, D1 database ID, account ID, presigned URL
TTLs, cache-info values, and optional public Nix signing key.

## 2. Clear the old deployment

Before applying the new schema, remove all old R2 objects, including
`_nix_uploads/`, and clear the old D1 database. The exact commands depend on
the account and are deliberately operator-confirmed. For a new D1 database
and bucket, this step is naturally satisfied.

Do not retain old migration history or try to apply `0002`, `0003`, or `0004`.
The new repository contains only `migrations/0001_initial.sql`.

## 3. Apply the single schema

```bash
npx wrangler d1 migrations apply <D1_DATABASE_NAME> --remote
```

The migration creates object indexes, reference counters, package/version
membership, policies, persistent jobs, combined `job_object_items`, GC
snapshots, audit records, short-lived `write_claims`, and staging
`upload_sessions`. It does not create `settings`, the old split deletion
tables, or any tombstone table.

## 4. Configure secrets and deploy

```bash
npx wrangler secret put WRITE_TOKEN
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put R2_S3_ACCESS_KEY_ID
npx wrangler secret put R2_S3_SECRET_ACCESS_KEY
# Configure READ_TOKEN only if Worker-authenticated reads are required.
npx wrangler secret put READ_TOKEN
npx wrangler deploy
```

The R2 S3 token must be scoped to the cache bucket and allow object reads and
writes needed for presigning. Keep all secret values out of source, D1, URLs,
logs, and persistent browser storage.

## 5. Choose a read entry point

If `READ_TOKEN` is empty, either use the Worker origin (which returns
presigned redirects) or attach an R2 Custom Domain. The Custom Domain is the
lowest-cost anonymous download path because it avoids Worker invocations.

If `READ_TOKEN` is non-empty, do not enable a public R2 Custom Domain. All
cache reads must enter through the Worker so it can enforce the read token.
The Worker redirects without querying D1 or calling R2 `HEAD`; R2 returns the
final 200/206/304/404/412 response.

For a Custom Domain, add a Cache Rule for `/nix-cache-info`, `/*.narinfo`, and
`/nar/*` with an approximately one-year edge TTL and cached 404s. This design
accepts stale reads after deletion and does not issue generation invalidations.

## 6. Publish cache-info for R2 Custom Domain

The Worker-generated response is:

```text
StoreDir: <DEFAULT_STORE_DIR>
WantMassQuery: <DEFAULT_WANT_MASS_QUERY>
Priority: <DEFAULT_PRIORITY>
```

Write those exact bytes to the R2 key `nix-cache-info` using the deployment
command in [`configuration.md`](configuration.md), with
`public, max-age=300` metadata. The cache rule may keep this object at the edge
longer, but clients must revalidate deployment values after five minutes.

## 7. Smoke test

```bash
curl -i https://cache.example.org/nix-cache-info
curl -i -H "Authorization: Bearer $READ_TOKEN" \
  https://cache.example.org/nar/does-not-exist.nar
npm run typecheck
npm test
npm run build
```

Then upload one NAR, upload its narinfo, register a version, and test a range
read. Use the admin console only for package/version/policy/pin/GC operations;
deployment values are changed in Wrangler and require redeployment.

## 8. Direct upload operation

The direct flow uses a random staging key and a persistent upload session:

```bash
curl --fail-with-body -X POST https://cache.example.org/api/uploads \
  -H "Authorization: Bearer $WRITE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"key":"nar/example.nar","size":123,"sha256":"<sha256>"}'

curl --fail-with-body -X POST https://cache.example.org/api/uploads/<uploadId>/complete \
  -H "Authorization: Bearer $WRITE_TOKEN"
```

The first response supplies an `uploadId`, staging presigned PUT URL, and
required headers. PUT the file to that random `_nix_uploads/<uploadId>` key
before calling its completion endpoint. A wrong digest never promotes a final
object. Completed, failed, expired, and revoked staging sessions are cleaned
after expiry. Version deletion revokes issued sessions, deletes R2, and then
removes the D1 object row; no tombstone is retained, so the final key can be
reused.

## Operations and recovery

Cron schedules bounded GC work. Version deletion and R2 cleanup are persisted
in D1 and safe to retry after a Worker interruption. An R2 delete failure
leaves the object item for the next job attempt. Shared NARs remain protected
by `narinfo_ref_count` until their final reference is removed.

For a future full rebuild, repeat the clear-D1/clear-R2 process and apply the
single initial migration. This is the supported migration strategy for the
best-effort architecture.
