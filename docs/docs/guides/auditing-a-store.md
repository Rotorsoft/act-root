---
id: auditing-a-store
title: Auditing a store
sidebar_position: 9
---

# Auditing a store

`app.audit(...)` is the operator's runbook in code form. Given a connected store, it answers the question **"what should I do with this store?"** by walking the relevant tables once and yielding per-category findings — each tagged with the remediation it suggests. Same operator-driven shape as `app.close()`, `app.reset()`, `app.unblock()`: never auto-invoked by the framework; you decide when to run it (CI gate, scheduled job, ad-hoc forensics) and what to do with the findings.

## Why this lives on `IAct` and not a separate package

Earlier drafts proposed a standalone `@rotorsoft/act-scan` tool. Reshaped because:

- The orchestrator already has the schema registry, the lane registry, the state-to-snapshot map, and the event-loading machinery. A standalone tool would re-import the registry separately (drift opportunity) and re-implement validation (the exact surface we want to *not* fork).
- Same operator-driven category as `app.close()` / `app.reset()` / `app.unblock()`. Each is "operator decides when this runs, framework never auto-invokes." Discipline lives in the calling pattern, not the packaging.
- `app.audit()` is right there in autocomplete next to the other operator primitives.

## The shape

```typescript no-check
import { app } from "./my-app.js";

// Run everything
for await (const finding of app.audit()) {
  console.log(finding);
}

// Narrow scope — common in scheduled audits
for await (const finding of app.audit(["schema", "deprecated-load"], {
  query: { created_after: lastScanTimestamp },
  thresholds: { deprecated_min: 0.10 },
})) {
  await escalate(finding);
}
```

Returns an `AsyncIterable` so callers can `break` early. Each finding lands as soon as its category's pass completes; nothing buffers the full report in memory.

## Single-scan multiplex

Every requested category contributes a *pass* with optional per-row callbacks. The dispatcher determines the union of needed data sources (events / streams / stats), runs each **once**, and broadcasts each row to all interested passes. Worst case: three scans total no matter how many categories you ask for.

Most categories share data — close-candidate, restart-candidate, snapshot-drift, deprecated-load, and routing-health all consume the same `query_stats` pass; schema, correlation-gaps, and clock-anomalies all hang off the same events walk. Categories that need follow-up work (snapshot-drift fetching the last `__snapshot__` per drifted stream, for example) do that in a `finalize` hook with targeted store calls.

## Categories

Each category answers a different operational question and pairs with a remediation.

### `schema` → "fix the data model"

Walks every event in the audit window, parses against the Zod schema the registry currently declares for its name. Two failure modes:

- **`unknown_event_name`** — event sits on disk, registry has no entry. Common after a rename in the builder without an `_v<n>` migration: events committed under the old name remain.
- **`schema_validation_failed`** — event matches a known name but fails the current schema. Common after tightening a schema in-place (added a required field, narrowed a type).

Findings carry the event id + stream so you can drill straight to the offending row. Zod's `error` object is forwarded for callers that want per-issue detail.

**Remediation:** rewrite the affected reducers, version the event (`Foo` → `Foo_v2`), or `app.close()` the poisoned streams.

### `deprecated-load` → "close the heaviest legacy carriers"

Workspace-wide event-name histogram classified by the framework's `_v<digits>` rule (ACT-403). For each deprecated event whose share of the total store equals or exceeds `deprecated_min` (default 0.10), yields a finding with the top-10 stream carriers sorted by per-stream count.

**Remediation:** `app.close([{stream}, ...])` on the heaviest carriers. The migration's already happened in the registry; this surfaces the rump on-disk that's still costing replay time.

### `close-candidate` → `app.close(...)`

Two flavours, evaluated per stream:

- **`idle`** — stream's head event committed more than `idle_days` (default 90) ago. The "stream has gone quiet" signal.
- **`terminal`** — stream's head event name is in the operator-supplied `terminal_events` list. The framework doesn't declare what's terminal for a domain (wrong scope); you pass a list like `["OrderShipped", "TicketClosed"]`.

Each finding carries `restart_supported`, derived from whether the stream's owning state declares a `.snap()` reducer. Drives the choice between `app.close([{stream}])` (full tombstone) and `app.close([{stream, restart: true}])` (truncate + seed snapshot).

### `restart-candidate` → `app.close([{stream, restart: true}])`

Streams above `restart_min` (default 10,000) whose owning state has a `.snap()` reducer. Restart shrinks the working set without losing state. Streams whose state doesn't support snapshots are silently skipped (restart wouldn't work) — they belong in the close-candidate buckets instead.

### `reaction-health` → `app.unblock(...)` / `app.reset(...)`

Three sub-statuses, evaluated per stream position:

- **`blocked`** — drain has given up on this stream. Remediation: investigate the underlying issue, then `app.unblock(stream)` or `app.reset(stream)` to replay.
- **`near-block`** — `retry >= near_block` (default 3) without yet being blocked. Heads-up that one more retry will tombstone the stream (if `blockOnError` is set on the reaction).
- **`stuck-backoff`** — `leased_until` is in the past but `leased_by` is still set. Either a worker crashed mid-attempt or the framework's in-process backoff is holding off the next retry while no other worker has re-claimed. Threshold: `stuck_minutes` (default 30).

