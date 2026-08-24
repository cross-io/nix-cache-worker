# RFC-0014: scheduled and manual GC execution

- Status: Implemented
- Date: 2026-08-24

## Context

The current admin `Run GC` endpoint creates a persistent GC job and invokes
one job step. GC is intentionally split into bounded protection, evaluation,
and deletion steps, so the manual request commonly leaves the job queued until
the next daily Cron trigger. Repeated clicks also create multiple active GC
jobs. The current daily schedule makes this delay especially long.

## Goals and non-goals

- Run automatic GC every eight hours instead of once per day.
- Make a manual GC request start processing immediately and continue through a
  bounded number of queued job steps in the same Worker invocation.
- Make manual and scheduled GC requests idempotently share one active GC job.
- Preserve resumability for large scans and deletion batches; the Cron runner
  remains the recovery path for work that exceeds one invocation.
- Let the admin console observe completion and refresh the package table.

This RFC does not change retention eligibility, pin protection, object
reference safety, Nix HTTP behavior, or the bounded GC/deletion algorithms.

## Design

The Cron expression becomes `0 */8 * * *`, using the deployment's existing
Cloudflare Cron configuration. Each trigger gets or creates one active GC job
and runs the existing queued-job runner with a bounded limit.

Manual `POST /api/admin/gc` also gets or creates the same active GC job. Job
creation is conditional on the absence of an active `gc` job (`queued`,
`running`, or `failed`) so repeated requests return the existing job ID. The
request returns `202` promptly and schedules a bounded background drain using
the Worker execution context. The drain runs multiple rounds so a normal
single-page scan can complete protection, evaluation, and its deletion jobs
without waiting for Cron; larger work remains queued for the next drain or
Cron trigger.

The admin page polls `/api/admin/jobs/:jobId` for a short bounded period after a
manual request. The returned job represents the bounded GC scan; the scan may
already be completed while deletion child jobs remain queued. The console
refreshes the package table when the scan completes and says that queued
deletions may continue, so it does not imply that every eligible version has
already been deleted. It reports a still-running or failed job without hiding
the asynchronous nature of large GC runs.

## Invariants and security

- At most one active GC job is scheduled by the manual and Cron entry points.
- Job execution remains claim-based and bounded; concurrent drains cannot run
  the same job step simultaneously.
- Persistent GC and deletion state remains recoverable after Worker
  interruption.
- Existing admin authentication and audit logging apply to manual scheduling;
  Cron jobs continue to use the `cron` actor.
- No token or authorization header is added to job payloads, responses, or
  logs.

## Compatibility and migration

No Nix cache protocol or object schema change is required. The existing job
tables and payloads remain compatible. The scheduled trigger configuration is
updated in Wrangler, and operator documentation changes from daily to
eight-hour GC. Existing queued GC jobs are reusable by the new runner.

## Acceptance tests

- The Wrangler configuration schedules GC every eight hours.
- A manual GC request reuses an existing active GC job instead of creating a
  duplicate.
- A manual request advances a small GC job through its queued phases and
  deletes eligible unprotected versions without waiting for Cron.
- A large or interrupted GC remains queued/runnable and is resumed by a later
  drain or scheduled invocation.
- Cron and manual execution use the same bounded job runner.
- The admin page reports scan completion/failure, makes queued deletions
  explicit, and refreshes after a manual GC.
- Pinned and keep-latest-protected versions remain untouched.

## Implementation notes

Implemented in the job scheduler, manual admin endpoint, inline console,
Wrangler Cron configuration, documentation, and tests. Manual scheduling now
reuses active GC work and drains bounded rounds immediately; larger jobs remain
resumable through later drains and the eight-hour Cron trigger. The console
labels completion as GC scan completion because deletion child jobs can remain
queued after the parent scan job completes. No implementation deviations from
this RFC were required.
