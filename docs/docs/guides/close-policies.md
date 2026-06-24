---
id: close-policies
title: Online close-the-books policies
description: Declaring per-state close predicates so streams retire themselves on a cycle.
---

# Online close-the-books policies

Event-sourced streams accumulate. A ticketing app builds up resolved tickets that nobody reads anymore; a session store keeps minute-by-minute events for sessions that ended last week; an audit log rotates every 10 000 entries. The events are correct — they're just not interesting anymore, and they cost you index space, replay time, and `query_stats` latency.

The fix is to **close** stale streams: write a tombstone, truncate the events, the stream becomes inaccessible for new commits (`StreamClosedError`) and old commits (`StreamClosedError` on `app.load`). Alongside the explicit `app.close({ stream })` primitive, this guide covers the *declarative* online version: per-state predicates run on a background cycle.

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
- **`.archives(fn)`** decides **what to persist before truncate**. Runs while the stream is guarded (no concurrent writes); a thrown archiver leaves the stream guarded but un-truncated, the cycle retries the candidate on the next run. The optional companion to `.autocloses` — works whether or not the autoclose predicate is declared (it also runs for explicit `app.close({ stream, archive })` calls).

Build the app, opt in to the lifecycle, and the cycle runs forever:

```ts
const app = act()
  .withState(Ticket)
  .build({
    autocloseCycleMs: 43_200_000, // default 12 h
    closeBatchSize: 64,           // default 64
    closeYieldMs: 0,              // default 0 (microtask only)
    closeOnError: false,          // default false (skip predicate-throwing streams)
  });

app.start_correlations();   // also starts the autoclose ticker
// … run the app forever
await app.shutdown();       // stops the autoclose ticker
```

Operators who never call `start_correlations()` never start the cycle. Apps that declare no `.autocloses(...)` never even *construct* the controller — the cost story for an opt-out app is exactly the cost of allocating one `undefined` field on `Act`.

## The declarative `.autocloses({...})` form

Three operational pressure points cover the bulk of real workloads. `.autocloses` accepts either a predicate function (the long-tail escape hatch) or a declarative options object with verb-shaped fields that compose at the call site like a sentence:

```ts
.autocloses({
  is: "TicketResolved",      // domain lifecycle — head event in this set
  after: { days: 90 },       // AND time — head older than 90 days
})
```

Reads: *"autocloses is Resolved after 90 days."* Top-level fields combine with **AND** — the cycle truncates only when every condition holds. This captures the cooldown-after-terminal pattern that runs through almost every business app (close 90 days after `Resolved`, 14 days after `Delivered`, 30 days after a GDPR deletion request). For pure-OR backstops or mixed patterns, a separate `or: {...}` block opens an alternative path (see below).

Each field is optional and contributes independently. `.autocloses({})` throws at build time because empty config is a misconfiguration, not "match nothing." Validation runs through a Zod schema with `.strict()` enabled, so out-of-range values and unknown keys both surface at `act().build()`, not on the first cycle tick.

### `after: { days }` — time / compliance

"Close once the head event is older than X."

```ts
.autocloses({ after: { days: 90 } })
```

Workloads: GDPR/PII retention windows, session aggregates after N days idle, audit logs past statutory keep-window, abandoned drafts. The state may not have a terminal event but has a max-staleness budget.

`days` is a `number` (fractional accepted — `{ days: 1/24 }` is 1 hour). Resolved windows below one minute throw at build time; the cycle defaults to 12 h, so a stream closes on the next run after it ages past the window. Nested object leaves room for `{ hours }` / `{ ms }` if a real ask appears.

Cost: one timestamp comparison per stream per run.

### `is: "EventName"` — domain lifecycle

"Close once the head event reaches a designated terminal state."

```ts
.autocloses({ is: "TicketResolved" })
.autocloses({ is: ["Shipped", "Delivered", "Cancelled"] })
```

Workloads: resolved tickets, completed orders, expired sessions, withdrawn applications, deleted user accounts, completed/failed jobs. Every stream has a clear "I'm done" event (or set of events); once one is the head, the stream stays inactive.

Single string for the most common case (one terminal event); `readonly string[]` for multi-terminal states (`Order: Shipped | Delivered | Cancelled`). The compiled predicate matches `head.name` against the set; the act-builder still catches typo'd event names at build time via the existing event-registry check.

Cost: one set membership check per stream per run. Cheapest of the three.

### `reaches: N` — resource

"Close once the stream has accumulated N or more events."

