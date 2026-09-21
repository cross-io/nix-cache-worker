# Nix Cache Worker

Nix Cache Worker is a Cloudflare Worker that provides an HTTP binary cache for Nix. It stores cache objects in Cloudflare R2 and keeps searchable package/version membership, retention policy, pin state, and garbage-collection state in Cloudflare D1.

This project is the storage target for CI-driven package publishing. CI is responsible for building packages and uploading them; this Worker does not build packages or orchestrate releases.

> **Status:** The v1 Worker implementation is present. Configure real R2/D1 bindings and Worker Secrets before deployment, then run the Nix end-to-end acceptance checks listed below.

## Product shape

One deployed Worker exposes two services on the same hostname:

1. A standard Nix HTTP binary cache for public reads and authenticated writes.
2. An authenticated web console and management API for packages, build versions, files, retention, pins, and garbage collection.

The HTTP layer uses Hono. Storage and lifecycle behavior stays in explicit R2, D1, domain, and job modules.

The storage responsibilities are deliberately separated:

- **R2** is the source of truth for object bytes.
- **D1** is the index and control plane for objects and package/version metadata.
- **Worker Secrets** are the source of truth for bearer tokens.

`bin/nix-cache-upload` is the supported zero-compile CI publisher. It exports a
complete local file cache, uploads every unique NAR to a random staging key,
completes the session through the Worker, publishes narinfos, and registers an
explicit package/version. Ordinary NAR PUT requests are intentionally rejected;
this is a non-compatible full rebuild.

## Cache API

The cache uses the conventional Nix binary-cache paths.

| Method | Path | Purpose | Auth |
| --- | --- | --- | --- |
| `GET`, `HEAD` | `/nix-cache-info` | Cache capability metadata | Public read or read token |
| `GET`, `HEAD` | `/<hash>.narinfo` | NAR metadata | Public read or read token |
| `GET`, `HEAD` | `/nar/<path>` | NAR payload | Public read or read token |
| `PUT` | `/<hash>.narinfo` | Upload NAR metadata | Write or admin token |
| `PUT` | `/nar/<path>` | Rejected; use the direct-upload API | Write or admin token |

Direct NAR upload control-plane endpoints:

| Method | Path | Purpose | Auth |
| --- | --- | --- | --- |
| `POST` | `/api/uploads` | Create a staging NAR upload session | Write or admin token |
| `POST` | `/api/uploads/<uploadId>/complete` | Verify staging and promote the NAR | Write or admin token |

There is no Worker NAR upload endpoint. `PUT /nar/*` returns
`405 direct_upload_required`; only `.narinfo` metadata is written with a
Worker `PUT`.

`POST /api/uploads` accepts `{ "key", "size", "sha256" }` and returns an
`uploadId` plus a presigned PUT for `_nix_uploads/<uploadId>`. After the
staging PUT, call `/api/uploads/<uploadId>/complete`. Completion verifies the
staging object, conditionally promotes it to the final key, and indexes it in
D1. Wrong staging content is never promoted. Sessions and staging objects are
cleaned after expiry; deleting a final object removes its D1 row after R2
deletion, with no tombstone.

### HTTP behavior

- `GET` and `HEAD` return the same cache metadata headers; `HEAD` does not return a body.
- NAR payloads support byte ranges with `Range`, `206 Partial Content`, `Content-Range`, and `416 Range Not Satisfiable` where appropriate.
- Every object response includes an object ETag and the correct `Content-Length` for the selected representation or byte range.
- `If-None-Match` returns `304 Not Modified` when the supplied ETag matches.
- `If-Match` is enforced for conditional writes and returns `412 Precondition Failed` when it does not match.
- Missing objects return `404 Not Found`.
- Malformed narinfo returns `422 Unprocessable Content`; a narinfo whose NAR dependency is missing returns `424 Failed Dependency`.
- Cache objects are immutable. A repeated PUT with identical bytes is an idempotent success; a PUT with different bytes never overwrites the existing object and returns a conflict response.
- NAR payloads never enter the Worker upload path. Narinfo PUTs remain
  Worker-managed so reference counters can be updated atomically.
- Cache object GET and HEAD requests redirect to a presigned R2 URL without a
  D1 lookup or R2 `HEAD`; the redirect is `no-store`. Worker Cache is retained
  only for the generated `/nix-cache-info` response. A `HEAD` request with a
  `Range` header uses the binding fallback for exact range metadata.

### Cache-Control defaults

| Path | Header |
| --- | --- |
| `/nar/*` and `*.narinfo` | `public, max-age=31536000, immutable` |
| `/nix-cache-info` | `public, max-age=300` |

