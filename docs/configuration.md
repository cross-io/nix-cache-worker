# Configuration and operations

The first-time Cloudflare setup is documented in
[`deployment.md`](deployment.md). This page describes the runtime values and
operator workflow after the Worker configuration has been initialized.

## Private deployment configuration

The repository intentionally does not track `wrangler.jsonc`. Start from the
safe template in a fresh checkout:

```bash
cp wrangler.jsonc.example wrangler.jsonc
```

Replace the R2 bucket name, D1 database name and IDs, and any deployment
specific values before using Wrangler. The private file may contain a custom
hostname and public signing key, but it must remain ignored and must never be
committed.

For local-only secrets:

```bash
cp .dev.vars.example .dev.vars
```

Use real values only in the copied local file. Production authentication
values belong in Worker Secrets, not in `wrangler.jsonc`, D1, URLs, cookies,
browser persistent storage, or logs.

## Cloudflare bindings and variables

The checked-in example binds:

- `CACHE_BUCKET` to the R2 bucket containing immutable cache objects;
- `DB` to the D1 database containing indexes, memberships, policies, jobs, and
  audit metadata;
- an every-eight-hours `0 */8 * * *` Cron trigger for garbage collection.

The standard non-secret variables are:

```text
DEFAULT_STORE_DIR=/nix/store
DEFAULT_PRIORITY=40
DEFAULT_WANT_MASS_QUERY=1
DEFAULT_RETENTION_DAYS=7
NIX_PUBLIC_SIGN_KEY=<optional-public-signing-key>
R2_ACCOUNT_ID=<cloudflare-account-id>
R2_BUCKET_NAME=<cache-bucket-name>
DIRECT_UPLOAD_URL_TTL_SECONDS=3600
DIRECT_DOWNLOAD_URL_TTL_SECONDS=900
```

`NIX_PUBLIC_SIGN_KEY` is public metadata used by the home page's Nix client
example. The product footer always links to the canonical project repository.
Neither setting is a bearer secret.
`R2_ACCOUNT_ID` and `R2_BUCKET_NAME` are used to construct the R2 S3 endpoint
for presigned URLs. Presigned URLs use the R2 S3 API hostname and cannot use
the Worker's custom domain.
`DIRECT_DOWNLOAD_URL_TTL_SECONDS` is optional. When configured between 60
seconds and seven days, supported NAR and narinfo GET/HEAD requests receive a
short-lived `307` redirect to R2. The redirect is `no-store`; R2 is the source
of truth and returns the final Range, ETag, and conditional response. Missing
objects, and objects written before direct reads were enabled, stay on the
binding-backed Worker path. Omit the setting to keep binding-backed Worker
reads for every object.

## Worker Secrets

Configure the independent authentication roles through Wrangler or the
Cloudflare Dashboard:

```bash
npx wrangler secret put READ_TOKEN
npx wrangler secret put WRITE_TOKEN
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put R2_S3_ACCESS_KEY_ID
npx wrangler secret put R2_S3_SECRET_ACCESS_KEY
```

Keep the values out of shell history where possible and never print them.
`READ_TOKEN` permits authenticated reads, `WRITE_TOKEN` permits cache writes
and version registration, and `ADMIN_TOKEN` permits policy, pin, GC, and
version-deletion operations. Anonymous cache reads remain enabled.

The R2 S3 credentials must be a bucket-scoped R2 API token with object read and
write permissions. They are used only by the Worker to create short-lived
presigned upload and download URLs and must never be sent to CI clients.

## Nix clients and publishers

Reads use the deployment's HTTPS origin. Keep `cache.nixos.org` and its
official key when adding this cache to NixOS or nix-darwin. The public `/` page
renders the current request origin and configured public key into a complete
example.

For `nix copy --to`, create a mode-0600 netrc entry whose password is the Worker
write secret. The Basic form is a compatibility mechanism for Nix clients and
must be used only over HTTPS:

```text
machine cache.example.org login nix password <WRITE_TOKEN>
```

The management console also shows the standard `nix copy` and version
registration commands after an administrator logs in. Standard `nix copy`
remains the compatibility path for ordinary-sized objects. A NAR larger than
the Worker request-body limit must use the direct-upload API:

```text
POST /api/uploads
Authorization: Bearer <WRITE_TOKEN>
Content-Type: application/json

{"key":"nar/example.nar","size":123456789,"sha256":"<lowercase sha256>"}
```

The response contains `uploadId`, `uploadUrl`, and `uploadHeaders`. Send one
direct `PUT` to `uploadUrl` with those headers and the exact file length, then
complete the session:

```bash
curl --fail-with-body -X PUT "$UPLOAD_URL" \
  -H 'Content-Type: application/octet-stream' \
  -H 'If-None-Match: *' \
  --data-binary @result.nar

curl --fail-with-body -X POST \
  "https://cache.example.org/api/uploads/$UPLOAD_ID/complete" \
  -H "Authorization: Bearer $WRITE_TOKEN"
```

Only after completion should the corresponding `.narinfo` be uploaded through
the normal cache PUT path. The direct flow uses one R2 single-object PUT and is
not resumable; its maximum is the R2 single-upload limit.

Stock `nix copy --to` cannot be transparently redirected to a presigned PUT:
it has no upload-session discovery phase, and a redirect still places its
request body at the Worker. CI publishers must use the explicit session API
for direct NAR uploads. In contrast, `nix copy --from` and `nix store cat`
follow the optional presigned GET/HEAD redirects automatically.

## Package/version lifecycle

Upload NARs first, then narinfos, then register the complete build version:

```text
PUT /api/packages/{packageName}/versions/{versionName}
Authorization: Bearer <write-token>
```

The registration body lists all narinfo members and may include arbitrary tags
and a version-level retention override. Registration is idempotent: an existing
package/version identity is accepted again and its successful registration
renews `registered_at`. Version names are opaque and are never parsed for
ordering.

## Retention and garbage collection

The baseline migration seeds an editable rule that protects the newest three
versions for each exact package name and complete tag combination. The default
finite retention is seven days. Administrators can change the default, create
structured rules, pin versions, run GC, and request confirmed deletion from
the console. A structured rule may also set `capacityVersions` to limit the
number of active versions tolerated by each computed group; omitted or `null`
means unlimited.

Pins protect versions from automatic GC only. Explicit deletion of a pinned
version requires confirmation and is recorded in the audit log. Persistent GC
and deletion jobs process bounded batches and can resume after a Worker
interruption.

## Verification and observability

After deployment, check `/nix-cache-info`, the admin console, a NAR Range
request, and a signed `nix copy --from` or `nix store cat --store` operation.
Run the repository checks with:

```bash
npm run typecheck
npm test
npm run build
```

The Worker emits structured events for cache hits/misses, R2 reads/writes,
served/uploaded bytes, and authentication failures. Logs contain safe request,
status, object-kind, and byte-count fields only; tokens and raw
`Authorization` headers must never appear.
