---
id: event-sourcing
title: Event Sourcing & Processing
---

# Event Sourcing & Processing

Act persists all state changes as immutable events in an append-only log. The event store is the single source of truth — state is reconstructed by replaying events.

## Event Store

### Append-Only, Immutable Log

- All state changes are recorded as new events — past data is never modified
- Events are timestamped and versioned, enabling state reconstruction at any point
- Each entity instance has its own stream with strict ordering

### Optimistic Concurrency

Each stream maintains a version number. When committing events, the system verifies the expected version matches. If another process wrote events in the meantime, a `ConcurrencyError` is thrown. The caller retries with the latest state.

### Storage Backends

The event store uses a port/adapter pattern:

- **InMemoryStore** (default) — fast, ephemeral, for development and testing
- **PostgresStore** (`@rotorsoft/act-pg`) — production-ready with ACID guarantees and connection pooling
- **SqliteStore** (`@rotorsoft/act-sqlite`) — libSQL-backed adapter for embedded or single-node deployments

```typescript
import { store } from "@rotorsoft/act";
import { PostgresStore } from "@rotorsoft/act-pg";

store(new PostgresStore({
  host: "localhost",
  database: "myapp",
  user: "postgres",
  password: "secret",
}));
```

```typescript
import { store } from "@rotorsoft/act";
import { SqliteStore } from "@rotorsoft/act-sqlite";

store(new SqliteStore({ url: "file:myapp.db" }));
```

### Cache

Cache is always-on with `InMemoryCache` (LRU, maxSize 1000) as the default. It eliminates full event replay on every `load()` by storing the latest state checkpoint in memory. Actions update the cache after each commit; concurrency errors invalidate stale entries.

For distributed deployments, implement the `Cache` interface backed by Redis or another external store:

```typescript
import { cache } from "@rotorsoft/act";

cache(new RedisCache({ url: "redis://localhost:6379" }));
```

### Time-travel queries

`load()` accepts an optional `asOf` argument for reading historical state. The framework bypasses the cache, replays events from the start with snapshots, and applies the cutoff filters:

```typescript
// Snapshot just before event id 5000
await app.load(Counter, "counter-1", undefined, { before: 5000 });

// Snapshot at a specific timestamp (exclusive)
await app.load(
  Counter,
  "counter-1",
  undefined,
  { created_before: new Date("2026-01-01") },
);

// Replay with a callback to inspect each intermediate state
await app.load(
  Counter,
  "counter-1",
  (snap) => console.log(snap.event?.id, snap.state),
  { before: 5000 },
);
```

`AsOf = Pick<Query, "before" | "created_before" | "created_after" | "limit">`. Time-travel is read-only — `action()` always operates on current state.

### Logger

Logging follows the same port/adapter pattern. The default `ConsoleLogger` emits JSON lines in production and colorized output in development. For pino, inject `PinoLogger` from `@rotorsoft/act-pino`:

```typescript
import { log } from "@rotorsoft/act";
import { PinoLogger } from "@rotorsoft/act-pino";

log(new PinoLogger({ level: "debug" }));
```

### Resource Disposal

All adapters (logger, store, cache, custom disposers) are cleaned up via `dispose()()`:

```typescript
import { dispose } from "@rotorsoft/act";

// Graceful shutdown
process.on("SIGTERM", async () => {
  await dispose()();
});

// In tests
afterAll(async () => {
  await dispose()();
});
```

## Event-Driven Processing

Act handles event-driven workflows through atomic stream claiming and correlation. The event store itself acts as the message backbone — no external message queues needed.

### Reactions

Reactions are asynchronous handlers triggered by events. They can update other state streams, trigger external integrations, or drive cross-aggregate workflows:

```typescript
const app = act()
  .withState(Account)
  .on("Deposited")
    .do(async (event, stream, app) => {
      await app.do("LogEntry", target, { message: `Deposit: ${event.data.amount}` }, event);
    })
    .to((event) => ({ target: `audit-${event.stream}` }))
  .build();
```

### Stream Claiming

Act uses an atomic claim mechanism to coordinate distributed consumers. The `claim()` method discovers and locks streams in a single operation using PostgreSQL's `FOR UPDATE SKIP LOCKED` pattern — zero-contention competing consumers where workers never block each other:

- **Per-stream ordering** — events within a stream are processed sequentially
- **Temporary ownership** — claims expire after a configurable duration
- **Zero-contention** — locked rows are silently skipped, no blocking between workers
- **Backpressure** — only a limited number of claims active at a time

### Event Correlation

Correlation enables dynamic stream discovery:

- Each action/event carries `correlation` (request trace) and `causation` (what triggered it) metadata
- `app.correlate()` scans events, discovers new target streams via reaction resolvers, and registers them with `subscribe()`. Returns `{ subscribed, last_id }` where `subscribed` is the count of newly registered streams
- Must be called before `drain()` to register streams

**Optimization:** Resolvers are classified at build time as static or dynamic. Static targets (`_this_`, `.to("target")`) are subscribed once at init. An advancing checkpoint ensures correlate only scans new events. When no dynamic resolvers exist, correlate is skipped entirely — settle goes straight to drain.

### Correlation IDs

The `meta.correlation` field on every event is what lets you trace a workflow — every event emitted by an action, plus every event emitted by reactions that fire on those events, shares the same correlation id. Originating actions mint a fresh id; reactions inherit `reactingTo.meta.correlation` so the chain stays intact.