Retention and deletion state never change object HTTP TTL. R2 Custom Domain
deployments should apply a long edge TTL to `/nix-cache-info`, `/*.narinfo`, and
`/nar/*`, including cached 404s. The cache-info object keeps its five-minute
client cache header so deployment configuration changes are not immutable at
the public URL. Stale content after deletion is accepted.

### `nix-cache-info`

The Worker returns the standard cache information document from Wrangler
variables. It does not query D1. For an R2 Custom Domain, deployment writes
the same bytes to the R2 `nix-cache-info` object. Worker Cache keys include the
public cache-info values, so redeploying with new values does not reuse the old
Worker-generated response.

### NARINFO consistency

When a `.narinfo` is uploaded, the Worker validates the core Nix metadata fields,
parses the referenced NAR URL, and verifies that the NAR object already exists in
R2 and in the D1 object index. The narinfo is rejected when the metadata is
malformed or the referenced NAR is missing. The NAR reference and its
`narinfo_ref_count` increment are committed in the same D1 batch, so GC can
mark a NAR for deletion only while it is ready and the counter is zero.

The supported upload order is therefore:

1. Upload the NAR payload.
2. Upload the corresponding `.narinfo`.
3. Optionally register the resulting narinfo objects into a package version.

This strict mode avoids serving metadata for an unavailable payload. The implementation must preserve this invariant even when uploads are retried or finalized through the direct-upload flow.

## Authentication

API requests use a simple bearer token:

```http
Authorization: Bearer <token>
```

For compatibility with the stock Nix HTTP uploader, the Worker also accepts
HTTP Basic credentials produced from a Nix `netrc` entry. The netrc password
must be the matching Worker Secret token; the username is ignored. Use this
only over HTTPS:

```text
machine nix-cache.example.com login nix password <write-token>
```

Bearer authentication remains the canonical API format. The Basic form remains
useful for Nix clients that read from a token-protected cache and do not provide
a custom Bearer header option.

The three tokens have separate roles:

| Principal | Read cache | Write cache | Register versions | Manage policy | Pin/unpin versions | Run GC | Delete versions |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| anonymous | Yes | No | No | No | No | No | No |
| `read-token` | Yes | No | No | No | No | No | No |
| `write-token` | Yes | Yes | Yes | No | No | No | No |
| `admin-token` | Yes | Yes | Yes | Yes | Yes | Yes | Yes |

Tokens are configured as Worker Secrets:

```text
READ_TOKEN
WRITE_TOKEN
ADMIN_TOKEN
```

Tokens must never be stored in source code, D1, URLs, cookies, browser persistent storage beyond the current tab session, or application logs. The web console stores a validated admin token only in same-origin `sessionStorage`, so a refresh in the same browser tab does not require another login. The token is cleared when the tab's page session ends and is never stored in `localStorage`.
The Worker hashes supplied and configured tokens to a fixed size and compares
them with Cloudflare Workers' `crypto.subtle.timingSafeEqual()` primitive.

R2 buckets and D1 databases are Worker bindings and must be configured with Wrangler or the Cloudflare Dashboard. The application web console manages runtime policy and package/version metadata; it cannot rewrite Worker bindings or Worker Secrets.

The public home page (`/`) opens with a client configuration guide containing
the official `cache.nixos.org` entries alongside this cache and the configured
`NIX_PUBLIC_SIGN_KEY`. When the public key variable is unset, the guide shows a
placeholder. The authenticated console keeps operational and CI publishing
instructions at the end of the page; the login page is unchanged.

## Packages, versions, and files

The management model is explicitly hierarchical:

- A **package** is a stable package name such as `hello`.
- A **version** is one opaque build identity within a package, identified by
  `(packageName, versionName)` and ordered by `registered_at`.
- A **file** is a narinfo member and its referenced NAR payload. A version can
  contain many narinfo/NAR file pairs, while shared payloads remain normalized.

Version names are required but are never parsed as semantic versions. Tags are
optional metadata on a version and use arbitrary string keys and values.

### CI version registration API

```http
PUT /api/packages/{packageName}/versions/{versionName}
Authorization: Bearer <write-token>
Content-Type: application/json
```

Example request:

```json
{
  "narinfoKeys": ["<hash-a>.narinfo", "<hash-b>.narinfo"],
  "tags": {
    "channel": "stable"
  },
  "retentionDays": 30
}
```

The registration endpoint is idempotent. It verifies that referenced narinfo
objects and their NAR payloads exist before adding the version membership
relation. Cache object bytes remain immutable, while authorized version
membership, tags, and the version retention override may be updated.