### `snapshot-drift` → `load({snap: true})` or wait

Streams that have accumulated many events since their last `__snapshot__` marker. Cold loads without a snapshot pay the full replay cost on every load — operationally painful for hot read paths. Default threshold: `drift_min` (500 events). Skips streams whose owning state doesn't declare `.snap()`.

### `routing-health` → restart-with-new-config

- **`unknown-lane`** — stream subscription row's `lane` field isn't in the running registry's declared lane set. Happens when `withLane(...)` is renamed or removed but the streams table still pins existing streams to the deprecated name. Lane assignment is restart-driven (`subscribe()` UPSERTs lane on every call), so the resolution is "restart with the lane re-declared, or re-subscribe streams under the new name." The check compares against the app's **declared** lane universe (`default` plus every `.withLane` name), not the lanes whose controllers happen to be running on this instance — so a worker started with `onlyLanes: ["fast"]` does not false-flag a stream correctly assigned to the `slow` lane that a peer worker drains ([#1224](https://github.com/Rotorsoft/act-root/issues/1224)).
- **`unrouted`** — events in the store whose name has no registered reaction. Could be intentional (pure-projection events) or a bug (resolver typo, removed reaction). The audit surfaces the count; you decide.

### `correlation-gaps` → fix upstream correlator

Events whose `meta.causation.event.id` references a parent id not present in the audit window. Single-pass: collects ids and causation tuples during the shared event scan, post-processes in `drain`.

**Remediation:** fix the correlator misconfig that's writing dangling parent references. Doesn't necessarily mean data is corrupted — but it does mean the causation chain breaks for some events.

### `clock-anomalies` → infra remediation

Future-dated `created` timestamps and per-stream out-of-order commits. Surfaces clock skew during deploys, NTP drift, or container clock-jumps. Framework can't act on these directly — remediation is infrastructure-layer — but operators tend to ask "is anything weird in this store?" and a clock check is cheap to fold in.

## Recipes

### CI gate: fail the build on schema drift since the last release

```typescript no-check
import { app } from "./my-app.js";
import { exit } from "node:process";

const lastReleaseTime = new Date(process.env.LAST_RELEASE_AT!);
const findings: unknown[] = [];
for await (const f of app.audit(["schema"], {
  query: { created_after: lastReleaseTime },
})) {
  findings.push(f);
}
if (findings.length > 0) {
  console.error(`Schema drift since ${lastReleaseTime.toISOString()}:`);
  for (const f of findings) console.error(f);
  exit(1);
}
```

### Nightly cron: surface migration backlog to Slack

```typescript no-check
const deprecatedFindings: unknown[] = [];
for await (const f of app.audit(["deprecated-load"], {
  thresholds: { deprecated_min: 0.05 },
})) {
  deprecatedFindings.push(f);
}
if (deprecatedFindings.length > 0) {
  await slackPost("#ops", {
    text: `Heads up — ${deprecatedFindings.length} deprecated event families ≥ 5% of the store.`,
    attachments: deprecatedFindings.map((f) => ({ text: JSON.stringify(f) })),
  });
}
```

### Ad-hoc: which streams are ready to close?

```typescript no-check
for await (const f of app.audit(["close-candidate", "restart-candidate"], {
  thresholds: {
    idle_days: 60,
    terminal_events: ["OrderShipped", "TicketClosed"],
  },
})) {
  console.log(f);
}
```

### Scheduled health check: drain, snapshots, correlation

```typescript no-check
for await (const f of app.audit([
  "reaction-health",
  "snapshot-drift",
  "correlation-gaps",
])) {
  await emitMetric(f);
}
```

## Thresholds

All thresholds are operator-tunable per call:

| Threshold | Default | Used by |
|---|---|---|
| `idle_days` | 90 | `close-candidate` (idle) |
| `restart_min` | 10,000 | `restart-candidate` |
| `stuck_minutes` | 30 | `reaction-health` (stuck-backoff) |
| `near_block` | 3 | `reaction-health` (near-block) |
| `deprecated_min` | 0.10 | `deprecated-load` |
| `drift_min` | 500 | `snapshot-drift` |
| `terminal_events` | (none) | `close-candidate` (terminal) |

## What `app.audit()` does NOT do

- **Auto-remediation.** Surfaces candidates; you decide. No "auto-close idle streams" toggle.
- **Recurring scheduling.** You wire `app.audit()` into your own cron / CI / Slack-bot — the framework doesn't ship a scheduler.
- **Physical store health.** Fragmentation, table bloat, `VACUUM` pressure, partition rotation — those are *store-operator* concerns, not framework concerns, and they're per-adapter. The audit covers framework-aware questions where Act has insight the store layer doesn't.

## See also

- [Event schema evolution](../architecture/event-schema-evolution.md) — the `_v<digits>` rule that `schema` and `deprecated-load` build on.
- [Concurrency model](../architecture/concurrency-model.md) — how the streams table that `reaction-health` and `routing-health` read works.
- [Cache and snapshots](../architecture/cache-and-snapshots.md) — why `snapshot-drift` matters for load latency.
