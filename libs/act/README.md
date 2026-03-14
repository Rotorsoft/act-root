# @rotorsoft/act

[![NPM Version](https://img.shields.io/npm/v/@rotorsoft/act.svg)](https://www.npmjs.com/package/@rotorsoft/act)
[![NPM Downloads](https://img.shields.io/npm/dm/@rotorsoft/act.svg)](https://www.npmjs.com/package/@rotorsoft/act)
[![Build Status](https://github.com/rotorsoft/act-root/actions/workflows/ci-cd.yml/badge.svg?branch=master)](https://github.com/rotorsoft/act-root/actions/workflows/ci-cd.yml)
[![Coverage Status](https://coveralls.io/repos/github/Rotorsoft/act-root/badge.svg?branch=master)](https://coveralls.io/github/Rotorsoft/act-root?branch=master)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

[Act](../../README.md) core library - Event Sourcing + CQRS + Actor Model framework for TypeScript.

## Installation

```sh
npm install @rotorsoft/act
# or
pnpm add @rotorsoft/act
```

**Requirements:** Node.js >= 22.18.0

## Quick Start

```typescript
import { act, state } from "@rotorsoft/act";
import { z } from "zod";

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ amount: z.number() }) })
  .patch({  // optional — only for events needing custom reducers (passthrough is the default)
    Incremented: ({ data }, state) => ({ count: state.count + data.amount }),
  })
  .on({ increment: z.object({ by: z.number() }) })
    .emit((action) => ["Incremented", { amount: action.by }])
  .build();

const app = act().withState(Counter).build();

await app.do("increment", { stream: "counter1", actor: { id: "1", name: "User" } }, { by: 5 });
const snapshot = await app.load(Counter, "counter1");
console.log(snapshot.state.count); // 5
```

## Projections & Slices

Use `projection()` to build read-model updaters and `slice()` for vertical slice architecture. Use `.withState()`, `.withSlice()`, and `.withProjection()` to compose them:

```typescript
import { projection, slice } from "@rotorsoft/act";

// Projection — read-model updater, handlers receive (event, stream)
const CounterProjection = projection("counters")
  .on({ Incremented: z.object({ amount: z.number() }) })
    .do(async ({ stream, data }) => { /* update read model */ })
  .build();

// Slice — partial state + scoped reactions, handlers receive (event, stream, app)
// Projections can be embedded in slices when their events are a subset of the slice's events
const CounterSlice = slice()
  .withState(Counter)
  .withProjection(CounterProjection)  // embed projection (events must be subset of slice events)
  .on("Incremented")
    .do(async (event, _stream, app) => { /* dispatch actions via app */ })
    .void()
  .build();

// Standalone projections work at the act() level for cross-slice events
const app = act().withSlice(CounterSlice).build();
```

## Related

- [@rotorsoft/act-pg](https://www.npmjs.com/package/@rotorsoft/act-pg) - PostgreSQL adapter for production deployments
- [Full Documentation](https://rotorsoft.github.io/act-root/)
- [API Reference](https://rotorsoft.github.io/act-root/docs/api/)
- [Examples](https://github.com/rotorsoft/act-root/tree/master/packages)

---

## Event Store

The event store serves as the single source of truth for system state, persisting all changes as immutable events. It provides both durable storage and a queryable event history, enabling replayability, debugging, and distributed event-driven processing.

### Append-Only, Immutable Event Log

Unlike traditional databases that update records in place, the event store follows an append-only model:

- All state changes are recorded as new events — past data is never modified.
- Events are immutable, providing a complete historical record.
- Each event is time-stamped and versioned, allowing state reconstruction at any point in time.

This immutability is critical for auditability, debugging, and consistent state reconstruction across distributed systems.

### Event Streams

Events are grouped into streams, each representing a unique entity or domain process:

- Each entity instance (e.g., a user, order, or transaction) has its own stream.
- Events within a stream maintain strict ordering for correct state replay.
- Streams are created dynamically as new entities appear.

For example, an Order aggregate might have a stream containing:

1. `OrderCreated`
2. `OrderItemAdded`
3. `OrderItemRemoved`
4. `OrderShipped`

Reconstructing the order's state means replaying these events in sequence, producing a deterministic result.

### Optimistic Concurrency

Each event stream maintains a version number for conflict detection:

- When committing events, the system verifies the stream's version matches the expected version.
- If another process has written events in the meantime, a `ConcurrencyError` is thrown.
- The caller can retry with the latest stream state, preventing lost updates.

This ensures strong consistency without heavyweight locks.

```typescript
// Version is tracked automatically — concurrent writes to the same stream are detected
await app.do("increment", { stream: "counter1", actor }, { by: 1 });
```

### Querying

Events can be retrieved in two ways:

- **Load** — Fetch and replay all events for a given stream, reconstructing its current state:
  ```typescript
  const snapshot = await app.load(Counter, "counter1");
  ```
- **Query** — Filter events by stream, name, time range, correlation ID, or position, with support for forward and backward traversal:
  ```typescript
  const events = await app.query_array({ stream: "counter1", names: ["Incremented"], limit: 10 });
  ```

### Snapshots

Replaying all events from the beginning for every request can be expensive for long-lived streams. Act supports configurable snapshotting:

```typescript
const Account = state({ Account: schema })
  // ...
  .snap((snap) => snap.patchCount >= 10) // snapshot every 10 events
  .build();
```

When loading state, the system first loads the latest snapshot and replays only the events that came after it. For example, instead of replaying 1,000 events for an account balance, the system loads a snapshot and applies only the last few transactions.

### Storage Backends

The event store uses a port/adapter pattern, making it easy to swap implementations:

- **InMemoryStore** (included) — Fast, ephemeral storage for development and testing.
- **[PostgresStore](https://www.npmjs.com/package/@rotorsoft/act-pg)** — Production-ready with ACID guarantees, connection pooling, and distributed processing.

```typescript
import { store } from "@rotorsoft/act";
import { PostgresStore } from "@rotorsoft/act-pg";

// Development: in-memory (default)
const s = store();

// Production: inject PostgreSQL
store(new PostgresStore({ host: "localhost", database: "myapp", user: "postgres", password: "secret" }));
```

Custom store implementations must fulfill the `Store` interface contract (see [CLAUDE.md](../../CLAUDE.md) or the source for details).

### Cache

Cache is always-on with `InMemoryCache` as the default. It avoids full event replay on every `load()` by storing the latest state checkpoint in memory. On `load()`, the cache is checked first — only events committed after the cached position are replayed from the store. Actions update the cache automatically after each successful commit and invalidate on concurrency errors.

```typescript
import { cache } from "@rotorsoft/act";

// Cache is active by default (InMemoryCache, LRU, maxSize 1000)
// load() and action() use it transparently — no setup needed

// Replace with a custom adapter (e.g., Redis) for distributed caching:
cache(new RedisCache({ url: "redis://localhost:6379" }));
```

The `Cache` interface is async, so you can implement adapters backed by Redis or other external caches. `InMemoryCache` is included as a fast, in-process LRU implementation.

#### Snapshots vs Cache

Cache and snapshots are the same checkpoint pattern at different layers:

- **Cache** (in-memory) — checked first on every `load()`. Eliminates store round-trips entirely on warm hits.
- **Snapshots** (in-store) — written to the event store as `__snapshot__` events. Used as a fallback on cache miss (cold start, eviction, process restart) to avoid replaying the entire event stream.

On cache hit, snapshot events in the store are skipped (`with_snaps: false`). On cache miss, the store is queried with `with_snaps: true` to find the latest snapshot and replay only events after it.

#### Benchmark Results

`load()` throughput in ops/s — higher is better. Benchmarks measure warm-cache reads (cache populated during seeding, then `load()` called repeatedly).

**PostgresStore** — production adapter, async I/O:

| Events | No snap | @10 | @50 | @75 | @100 |
|---:|---:|---:|---:|---:|---:|
| **50** | 4,872 | 5,881 | 6,480 | **7,058** | 6,949 |
| **500** | **6,371** | 5,639 | 5,590 | 6,223 | 5,488 |
| **2,000** | 4,257 | **5,329** | 4,573 | 4,812 | 4,039 |

**InMemoryStore** — test/dev adapter:

| Events | No snap | @10 | @50 | @75 | @100 |
|---:|---:|---:|---:|---:|---:|
| **50** | 837 | 803 | 829 | 821 | **850** |
| **500** | 846 | 842 | 849 | 846 | **854** |
| **2,000** | **859** | 857 | 848 | 828 | 839 |

> **Why is InMemoryStore slower than PG?** Every `InMemoryStore` method starts with `await sleep(0)` (`setTimeout(resolve, 0)`) to simulate async behavior. This event-loop yield costs ~1ms per call, capping throughput at ~1,000 ops/s regardless of stream length. PG's indexed query for 0 new events returns in ~0.15ms. The InMemory numbers are artificially bounded — they measure event-loop overhead, not cache performance.

**Compared to pre-cache baselines** (PG, no cache):

| Events | Without cache | With cache | Speedup |
|---:|---:|---:|---:|
| **50** | 655 | 4,872 | **7×** |
| **500** | 215 | 6,371 | **30×** |
| **2,000** | 92 | 4,257 | **46×** |

Without cache, every `load()` replays the full event stream from PG — throughput degrades linearly with stream length (655 → 92 ops/s). With always-on cache, throughput is flat (~4,000–7,000 ops/s) regardless of stream length.

Key takeaways:

- **Cache is the dominant optimization** — 7–46× speedup over uncached PG reads. The benefit scales with stream length because longer streams have more events to skip.
- **Stream length doesn't matter for warm reads** — 50 and 2,000 events perform within ~30% of each other. The cache absorbs replay cost entirely.
- **Snap interval is noise for warm reads** — all snap configurations perform within benchmark variance. Snaps only affect cold starts (cache miss, process restart, LRU eviction).
- **Snap write contention is visible on long streams** — at 2,000 events, snap configurations show more variance due to fire-and-forget `snap()` writing to PG asynchronously. This contention is minor but measurable.
- **Optimal snap interval for cold starts** — @50–@75 balances cold-start replay savings against write overhead. @10 is too frequent (excessive writes), @100 is too infrequent (long replays on cache miss).

### Performance Considerations

- **Cache is always-on** — warm reads skip the store entirely, delivering consistent throughput regardless of stream length. No configuration needed.
- **Use snapshots for cold-start resilience** — on process restart or LRU eviction, snaps limit how much of the event stream must be replayed. Set `.snap((s) => s.patches >= 50)` for most use cases.
- **Cache invalidation is automatic** — concurrency errors (`ERR_CONCURRENCY`) invalidate the stale cache entry, forcing a fresh load from the store on the next access.
- **Snap writes are fire-and-forget** — `snap()` commits to the store asynchronously after `action()` returns. The cache is updated synchronously within `action()`, so subsequent reads see the post-snap state immediately without waiting for the store write.
- Events are indexed by stream and version for fast lookups, with additional indexes on timestamps and correlation IDs.
- The PostgreSQL adapter supports connection pooling and partitioning for high-volume deployments.
- Active event streams remain in fast storage; consider archival strategies for very large datasets.

## Event-Driven Processing

Act handles event-driven workflows through stream leasing and correlation, ensuring ordered, non-duplicated event processing without external message queues. The event store itself acts as the message backbone — events are written once and consumed by multiple independent reaction handlers.

### Reactions

Reactions are asynchronous handlers triggered by events. They can update other state streams, trigger external integrations, or drive cross-aggregate workflows:

```typescript
const app = act()
  .withState(Account)
  .withState(AuditLog)
  .on("Deposited")
    .do((event) => [{ name: "LogEntry", data: { message: `Deposit: ${event.data.amount}` } }])
    .to((event) => `audit-${event.stream}`)  // resolver determines target stream
  .build();
```

Resolvers dynamically determine which stream a reaction targets, enabling flexible event routing without hardcoded dependencies. They can include source regex patterns to limit which streams trigger the reaction.

### Stream Leasing

Rather than processing events immediately, Act uses a leasing mechanism to coordinate distributed consumers. The application fetches events and pushes them to reaction handlers by leasing correlated streams:

- **Per-stream ordering** — Events within a stream are processed sequentially.
- **Temporary ownership** — Leases expire after a configurable duration, allowing re-processing if a consumer fails.
- **Backpressure** — Only a limited number of leases can be active at a time, preventing consumer overload.

If a lease expires due to failure, the stream is automatically re-leased to another consumer, ensuring no event is permanently lost.

### Event Correlation

Act tracks causation chains across actions and reactions using correlation metadata:

- Each action/event carries a `correlation` ID (request trace) and `causation` ID (what triggered it).
- Reactions can discover new streams to process by querying uncommitted events with matching correlation IDs.
- This enables full workflow tracing — from the initial user action through every downstream reaction.

```typescript
// Correlate events to discover new streams for processing
await app.correlate();

// Or run periodic background correlation
app.start_correlations();
```

### Parallel Execution with Retry and Blocking

While events within a stream are processed in order, multiple streams can be processed concurrently:

- **Parallel handling** — Multiple streams are drained simultaneously for throughput.
- **Retry with backoff** — Transient failures trigger retries before escalation.
- **Stream blocking** — After exhausting retries, a stream is blocked to prevent cascading errors. Blocked streams can be inspected and unblocked manually.

### Draining

The `drain` method processes pending reactions across all subscribed streams:

```typescript
// Process pending reactions (synchronous, single cycle)
await app.drain({ streamLimit: 100, eventLimit: 1000 });

// Debounced correlate→drain for production (non-blocking, emits "settled" when done)
app.settle();

// Subscribe to the "settled" lifecycle event
app.on("settled", (drain) => {
  // drain has { fetched, leased, acked, blocked }
  // notify SSE clients, update caches, etc.
});
```

Drain cycles continue until all reactions have caught up to the latest events. Consumers only process new work — acknowledged events are skipped, and failed events are re-leased automatically.

The `settle()` method is the recommended production pattern — it debounces rapid commits (10ms default), runs correlate→drain in a loop until the system is consistent, and emits a `"settled"` event when done.

### Real-Time Notifications

When using the PostgreSQL backend, the store emits `NOTIFY` events on each commit, enabling consumers to react immediately via `LISTEN` rather than polling. This reduces latency and unnecessary database queries in production deployments.

## Dual-Frontier Drain

In event-sourced systems, consumers often subscribe to multiple event streams that advance at different rates: some produce bursts of events, while others stay idle for long periods. New streams can also be discovered while processing events from existing streams.

Naive approaches have fundamental trade-offs:

- Strictly serial processing across all streams blocks fast streams behind slow ones.
- Fully independent processing risks inconsistent cross-stream states.
- Prioritizing new streams over existing ones risks missing important events.

Act addresses this with the **Dual-Frontier Drain** strategy.

### How It Works

Each drain cycle divides streams into two sets:

- **Leading frontier** — Streams already near the latest known event (the global frontier). These continue processing without waiting.
- **Lagging frontier** — Streams that are behind or newly discovered. These are advanced quickly to catch up.

**Fast-forwarding:** If a lagging stream has no matching events in the current window, its watermark is advanced using the leading frontier's position. This prevents stale streams from blocking global convergence.

**Dynamic correlation:** Event resolvers dynamically discover and add new streams as events arrive. Resolvers can include source regex patterns to limit which streams are matched. When a new matching stream is discovered, it joins the drain immediately.

### Why It Matters

- **Fast recovery** — Newly discovered or previously idle streams catch up quickly.
- **No global blocking** — Fast streams are never paused to wait for slower ones.
- **Eventual convergence** — All reactions end up aligned on the same global event position.

## License

[MIT](https://github.com/rotorsoft/act-root/blob/master/LICENSE)