`PUT` is a complete declaration: omitted members and tags are removed from the
version. Both path components are URL-safe single segments of 1–128
characters. A version may contain at most 10,000 narinfo members.

Each version records a `registered_at` timestamp. Re-registering the same
package/version renews that timestamp, so finite retention age and
`keepLatestVersions` ordering reflect the latest successful complete
declaration. A new build version creates a new identity.

## Management console and API

The Worker serves an authenticated console at `/admin` and management endpoints under `/api/admin/*`.

The console can:

- List packages, expand build versions, and inspect each version's files, tags, object counts, byte sizes, and consistency state.
- Group versions within each package by their complete tag set with an optional, enabled-by-default display toggle; each tag group can be expanded independently.
- Filter by package name, version name, arbitrary tag values, and lifecycle state.
- Configure the default retention period.
- Configure structured retention rules with visual `where`, `group by`, `lastN`,
  and duration actions. Conditions support package name, package version, all
  tags, and individual tag values with equals, starts-with, ends-with, contains,
  and optional negation.
- Pin and unpin build versions.
- Immediately delete a build version.
- Run garbage collection on demand.
- Inspect unregistered objects and consistency errors.

The console does not expose arbitrary single-object overwrite or destructive
object editing. Package rows are grouping-only; version deletion is the
intended administrative deletion unit.

The implemented management endpoints are:

```text
GET    /api/admin/packages
GET    /api/admin/packages/{packageName}
GET    /api/admin/packages/{packageName}/versions/{versionName}
PATCH  /api/admin/packages/{packageName}/versions/{versionName}
PUT    /api/admin/packages/{packageName}/versions/{versionName}/pin
DELETE /api/admin/packages/{packageName}/versions/{versionName}/pin
DELETE /api/admin/packages/{packageName}/versions/{versionName}
GET    /api/admin/jobs/{jobId}
POST   /api/admin/gc
GET    /api/admin/policies
POST   /api/admin/policies
PUT    /api/admin/policies/{policyId}
DELETE /api/admin/policies/{policyId}
```

Version deletion returns `202 Accepted` with a persistent job ID. The console
starts the first batch immediately and exposes the job status while later
batches run.

## Retention, pinning, and garbage collection

Each build version may carry:

- An optional explicit `retentionDays` value.
- A `pinned` state.
- Arbitrary tags.
- `registered_at` and GC audit metadata.

Policies use the following structured shape:

```json
{
  "name": "stable-linux-builds",
  "conditions": [
    {"field": "pkg_name", "operator": "starts_with", "value": "hello"},
    {"field": "pkg_tag:channel", "operator": "equals", "value": "stable"}
  ],
  "groupBy": ["pkg_name", "pkg_tag:system"],
  "lastN": 3,
  "durationDays": 30,
  "capacityVersions": 20
}
```

All conditions are ANDed. Supported fields are `pkg_name`, `pkg_version`,
`pkg_tags`, and `pkg_tag:<tag>`. Supported operators are `equals`,
`starts_with`, `ends_with`, and `contains`; each condition may be negated.
`pkg_tags` is evaluated as sorted comma-separated `key=value` pairs, while a
missing `pkg_tag:<tag>` has the empty-string value.

`groupBy` determines the last-N partition. It can contain any supported field;
an empty list means one global group. The newest `lastN` matching versions in
each group are protected, ordered by `registered_at`, never by version-name
parsing. `durationDays` applies to each matching version that is not otherwise
protected. `capacityVersions` is an optional hard upper bound for each group;
the oldest unprotected versions beyond the bound may be removed before
`durationDays` expires. A rule may set any one or combination of these actions.
`null` means unlimited capacity and `0` allows no unprotected versions.

When rules overlap, keep-latest protection is the union of all matching rules,
and the finite duration is the largest matching `durationDays`. An explicit
version `retentionDays` override still wins for age-based retention. Capacity
constraints from matching rules are all enforced, while pin and keep-latest
protection remains effective even if it leaves a group above capacity. Existing
policy rows are cleared by the structured-rule migration and must be recreated
in the new editor.

The default GC retention is `DEFAULT_RETENTION_DAYS` (7 days in the template).
In addition to structured policies, the Worker protects the newest 3 versions
for every exact package-name and complete-tag combination. A Workers Cron
trigger runs GC every eight hours. Retention is used only by GC and never
changes HTTP cache headers.

Cache-info values (`StoreDir`, `Priority`, and `WantMassQuery`) are Wrangler
variables. There is no settings table or settings API; change deployment
values with Wrangler and redeploy.

### Pins and immediate deletion