By default Act produces a readable, time-monotonic, lowercase id of the form `{state[:4]}-{action[:4]}-{ts}{rnd}` — for example `coun-incr-lwxk9p3a`. The 4-character timestamp segment wraps every ~28 minutes so adjacent inserts cluster on the same B-tree pages (much better index behavior than a random UUID), and the 4-character random tail keeps competing-consumer workers from colliding (1.68M values per ms).

Apps that need a different scheme plug a delegate in via `ActOptions.correlator`:

```ts
import { act, type Correlator } from "@rotorsoft/act";

const tenantPrefixed: Correlator = ({ state, action, actor }) => {
  const tenant = (actor as TenantActor).tenantId.slice(0, 6);
  return `${tenant}-${state.slice(0, 4)}-${action.slice(0, 4)}-${Date.now().toString(36)}`;
};

const app = act()
  .withState(Counter)
  .build({ correlator: tenantPrefixed });
```

Common shapes apps plug in:

- **Tenant-prefixed:** embed the actor's tenant id so multi-tenant systems can grep correlations per tenant.
- **Trace-id propagation:** when an HTTP request carries a W3C `traceparent`, pass it through the actor and return it as the correlation — single id from edge to event log.
- **Idempotency-key bridge:** when callers supply an `Idempotency-Key`, surface it via the actor and use it as the correlation so retries collapse onto the same workflow.
- **DB-issued monotonic:** call a Postgres sequence in the delegate for hard cross-worker monotonicity (one extra round-trip per commit).
- **ULID / UUIDv7:** drop in either if you've standardized elsewhere — both are time-ordered and globally unique without coordination.

The delegate is only consulted on **originating actions** and on **close-the-books transactions** (where Act synthesizes `state: "$close"`, `action: "close"`). Reactions never call it — they propagate `reactingTo.meta.correlation`.

### The Drain Cycle

`drain()` processes pending reactions:

1. **Claim** — atomically discover and lock streams with pending events (uses `FOR UPDATE SKIP LOCKED` for zero-contention)
2. **Fetch** — load events for each claimed stream
3. **Match** — find reactions whose resolvers target each stream
4. **Handle** — execute reaction handlers
5. **Ack/Block** — release successful claims or block failed streams

```typescript
// In tests — explicit, deterministic
await app.correlate();
await app.drain();

// In production — wire settle() to the "committed" lifecycle event
app.on("committed", () => app.settle());
```

### Dual-Frontier Strategy

Each drain cycle divides streams into two sets:

- **Lagging frontier** — streams behind or newly discovered, advanced quickly to catch up
- **Leading frontier** — streams near the latest event, continue processing without waiting

The ratio adapts dynamically based on event pressure (clamped between 20-80%).

### settle()

The recommended production pattern. `settle()` is a debounced wrapper that coalesces bursts of commits into a single `correlate → drain` pass, then loops the pair until the system is consistent and emits the `"settled"` lifecycle event. The canonical wiring is to subscribe to `"committed"` once at bootstrap and let it trigger automatically — actions never call `settle()` directly:

```typescript
// At app bootstrap — wire once
app.on("committed", () => app.settle());

// Optional: react to the completion signal
app.on("settled", (drain) => {
  // notify SSE clients, invalidate caches, etc.
});

// Now actions just commit; settle() handles the rest
await app.do("CreateItem", target, input);
```

`drain()` only processes one level per call. `settle()` is the loop that follows reaction chains to completion in production. In tests, prefer the explicit `correlate → drain` pair so cycle counts are deterministic.

### Lifecycle Events

- `app.on("committed", ...)` — observe all state changes
- `app.on("acked", ...)` — observe acknowledged reactions
- `app.on("blocked", ...)` — catch reaction processing failures
- `app.on("settled", ...)` — react when `settle()` completes
- `app.on("closed", ...)` — observe results of `close()` operations (`{ truncated, skipped }`)

## Projection Rebuild

Projections are derived data — disposable by design. To replay a projection from scratch (after a code change, schema fix, or new aggregation):

```typescript
// 1. Reset the projection's reaction watermarks AND arm the drain flag
await app.reset(["my-projection"]);

// 2. settle loops correlate→drain until caught up, then emits "settled"
app.settle({ eventLimit: 1000 });
```

Always go through `app.reset(...)` rather than `store().reset(...)` directly — the orchestrator's internal `_armed` flag has to be raised, otherwise a settled app short-circuits and skips the replay.

## Closing the Books

`app.close([targets])` is the event-sourcing equivalent of "closing the books" in accounting: archive the detail, then truncate the operational store. Each target chooses between *tombstone* (permanent close) and *restart* (seed a fresh `__snapshot__` and keep accepting actions):

```typescript
const result = await app.close([
  {
    stream: "order-123",
    archive: async () => {
      const events = await app.query_array({ stream: "order-123", stream_exact: true });
      await s3.putObject({ Key: "order-123.json", Body: JSON.stringify(events) });
    },
  },
  {
    stream: "counter-1",
    restart: true, // keep the stream alive with a snapshot of final state
  },
]);

// result.truncated: Map<stream, { deleted, committed }>
// result.skipped:   string[]   — streams with pending reactions or concurrent writers
```

After `close()`, tombstoned streams throw `StreamClosedError` on any subsequent `app.do()`. Restarted streams are reseeded and continue normally. See [Close cycle](../architecture/close-cycle) for the full phase-by-phase semantics.

## Testing

```typescript
import { store, dispose } from "@rotorsoft/act";

beforeEach(async () => {
  await store().seed();
});

afterAll(async () => {
  await dispose()();
});

it("should process reactions", async () => {
  await app.do("CreateItem", target, { name: "Test" });
  await app.correlate();
  await app.drain();
  // assert...
});
```
