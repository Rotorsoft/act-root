# RFC 1125 — State projections: fold in memory, flush one upsert per stream

- **Issue:** [#1125](https://github.com/Rotorsoft/act-root/issues/1125)
- **Status:** accepted

## Motivation

The most common read model is a *list of the aggregates themselves*: the orders
list, the tickets list, the games list — one queryable row per stream, holding
the attributes the state already has. Today building that list means writing a
projection whose handlers re-derive state the framework already knows how to
fold, and paying one row-write per **event**: a rebuild over a 10M-event store
performs 10M upserts even when they collapse into 50k distinct rows.

Both problems have the same fix: fold events through the state's own reducers
in memory, per stream, and flush **one upsert per stream** per round. Write
amplification tracks the distinct-key count instead of the event count —
measured rebuild cost drops from O(events) to O(keys) row-writes per round.

## Surface

A third shape of the existing `projection()` builder — same factory, same
registration, no new top-level concept:

```typescript
import { act, projection } from "@rotorsoft/act";

const Orders = projection("orders")
  .of(Order, {
    flushEvery: 1_000,       // events folded between flush rounds
    maxCachedStates: 10_000, // LRU bound on in-memory folded states
  })
  .flush(async (rows) => {
    // rows: ReadonlyArray<StateRow<OrderState>> — one per DIRTY stream,
    // each carrying the stream's folded state at the round frontier.
    await db
      .insert(orders)
      .values(rows.map((r) => ({ id: r.stream, ...r.state })))
      .onConflictDoUpdate(/* keyed on id */);
  })
  .build();

const app = act().withState(Order).withProjection(Orders).build();
```

`projection("orders").of(Order)` reads as what it is — a projection *of* the
Order state. `.of()` is available on static-target projections and narrows the
builder to `.flush()` + `.build()`: a projection either folds a state or
declares per-event/batch handlers, never both.

New public surface (all additive):

| Item | Shape |
|---|---|
| `.of(state, options?)` | on the `projection(name)` builder; derives the event register and the fold from the built state |
| `.flush(handler)` | the only sink — receives dirty rows, writes them wherever the app queries them (the projections-to-database guide pattern) |
| `StateRow<S>` | `{ stream, state, version, event_id }` |
| `FoldOptions` | `{ flushEvery?, maxCachedStates? }` — Zod-validated (`FoldOptionsSchema` + `resolveFoldConfig` + `DEFAULT_*`, per the config-validation convention) |

**Scoping is by state type, and the state itself is the filter.** `.of(Order)`
derives the projection's event register from the state, and the subscription
fetch consumes exactly those event names — the same `names`-based query filter
every projection already uses. In a multi-state app this automatically scopes
the fold to Order streams: streams of other states never emit Order events.
There is deliberately **no instance-level (stream) filter**: a fold that skips
events of a stream it projects would produce a wrong state, and "a list of
only some instances" is custom-projection territory (`.on()/.do()`), not a
state projection. One state per `.of()`; a second list is a second
projection.

The fold is the state's own `init()` + `.patch()` reducers, with `__snapshot__`
events replacing state exactly as `load()` does. If the read model needs
anything the state does not carry, this feature is the wrong tool — per-event
and `.batch()` projections remain the escape hatch, unchanged.

## Semantics

- **Subscription:** one static target (the projection's `name`), consuming
  **all events of the state's register** across all of that state's streams —
  identical wiring to a static projection. Every event of a projected stream
  reaches the fold; nothing is skipped.
- **Fold engine:** drain feeds fetched events into an in-process cache keyed by
  source stream; each event applies the state reducer to the cached fold (init
  on first sight, snapshot replaces).
- **Flush round:** after `flushEvery` folded events (or end of fetched batch),
  `flush(rows)` receives every dirty state; on success the watermark acks to
  the last folded event id. Fold work is never acknowledged before it is
  durably flushed.
- **Memory pressure — explicit and deterministic:** the only bound is
  `maxCachedStates`. When admitting a new stream would exceed it, the LRU
  evictee is flushed first (flush-before-evict), then dropped. No heap
  heuristics, no timers — behavior is a pure function of the event sequence
  and the two options.
- **Idempotency — a contract, not a hope:** every row carries the max
  `event_id` folded into it. The documented `flush` contract is a monotonic
  upsert keyed on `stream`: write the row, ignore it if the stored
  `event_id` is already ≥ the incoming one. Under the single-writer watermark
  discipline plain converging upserts are already correct; the `event_id`
  guard additionally makes replays racing a live worker (e.g. rebuild beside
  traffic) order-safe. The projections-to-database guide ships the SQL shape.
- **Crash recovery:** a crash between rounds loses only unflushed in-memory
  folds; replay resumes from the persisted watermark and re-folds — the same
  monotonic upserts converge to the same rows. Standard at-least-once.
- **Rebuild:** `app.reset(["orders"])` replays through the same engine; this is
  where O(keys) vs O(events) pays.
- **Sliced states (v1):** `.of()` takes a single built State artifact.
  States composed from multiple same-name partials (`slice()` +
  `withSlice`) do not produce one artifact today — those keep per-event
  handlers; extending `.of()` to sliced compositions is future work.
- **Tombstones (v1):** a tombstoned stream's row simply stops updating at its
  final state; `.autocloses`/`restart` streams keep folding via their seeded
  snapshot. Row deletion is deliberately out of scope — a delete contract can
  be added later without breaking this surface.

## Alternatives considered

- **Userland `batchHandler`** — everyone reimplements the fold cache, LRU,
  flush-before-evict, and watermark discipline; the lost-fold bug (watermark
  past an unflushed fold) is exactly the kind of subtle correctness code the
  framework should own once.
- **Orchestrator-level replay option** (`app.reset(..., { fold: true })`) —
  not declarative; the projection's shape belongs on the projection.
- **Reusing `.batch()` with a flag** — the contract genuinely differs (rows of
  folded state vs raw event batches); overloading one method with two payload
  types trades a small surface for a permanent ambiguity.
- **A separate `list()` factory + `.withList()`** — rejected in review: the
  projection concept already covers "derived read model"; a sibling factory
  splits one idea across two registration verbs. `.of()` keeps the single
  declarative entry point. (`.from()` and `.folds()` were the runner-up verbs;
  `.of` reads best in the fluent chain.)
- **A built-in queryable list store** — a new port for what is fundamentally
  the app's own read database; rejected per the no-new-ports rule. `flush` is
  sink-injection, the one place helpers are allowed.

## Stability impact

Additive only: one new builder method on `projection()`, new exported types.
No change to existing projection shapes, ports, or lifecycle events. Registry gains an
internal discriminator for the list kind (not charter surface).

## Evidence plan

Per the benchmarking rule: before/after rebuild numbers on act-pg (docker
:5431) and act-sqlite in the adapter `PERFORMANCE.md`s — hot-key (10M events,
50k streams) and wide-key (10M events, 2M streams under `maxCachedStates`)
workloads vs the per-event and `.batch()` paths, plus a row in
`recipes/PERFORMANCE.md`. Contracts pinned by tests: crash-between-flush fault
injection, eviction-under-pressure proving flush-before-evict, watermark-never-
passes-unflushed-fold.
