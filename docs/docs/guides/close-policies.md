---
id: close-policies
title: Online close-the-books policies
description: Declaring per-state close predicates so streams retire themselves on a cycle.
---

# Online close-the-books policies

Event-sourced streams accumulate. A ticketing app builds up resolved tickets that nobody reads anymore; a session store keeps minute-by-minute events for sessions that ended last week; an audit log rotates every 10 000 entries. The events are correct — they're just not interesting anymore, and they cost you index space, replay time, and `query_stats` latency.

The fix is to **close** stale streams: write a tombstone, truncate the events, the stream becomes inaccessible for new commits (`StreamClosedError`) and old commits (`StreamClosedError` on `app.load`). The framework's already had the explicit `app.close({ stream })` primitive for a while; this guide covers the *declarative* online version that ships in #837 — per-state predicates run on a background cycle.

## What this guide answers

- How do I tell the framework "close this stream when X"?
- What does the cycle look like under load?
- How do I plug in archive (S3, cold tier, analytics warehouse) before truncate?
- What are the cost trade-offs of the cycle's knobs?
- Which policy fits which workload?

## Two declarators, one cycle

The state builder gains two new chainable methods. Both are state-level (one per state, last-write-wins, same semantics as `.snap` / `.discloses`). Absent → the state opts out entirely and pays zero per-cycle cost.

```ts
const Ticket = state({ Ticket: ticketSchema })
  .init(() => defaults)
  .emits({ TicketOpened, TicketResolved })
  // …
  .autocloses((stream, head, count) => head.name === "TicketResolved")
  .archives(async (stream, head) => {
    const events = await loadHistory(stream);
    await s3.upload(`tickets/${stream}.jsonl`, events);
  })
  .build();
```

- **`.autocloses(predicate)`** decides **when**. `predicate: (stream, head, count) => boolean`. The `head` argument is typed against the state's emitted-event union, so `head.name` autocompletes to `"TicketOpened" | "TicketResolved"` — typos fail at compile time.
- **`.archives(fn)`** decides **what to persist before truncate**. Runs while the stream is guarded (no concurrent writes); a thrown archiver leaves the stream guarded but un-truncated, the cycle retries the candidate next tick. The optional companion to `.autocloses` — works whether or not the autoclose predicate is declared (it also runs for explicit `app.close({ stream, archive })` calls).

Build the app, opt in to the lifecycle, and the cycle runs forever:

```ts
const app = act()
  .withState(Ticket)
  .build({
    autocloseCycleMs: 60_000,  // default 60 s
    closeBatchSize: 64,         // default 64
    closeYieldMs: 0,            // default 0 (microtask only)
    closeOnError: false,        // default false (skip predicate-throwing streams)
  });

app.start_correlations();   // also starts the autoclose ticker
// … run the app forever
await app.shutdown();       // stops the autoclose ticker
```

Operators who never call `start_correlations()` never start the cycle. Apps that declare no `.autocloses(...)` never even *construct* the controller — the cost story for an opt-out app is exactly the cost of allocating one `undefined` field on `Act`.

## The declarative `.autocloses({...})` form

