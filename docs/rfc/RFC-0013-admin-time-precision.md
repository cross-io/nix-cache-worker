# RFC-0013: precise admin registration and retention time display

- Status: Implemented
- Date: 2026-08-24

## Context

The admin package table currently shows only the calendar date for
`registered_at` and rounds finite retention remaining time to whole days. This
does not give operators enough information when a version is close to its
retention threshold, and the clamped day value cannot distinguish an expired
version from one that is still within its retention period.

## Goals and non-goals

- Show `Registered` with date, hour, minute, and second in a 24-hour clock.
- Show finite retention remaining time using days, hours, minutes, or seconds,
  selecting the largest unit that applies.
- Show `Expired` in English and red when the finite retention threshold has
  passed.
- Keep persistent versions displayed as `persistent`.

This change does not alter retention policy evaluation, garbage-collection
eligibility, object TTL, storage schema, or the public Nix cache API.

## Design

The admin API keeps the existing display-only `retentionRemainingDays` field
for compatibility and adds `retentionRemainingSeconds`. The new field is
computed from `registered_at + effectiveRetentionDays` and the server's
current time, rounded up to whole seconds, and is `null` for persistent
versions. It is allowed to be negative so the console can render an expired
version.

The console formats finite values as follows:

1. negative values: `Expired`;
2. at least one day: `<N> days left`;
3. at least one hour: `<N> hours left`;
4. at least one minute: `<N> minutes left`;
5. otherwise: `<N> seconds left`.

The `Registered` value uses `Intl.DateTimeFormat` with explicit hour,
minute, second, and `h23` hour-cycle options. The browser locale continues to
control date ordering and separators.

## Invariants and security

- The new values are derived from existing metadata and do not change GC
  decisions.
- Persistent versions never display a finite countdown.
- No credentials or authorization headers are included in the response or
  formatted output.

## Compatibility and migration

No database migration or Nix HTTP compatibility change is required. Existing
admin API consumers may continue using `retentionRemainingDays`; new console
code uses `retentionRemainingSeconds` when available.

## Acceptance tests

- `Registered` output includes hour, minute, and second formatting with a
  24-hour clock.
- Finite versions with more than one day, less than one day, less than one
  hour, and less than one minute remaining use the expected unit.
- A negative remaining value renders `Expired` with the red status style.
- Pinned or keep-latest-protected versions still render `persistent`.
- The admin API exposes a precise remaining-seconds value and preserves the
  existing remaining-days field.

## Implementation notes

Implemented on the admin API and inline console UI. The admin API now exposes
precise remaining seconds while retaining the previous day field, and the
console renders 24-hour registration timestamps plus unit-aware remaining
time and red `Expired` status. No implementation deviations from this RFC
were required.
