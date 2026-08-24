# RFC process

This directory is the durable design record for Nix Cache Worker. Every
future change that affects public behavior, HTTP compatibility, authentication,
storage, schema, artifact-set semantics, retention, garbage collection,
deployment, or security must have a numbered RFC in this directory.

## Required workflow

1. Add the next available `RFC-NNNN-<short-name>.md` before implementing the
   change.
2. Describe the problem, scope, proposed design, invariants, compatibility and
   security impact, migration plan, and acceptance tests.
3. Set the status to `Proposed` while the design is being reviewed.
4. Update the status to `Accepted` when implementation begins, and record the
   implementation result and any deviations before marking the work complete.

Pure spelling, formatting, and comment-only changes do not require a new RFC.
If a change is intentionally reverted, update the RFC that introduced it or
add a short superseding RFC; do not silently erase the design history.

## RFC template

```markdown
# RFC-NNNN: Title

- Status: Proposed | Accepted | Implemented | Superseded
- Date: YYYY-MM-DD

## Context
## Goals and non-goals
## Design
## Invariants and security
## Compatibility and migration
## Acceptance tests
## Implementation notes
```

The RFCs currently recorded are:

- [RFC-0001: v1 architecture and compatibility baseline](RFC-0001-v1-architecture.md)
- [RFC-0002: dynamic TTL for unclassified and set-associated objects](RFC-0002-dynamic-object-ttl.md)
- [RFC-0003: cache overview for direct Nix uploads](RFC-0003-cache-overview.md)
- [RFC-0004: signed dev publishing and NixOS substitution](RFC-0004-signed-dev-publishing.md)
- [RFC-0005: hierarchical package/version artifacts and version-scoped retention](RFC-0005-hierarchical-package-version-retention.md)
- [RFC-0006: default version retention and tag-combination keep-latest protection](RFC-0006-default-retention-and-tag-groups.md)
- [RFC-0007: admin console session token and flat layout](RFC-0007-admin-console-session-token-and-flat-layout.md)
- [RFC-0008: admin tag-group layout](RFC-0008-admin-tag-group-layout.md)
- [RFC-0009: expressive retention rules and visual rule builder](RFC-0009-retention-rule-builder.md)
- [RFC-0010: consistency and job-recovery hardening](RFC-0010-consistency-and-job-recovery-hardening.md)
- [RFC-0011: admin retention remaining-time display](RFC-0011-admin-retention-remaining-time.md)
- [RFC-0012: re-registration renews version age](RFC-0012-reregistration-renews-version-age.md)
- [RFC-0013: precise admin registration and retention time display](RFC-0013-admin-time-precision.md)
- [RFC-0014: scheduled and manual GC execution](RFC-0014-gc-scheduling-and-manual-execution.md)