```ts
.autocloses({ reaches: 10_000 })
```

Workloads: long-running chat threads, IoT telemetry streams, hot audit logs, event-loop counters — anything where the stream IS active but you want to rotate at a size threshold to keep reducer cost predictable.

Inclusive (`>=`) — the predicate fires at the moment the threshold is reached, not after.

Cost: `reaches` requires the cycle's `query_stats` to scan events (`count: true` triggers the full-scan path on PG/SQLite). Each batch is bounded to one `closeBatchSize` page, so the count scan never spikes with total stream count; for a cardinality-heavy fleet, schedule the run off live traffic via `autocloseWindow` and/or a longer `autocloseCycleMs`.

### Stacking — top-level AND + `or` block

Top-level fields are AND-combined. Two reasons that's the right default:

1. The **cooldown-after-terminal** pattern is universal. Close *after* `Resolved`, *after* `Delivered`, *after* a deletion request — all of these read as `is X AND after N` in English, and that's the matching semantics in the schema.
2. The conditions inside a typical primary policy are conjunctive ("the ticket must be Resolved *and* aged enough"), not disjunctive.

For pure-OR backstops or for mixing both shapes, use the optional `or: {...}` block. The policy fires when **either** the top-level AND group matches **or** any field inside `or` matches:

```ts
.autocloses({
  is: "TicketResolved",         // primary close trigger
  after: { days: 90 },          // AND aged 90 days (return window)
  or: { reaches: 10_000 },      // OR cardinality safety net (close at 10k regardless)
})
```

Reads: *"autocloses is Resolved after 90 days, or reaches 10k."*

The two-axis split mirrors the two ways close policies appear in practice:

- **Primary close logic** (AND-shaped) lives at the top level — the conditions that *must all hold* for a normal close.
- **Defensive backstops** (OR-shaped) live in `or` — independent triggers that close the stream regardless of the primary state, so unbounded growth doesn't escape the policy.

Pure-OR policies (no top-level fields, only `or`) work too: `.autocloses({ or: { is: "Resolved", reaches: 10_000 } })` reads "autocloses or is Resolved or reaches 10k" — close when either alone is true. The empty top-level AND group never satisfies its own path on its own; only the `or` block can fire in that case.

Multi-branch policies the schema doesn't express directly ("(`Resolved` + 90d) OR (`Cancelled` + 30d)" — different cooldowns per terminal) fall back to the function form:

```ts
.autocloses((_stream, head) => {
  const ageMs = Date.now() - head.created.getTime();
  if (head.name === "Resolved") return ageMs >= 90 * 86_400_000;
  if (head.name === "Cancelled") return ageMs >= 30 * 86_400_000;
  return false;
})
```

The declarative form covers ~90% of real policies in one line. The function form covers the long tail.

## What runs under the hood

Autoclose is low-urgency housekeeping. Each run sweeps the **whole** store in bounded pages, ordered by stream name. A run keysets through every stream `closeBatchSize` at a time: it fetches one page via `Store.query_stats({}, { count: true, exclude: [TOMBSTONE_EVENT], limit: closeBatchSize })`, and for each stream on the page:

1. Look up the owning state via `event_to_state.get(head.name)`.
2. Look up the state's predicate via `registry.autoclose_policy(owner.name)`.
3. If both exist, call `predicate(stream, head, count)`.
4. Eligible streams on the page flush as a single batch into `run_close_cycle(candidates)` — the same primitive `Act.close(targets)` uses, so the safety partition (one probe per batch), tombstone guard, archive-while-guarded, and atomic truncate all apply unchanged.

Between batches the run sleeps `closeYieldMs` (lets SQLite operators release the writer lock; PG/InMemory leave it at 0), then pages forward, looping until a short page ends the sweep. A single run therefore reaches every eligible stream; `closeBatchSize` bounds per-batch memory and write burst, not the total a run closes. The controller emits the `closed` lifecycle event for each batch that closed at least one stream, with the full `CloseResult` (`{ truncated, skipped }`).

A run repeats every `autocloseCycleMs` (default 12 h) — a couple of times a day, not a hot path. The optional `autocloseWindow` gate restricts runs to off-hours (below). The cost of the slow cadence is latency: an eligible stream closes on the next run, up to one `autocloseCycleMs` away (and only within the window if set). That's fine in practice, since autoclose eligibility always means "old" (past a retention age, or terminal plus a grace period), never "right now." Shorten `autocloseCycleMs` for a tighter bound.

### Off-hours window