Three operational pressure points cover the bulk of real workloads. `.autocloses` accepts either a predicate function (the long-tail escape hatch) or a declarative options object (#838) with verb-shaped fields that compose at the call site like a sentence:

```ts
.autocloses({
  after: { days: 90 },       // time — head older than 90 days
  is: "TicketResolved",      // OR domain lifecycle — head event in this set
  reaches: 10_000,           // OR resource — event count ≥ 10_000
})
```

Reads: *"autocloses after 90 days, is Resolved, reaches 10k."* Each field is optional and contributes independently. The compiled predicate returns `true` when **any** provided field matches — omitted fields contribute nothing. `.autocloses({})` throws at build time because empty config is a misconfiguration, not "match nothing." Validation runs through a Zod schema, so out-of-range values surface at `act().build()`, not on the first cycle tick.

### `after: { days }` — time / compliance

"Close once the head event is older than X."

```ts
.autocloses({ after: { days: 90 } })
```

Workloads: GDPR/PII retention windows, session aggregates after N days idle, audit logs past statutory keep-window, abandoned drafts. The state may not have a terminal event but has a max-staleness budget.

`days` is a `number` (fractional accepted — `{ days: 1/24 }` is 1 hour). Resolved windows below one minute throw at build time; the cycle tick itself defaults to 60 s so sub-minute windows can't be honored anyway. Nested object leaves room for `{ hours }` / `{ ms }` if a real ask appears.

Cost: one timestamp comparison per stream per tick.

### `is: "EventName"` — domain lifecycle

"Close once the head event reaches a designated terminal state."

```ts
.autocloses({ is: "TicketResolved" })
.autocloses({ is: ["Shipped", "Delivered", "Cancelled"] })
```

Workloads: resolved tickets, completed orders, expired sessions, withdrawn applications, deleted user accounts, completed/failed jobs. Every stream has a clear "I'm done" event (or set of events); once one is the head, the stream stays inactive.

Single string for the most common case (one terminal event); `readonly string[]` for multi-terminal states (`Order: Shipped | Delivered | Cancelled`). The compiled predicate matches `head.name` against the set; the act-builder still catches typo'd event names at build time via the existing event-registry check.

Cost: one set membership check per stream per tick. Cheapest of the three.

### `reaches: N` — resource

"Close once the stream has accumulated N or more events."

```ts
.autocloses({ reaches: 10_000 })
```

Workloads: long-running chat threads, IoT telemetry streams, hot audit logs, event-loop counters — anything where the stream IS active but you want to rotate at a size threshold to keep reducer cost predictable.

Inclusive (`>=`) — the predicate fires at the moment the threshold is reached, not after.

Cost: `reaches` requires the cycle's `query_stats` to scan events (`count: true` triggers the full-scan path on PG/SQLite). The cycle still bounds total work via `closeBatchSize`, but a cardinality-heavy fleet should size `autocloseCycleMs` larger (5–10 min) so the scan doesn't dominate CPU.

### Stacking — the OR composition

Real policies stack. A ticket should close when explicitly resolved **OR** after 2-year retention even if abandoned **OR** if cardinality blows up:

```ts
.autocloses({
  after: { days: 730 },         // 2-year retention floor
  is: "TicketResolved",         // OR explicit close
  reaches: 10_000,              // OR cardinality safety net
})
```

That's why the surface is one builder method, one object literal, no wrapping factory. Three separate factories (`retention(...) / terminal(...) / cardinality(...)`) would have forced callers into `anyOf(...)` ceremony at every site that stacks; the object literal makes OR the default and the wrapper unnecessary. AND semantics and per-stream metadata predicates aren't in scope — fall back to the function form (`.autocloses((stream, head, count) => ...)`) for those.

## What runs under the hood

`autoclose-cycle.ts` paginates the store's streams once per tick via `Store.query_stats({}, { count: true, exclude: [TOMBSTONE_EVENT] })`. For each stream:

1. Look up the owning state via `event_to_state.get(head.name)`.
2. Look up the state's predicate via `registry.autoclose_policy(owner.name)`.
3. If both exist, call `predicate(stream, head, count)`.
4. Eligible candidates batch up into a list; once the batch hits `closeBatchSize`, the cycle calls `run_close_cycle(candidates)` — the same primitive `Act.close(targets)` uses, so the safety partition, tombstone guard, archive-while-guarded, and atomic truncate all apply unchanged.
5. `closeYieldMs` pacing between batches lets SQLite operators release the writer lock; PG/InMemory operators leave it at 0.
6. The controller emits the `closed` lifecycle event once per tick that closed at least one stream, with the full `CloseResult` (`{ truncated, skipped }`).

The cycle never reinvents close-the-books — it just walks candidates into the existing pipeline.

## Cost knobs in practice

The defaults — 60-second cycle, batch of 64, microtask yield — are sized for typical business-app workloads (hundreds to a few thousand streams in flight, terminal/retention predicates). Outside that envelope, dial:

| Knob | Default | When to raise | When to lower |
|---|---|---|---|
| `autocloseCycleMs` | 60_000 | Cardinality predicates that scan events. Very-low-churn workloads where streams don't go terminal often. | High-churn workloads where streams pile up faster than a 60 s cycle can keep clean (rare). |
| `closeBatchSize` | 64 | High-throughput Postgres where the truncate-roundtrip cost dominates and batching amortizes. | SQLite (single-writer; large batches hold the lock too long) — pair with `closeYieldMs > 0`. |
| `closeYieldMs` | 0 | SQLite (10–50 ms is typical). Multi-tenant environments where the cycle competes with user requests on the same DB. | Default; PG and InMemory never need to raise it. |
| `closeOnError` | false | Defensive deployments — predicate exceptions mean "I can't evaluate, assume terminal." | Default; transient predicate bugs shouldn't auto-truncate live streams. |

## The archive contract

`.archives(fn)` runs **inside the close cycle's guard window** — same window the existing explicit `app.close({ stream, archive })` uses. The cycle:

1. Commits a tombstone marker with `expectedVersion`, locking the stream against concurrent writes.
2. Runs the archiver (`await fn(stream, head)`).
3. On success → calls `Store.truncate(targets)` to delete the events.
4. On thrown archiver → leaves the stream guarded but un-truncated. The error propagates to the cycle's `closed`-emission path; no events are lost. The cycle retries the candidate next tick (which may succeed once the host fixes whatever broke).

The host is responsible for:

- **Idempotency.** A second archiver invocation on the same stream (after a previous tick failed) must not re-add the same data to the destination. Most archivers achieve this via the stream name as the destination key (`s3.upload("tickets/" + stream, …)` overwrites the same key on retry).
- **Speed.** The archiver holds the stream's guard the whole time it runs. A 10-second archiver delays the truncate by 10 seconds and adds 10 seconds to the cycle's flush. Stage the heavy work to a queue if needed and let the archiver finish in a hundred milliseconds.
- **Storage durability.** The framework doesn't check whether the data made it to S3 — it only knows the archiver resolved. If the archiver acks early ("I queued the write, S3 ack TBD"), the framework will happily truncate before the queue drains.

## What this primitive is NOT for

- **Restart** (rotating a stream while keeping the entity alive). Online close always tombstones. Rotation stays on the explicit `app.close({ stream, restart: true })` path.
- **Cross-state coordination** ("close stream A only if B is closed"). Each state's predicate sees only its own candidates. Compose in the host's scheduler if you need it.
- **Hard real-time policy enforcement.** The cycle runs at `autocloseCycleMs` cadence; a 60 s window means a terminal event lingers up to 60 s before truncate. If you need same-second close, call `app.close([{ stream }])` from the action handler that emits the terminal event.

## Pointers

- `.autocloses` / `.archives` declarators: `libs/act/src/builders/state-builder.ts`
- Declarative policy schema + compiler: `libs/act/src/internal/autoclose-policy.ts`
- Cycle function: `libs/act/src/internal/autoclose-cycle.ts`
- [Close-cycle architecture](../architecture/close-cycle.md) — explicit + online close in one pipeline
- [Error handling](../concepts/error-handling.md) — what `StreamClosedError` means for actions on a closed stream