Pinning protects a version from automatic GC only. An administrator can
explicitly delete a pinned version through the console after confirmation.

Immediate deletion:

- Locks the target version as `deleting` before returning the job ID, so a
  concurrent registration, metadata update, or pin operation cannot race it.
- Deletes the selected version and its membership metadata.
- Deletes associated narinfo objects only when no other live version references them.
- Deletes NAR payloads only when no other live narinfo references them.
- Runs in bounded batches to fit Worker and D1 limits.
- Records the actor, package/version target, timestamp, and reason in an audit log.

Deleting a version leaves sibling versions and its package grouping intact. A
future registration of the same package/version can create a fresh active
version after the delete job completes.

## Metrics and logs

The project does not run a Prometheus server or expose a `/metrics` endpoint. It emits structured Worker log events suitable for Cloudflare Workers Analytics and Logs:

- `cache_hit`
- `cache_miss`
- `r2_get`
- `r2_put`
- `bytes_served`
- `upload_bytes`
- `auth_failure`

Events include an event name, timestamp, request method, normalized object kind,
status, and relevant byte count. Tokens and raw authorization headers must never
be logged.

Recommended counting semantics:

- `cache_hit`: successful cache GET or HEAD for an available object.
- `cache_miss`: cache GET or HEAD returning `404`.
- `r2_get` and `r2_put`: completed R2 operations.
- `bytes_served`: bytes sent for successful GET responses, including the selected Range length.
- `upload_bytes`: bytes accepted for a new object, excluding idempotent duplicate uploads.
- `auth_failure`: rejected or malformed bearer or netrc/Basic authentication.

## Deployment

The complete first-time deployment guide is in
[`deployment.md`](deployment.md). The short version is:

```bash
cp wrangler.jsonc.example wrangler.jsonc
# Edit wrangler.jsonc and replace every resource placeholder.
npx wrangler login
npx wrangler d1 migrations apply <D1_DATABASE_NAME> --remote
# Configure READ_TOKEN only when Worker-authenticated reads are desired.
npx wrangler secret put READ_TOKEN
npx wrangler secret put WRITE_TOKEN
npx wrangler secret put ADMIN_TOKEN
npx wrangler deploy
```

`wrangler.jsonc` is intentionally ignored by Git because it contains
deployment-specific R2/D1 identifiers, hostname, and public signing-key
settings. Do not commit it; initialize it from
[`wrangler.jsonc.example`](../wrangler.jsonc.example) in each checkout. For local
development secrets, optionally run:

```bash
cp .dev.vars.example .dev.vars
```

The default operational variable is `DEFAULT_RETENTION_DAYS=7`. The baseline
migration seeds an editable `default-package-tags` rule that keeps the newest
three versions for each exact package-name and complete-tag combination.

Bindings and secrets are infrastructure configuration. The management console
can configure retention policies, tags, pins, and package/version metadata
after deployment, but cannot replace the R2 bucket, D1 database, or Worker
Secrets. A full rebuild clears D1, R2, `_nix_uploads/`, and edge cache before
applying the single initial migration.

The local test suite uses the Workers Vitest pool with local D1/R2 simulators.

## Acceptance checklist

The v1 implementation is complete when it can demonstrate:

- Real staging direct NAR publishing with `bin/nix-cache-upload` and Nix readback.
- GET, HEAD, Range, ETag, and conditional request behavior.
- The complete anonymous/read/write/admin permission matrix.
- Idempotent same-content PUT and conflict on different-content PUT.
- Rejection of narinfo that references a missing NAR.
- Correct Cache-Control and Content-Length values for every cache path.
- Idempotent package/version registration with preserved `registered_at`.
- Package/version/tag field conditions and operator matching.
- Structured retention rules matching fields and operators, grouping by package,
  version, all tags, and individual tags, and retaining last N per group.
- The seeded, editable default rule retaining the newest three versions per exact package-name and complete-tag combination.
- Pinned versions protected from automatic GC.
- Explicit, confirmed deletion of pinned versions by an administrator.
- Shared NAR payloads retained while still referenced.
- Management-console tokens scoped to the current browser tab and cleared when its page session ends.
- All documented structured log events emitted with safe fields.

## Development commands

```bash
npm install
npm run dev
npm run typecheck
npm test
npm run build
```

Architecture, operator configuration, and the required change-history process
are documented in [`architecture.md`](architecture.md),
[`configuration.md`](configuration.md), and [`deployment.md`](deployment.md).
The RFC process is documented in [`rfc/README.md`](rfc/README.md).

`npm run build` runs `wrangler deploy --dry-run`; it does not publish a Worker.