`autocloseWindow: { start, end, timeZone? }` keeps runs out of peak traffic. The ticker still fires every `autocloseCycleMs`, but a tick only runs a sweep when the current hour is inside `[start, end)`. Hours are integers in `[0, 23]`, evaluated in `timeZone` (an IANA string, default `"UTC"`, DST-correct via `Intl`):

```ts
.build({
  autocloseWindow: { start: 22, end: 6, timeZone: "America/New_York" },
})
```

`start > end` is an overnight window (the example above runs 22:00–06:00). `start === end` is rejected at build. Omit the window to sweep on every tick. Every in-window tick runs a full sweep of the store, so size `autocloseCycleMs` to the window rather than expecting work to carry across ticks.

## Cost knobs in practice

The defaults — a 12-hour cycle, batch of 64, microtask yield — are sized for typical business-app workloads (hundreds to a few thousand streams in flight, terminal/retention predicates). Outside that envelope, dial:

| Knob | Default | When to raise | When to lower |
|---|---|---|---|
| `autocloseCycleMs` | `43_200_000` (12 h), range `[60_000, 86_400_000]` | Very-low-churn workloads where running more than once or twice a day buys nothing. | When eligible streams must close sooner than the worst-case one-cycle wait. Pair with `autocloseWindow` to keep frequent runs off peak traffic. |
| `closeBatchSize` | 64 | High-throughput Postgres where the truncate-roundtrip cost dominates and batching amortizes the per-batch safety probe. | SQLite (single-writer; large pages hold the lock too long) — pair with `closeYieldMs > 0`. |
| `closeYieldMs` | 0 | SQLite (10–50 ms is typical). Multi-tenant environments where the run competes with user requests on the same DB. | Default; PG and InMemory never need to raise it. |
| `autocloseWindow` | unset (every tick runs) | Set `{ start, end, timeZone? }` to confine runs to off-hours when cardinality `count` scans would compete with live traffic. | — |
| `closeOnError` | false | Defensive deployments — predicate exceptions mean "I can't evaluate, assume terminal." | Default; transient predicate bugs shouldn't auto-truncate live streams. |

## The archive contract

`.archives(fn)` runs **inside the close cycle's guard window** — same window the existing explicit `app.close({ stream, archive })` uses. The cycle:

1. Commits a tombstone marker with `expectedVersion`, locking the stream against concurrent writes.
2. Runs the archiver (`await fn(stream, head)`).
3. On success → calls `Store.truncate(targets)` to delete the events.
4. On thrown archiver → leaves the stream guarded but un-truncated. The error propagates to the cycle's `closed`-emission path; no events are lost. The cycle retries the candidate on the next run (which may succeed once the host fixes whatever broke).

The host is responsible for:

- **Idempotency.** A second archiver invocation on the same stream (after a previous run failed) must not re-add the same data to the destination. Most archivers achieve this via the stream name as the destination key (`s3.upload("tickets/" + stream, …)` overwrites the same key on retry).
- **Speed.** The archiver holds the stream's guard the whole time it runs. A 10-second archiver delays the truncate by 10 seconds and adds 10 seconds to the cycle's flush. Stage the heavy work to a queue if needed and let the archiver finish in a hundred milliseconds.
- **Storage durability.** The framework doesn't check whether the data made it to S3 — it only knows the archiver resolved. If the archiver acks early ("I queued the write, S3 ack TBD"), the framework will happily truncate before the queue drains.

## What this primitive is NOT for

- **Restart** (rotating a stream while keeping the entity alive). Online close always tombstones. Rotation stays on the explicit `app.close({ stream, restart: true })` path.
- **Cross-state coordination** ("close stream A only if B is closed"). Each state's predicate sees only its own candidates. Compose in the host's scheduler if you need it.
- **Hard real-time policy enforcement.** Runs repeat at `autocloseCycleMs` cadence (default 12 h), so a terminal event lingers until the next run before truncate — close is never same-second. If you need immediate close, call `app.close([{ stream }])` from the action handler that emits the terminal event.

## Pointers

- `.autocloses` / `.archives` declarators: `libs/act/src/builders/state-builder.ts`
- Declarative policy schema + compiler: `libs/act/src/internal/autoclose-policy.ts`
- Cycle function: `libs/act/src/internal/autoclose-cycle.ts`
- [Close-cycle architecture](../architecture/close-cycle.md) — explicit + online close in one pipeline
- [Error handling](../concepts/error-handling.md) — what `StreamClosedError` means for actions on a closed stream
