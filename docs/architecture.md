# Architecture

## Request path

The Worker routes `/nix-cache-info`, narinfo paths, `/nar/*` paths, and the
direct-upload control API through Hono. Authentication is applied before
mutation routes. Public GET and HEAD requests either query R2 through the
binding or redirect to a presigned R2 URL, while D1 supplies metadata-driven
headers for the binding-backed path. Normal PUT requests validate the path,
enforce immutable semantics, and index the result. Large direct uploads send
the file to R2 outside the Worker and use the Worker only for verification and
final indexing.

```text
Nix client
   |
   v
Hono route + auth + request ID
   |------------------------------|
   v                              v
R2 object bytes              D1 object index
   |                              |
   +---- dynamic TTL / version membership

Large CI NAR
   |
   +--> Worker creates session + presigned R2 URL
   |
   +--> direct PUT to R2 staging key
   |
   +--> Worker verifies, finalizes, and indexes canonical key
```

`bin/nix-cache-upload` owns this CI orchestration: it first materializes a
local Nix file cache, uploads every distinct NAR sequentially through the
session flow, then publishes the complete narinfo set and registers the
requested package/version. It does not change the stock Nix HTTP protocol.

## Storage boundaries

R2 is authoritative for object bytes and supports streaming single writes for
normal Worker PUTs plus staging objects used by direct uploads. D1 is
authoritative for searchable metadata and lifecycle
state: object indexes, narinfo-to-NAR references, packages, versions, tags,
policies, pins, jobs, and audit records. A D1 row must never be treated as a replacement
for an R2 object; narinfo acceptance checks both.

Direct upload staging keys use the `_nix_uploads/` prefix and are never served
by cache routes or indexed as cache objects. A completion request streams the
staging object through the Worker, recomputes SHA-256, and conditionally creates
the canonical `/nar/` object before writing its D1 row. Scheduled cleanup
removes expired and completed staging sessions in bounded batches.

## Package/version hierarchy

`artifact_packages` is the first-level grouping entity. Each package contains
many `artifact_versions`, identified by `(package_name, version_name)`. A
version owns many narinfo members through `artifact_version_members`; each
narinfo points to its NAR through `narinfo_refs`.

Version names are opaque and are never parsed. Re-registering a version replaces
its complete tags and member declaration while preserving its original
`registered_at` and every immutable cache object.

The version membership query also associates each member's referenced NAR with
the version. This lets both the narinfo and NAR receive the same effective
response TTL, while shared NAR payloads remain protected by live references.
Deletion transitions are persisted before a job is returned, while a
multi-batch registration holds its version in `registering`. Deletion only
claims active versions, and object deletion applies a live-reference guard at
the state transition; deleting object keys cannot be reused until cleanup
completes.

## Retention and jobs

Retention is evaluated for each version. A structured rule ANDs conditions on
package name, version name, all tags, or an individual tag value. Its `lastN`
count protects the newest matching versions independently in each computed
`groupBy` tuple. Overlapping rules union their protection, and the largest
matching finite duration applies unless the version has an explicit override.
An optional `capacityVersions` action is enforced independently for each
matching policy/group; versions ranked beyond the limit may be deleted before
their age-based retention expires. Pin and keep-latest protection remains
fail-safe when protected versions exceed capacity.
`registered_at` orders versions, not parsed version labels. GC and deletion use
persistent jobs and bounded batches so a Worker interruption can be retried
safely.

The default finite retention is seven days. The baseline migration seeds an
ordinary editable rule that protects the newest three versions in each exact
`(package_name, complete tags)` group; it can be changed or deleted from the
admin console.

HTTP TTL is separate from deletion authority. Unclassified objects use six
hours. Version-associated objects use the longest active-version retention. Pin
and keep-latest protect automatic GC only and do not change the HTTP TTL.

Full public GET responses use `caches.default` with a D1-backed cache
generation in the key. Version, rule, setting, and deletion updates advance
the generation so stale dynamic TTLs or deleted objects are not served from a
previous Worker cache entry. Range and conditional requests bypass the Worker
cache and retain the R2-backed protocol path.

## Admin surface

`/admin` is a static HTML console rendered as a single main-column view. After
successful validation, its token is kept in same-origin `sessionStorage` for
the current browser tab and sent as an Authorization header. A page reload
restores and validates the token before showing the console; an invalid token
is removed. The main view renders package rows, optional tag-group rows, and
expandable version and read-only file rows. Tag grouping is a client-side
layout toggle and does not change the package/version API data. `/api/admin/overview`
distinguishes package/version counts from direct cache-object counts so a valid
cache with unregistered objects is visible to operators.

## Observability

The Worker emits structured logs for cache hits/misses, R2 reads/writes,
served/uploaded bytes, and authentication failures. It does not run a
Prometheus server or expose credentials in logs.
