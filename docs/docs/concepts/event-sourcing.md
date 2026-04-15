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

### Cache

Cache is always-on with `InMemoryCache` (LRU, maxSize 1000) as the default. It eliminates full event replay on every `load()` by storing the latest state checkpoint in memory. Actions update the cache after each commit; concurrency errors invalidate stale entries.

For distributed deployments, implement the `Cache` interface backed by Redis or another external store:

```typescript
import { cache } from "@rotorsoft/act";

cache(new RedisCache({ url: "redis://localhost:6379" }));
```

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

### The Drain Cycle

`drain()` processes pending reactions:

1. **Claim** — atomically discover and lock streams with pending events (uses `FOR UPDATE SKIP LOCKED` for zero-contention)
2. **Fetch** — load events for each claimed stream
3. **Match** — find reactions whose resolvers target each stream
4. **Handle** — execute reaction handlers
5. **Ack/Block** — release successful claims or block failed streams

```typescript
// In tests
await app.correlate();
await app.drain();

// In production — debounced, non-blocking
app.settle();
```

### Dual-Frontier Strategy

Each drain cycle divides streams into two sets:

- **Lagging frontier** — streams behind or newly discovered, advanced quickly to catch up
- **Leading frontier** — streams near the latest event, continue processing without waiting

The ratio adapts dynamically based on event pressure (clamped between 20-80%).

### settle()

The recommended production pattern. Debounces rapid commits, runs correlate→drain in a loop until the system is consistent, then emits a `"settled"` lifecycle event:

```typescript
await app.do("CreateItem", target, input);
app.settle();  // non-blocking, returns immediately

app.on("settled", (drain) => {
  // notify SSE clients, invalidate caches, etc.
});
```

### Lifecycle Events

- `app.on("committed", ...)` — observe all state changes
- `app.on("acked", ...)` — observe acknowledged reactions
- `app.on("blocked", ...)` — catch reaction processing failures
- `app.on("settled", ...)` — react when `settle()` completes

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
