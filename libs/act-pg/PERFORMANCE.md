# `@rotorsoft/act-pg` performance evolution

This document tracks performance-relevant changes to the PostgreSQL
adapter. The core framework's `PERFORMANCE.md` (in
[`libs/act/PERFORMANCE.md`](../act/PERFORMANCE.md)) covers
adapter-independent optimizations; entries here are PG-specific.

## ACT-101 — cross-process commit→reaction latency (LISTEN/NOTIFY wakeup)

Reaction latency on poll-driven deployments is bounded below by the
correlate/drain interval (`start_correlations` default: 10 s; common
poll-loop tunings: 50–500 ms). Single-process apps can call `settle()`
directly after each `do()` and skip the poll, but cross-process
deployments — read replicas, projection workers, side-cars — cannot:
the second process has no event-loop signal that a write happened on
another node, so it has to poll.

`PostgresStore.notify` (added in this change) bridges that gap with
`LISTEN`/`NOTIFY` on a per-`(schema, table)` channel
(`act_commit_<schema>_<table>`). `commit()` issues one `NOTIFY` per
commit transaction with the full event batch as a JSON payload.
Subscribers get sub-poll wake-up; the orchestrator wires this in
automatically when the store opts in via `notify: true`. Default is
off — single-instance deployments pay zero overhead and existing
callers see no behavior change after upgrading.

Self-filter via a per-instance `_by` UUID embedded in the payload —
a store instance never receives its own commits, keeping the
`"notified"` lifecycle event a clean cross-process signal.

### Benchmark

Two `PostgresStore` instances on the same docker PG (port 5431,
`postgres:17-alpine`) simulate two processes:

- **Writer**: commits 30 single-event transactions on `stream-x` at
  30 ms intervals.
- **Reader**: an `Act` orchestrator with a reaction on the emitted
  event, target stream resolved per-source.

Two modes:

- **notify**: the reader's auto-wired `Store.notify` subscription
  triggers `settle({debounceMs: 0})` on each `notified` event.
- **polling**: notify subscription is torn down; reactions are driven
  by `setInterval(() => correlate() + drain(), 50ms)`.

Run: `pnpm -F @rotorsoft/act-pg exec vitest run --config vitest.bench.config.ts`

### Results

Numbers below are from a single run on macOS 25.4 (Apple Silicon),
docker PG on `localhost:5431`, no other load. Variance ±20 % — the
ratio is the meaningful thing.

| Mode    | p50    | p95    | p99    |
| ------- | ------ | ------ | ------ |
| notify  | 11 ms  | 15 ms  | 25 ms  |
| polling | 27 ms  | 54 ms  | 77 ms  |

Reading: notify-driven reactions land in roughly the time it takes to
complete a commit + receive a `LISTEN` notification + run a single
`settle` cycle. Polling mode adds the full interval (~POLL_INTERVAL_MS
on average for new events arriving mid-window) plus the cycle work.
At 50 ms polling, that delta is ~3× across all percentiles; at the
default `start_correlations` 10 s interval, the gap blows out to
~1000×.

### Why notify isn't always free

`LISTEN` checks out a dedicated client from the pool. Each subscribed
process holds one extra connection for the lifetime of the
subscription. For deployments running hundreds of stateless Act
processes against one PG, this is the budgeting line item to mind —
size the connection pool accordingly. There's also one extra
`pg_notify` SQL per commit on every writer that opted in. Both are
why the flag defaults off — `PostgresStore({ notify: true })` is the
explicit opt-in for multi-process deployments.

The wakeup is a hint, not a contract. Lost notifications (network
hiccup, pool exhaustion) are tolerated — the existing debounce/poll
path still drains correctly. So you can run with a longer poll
interval as a safety net while taking the notify happy-path latency
for free.
