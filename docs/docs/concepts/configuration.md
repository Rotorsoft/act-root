---
id: configuration
title: Configuration
---

# Configuration

Act uses a fluent builder pattern for defining domain logic, a port/adapter pattern for infrastructure (store, cache, logger), and a small set of orchestrator options for tuning correlation and settle behavior. This page covers all three.

## State Builder

Define state machines with actions, events, and validation:

```typescript
import { state } from "@rotorsoft/act";
import { z } from "zod";

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ amount: z.number() }) })
  .patch({
    Incremented: ({ data }, state) => ({ count: state.count + data.amount }),
  })
  .on({ increment: z.object({ by: z.number() }) })
    .emit((action) => ["Incremented", { amount: action.by }])
  .build();
```

## Projection Builder

Read-model updaters that react to events:

```typescript
import { projection } from "@rotorsoft/act";

const CounterProjection = projection("counters")
  .on({ Incremented: z.object({ amount: z.number() }) })
    .do(async ({ stream, data }) => { /* update read model */ })
  .build();
```

### Batched replay

For high-throughput rebuilds (e.g. catching up after a long downtime, or projecting onto a fresh read model), define a `.batch(handler)` that processes every event for a stream in a single transaction. When defined, `.batch()` is *always* called instead of the per-event `.do()` handlers.

```typescript
const TicketProjection = projection("tickets")
  .on({ TicketOpened: TicketOpenedSchema })
    .do(async ({ stream, data }) => { /* per-event fallback */ })
  .on({ TicketClosed: TicketClosedSchema })
    .do(async ({ stream, data }) => { /* per-event fallback */ })
  .batch(async (events, stream) => {
    await db.transaction(async (tx) => {
      for (const e of events) {
        switch (e.name) {
          case "TicketOpened":  /* bulk insert */ break;
          case "TicketClosed":  /* bulk update */ break;
        }
      }
    });
  })
  .build();
```

`.batch()` is only available on static-target projections (`projection("target")`). The events array is a discriminated union, so a `switch (e.name)` narrows both the name and `data`.

## Slice Builder

Vertical feature modules grouping states, projections, and reactions:

```typescript
import { slice } from "@rotorsoft/act";

const CounterSlice = slice()
  .withState(Counter)
  .withProjection(CounterProjection)
  .on("Incremented")
    .do(async (event, stream, app) => { /* cross-state dispatch via app */ })
    .to((event) => ({ target: event.stream }))
  .build();
```

## Act Orchestrator

Compose everything into an application:

```typescript
import { act } from "@rotorsoft/act";

const app = act()
  .withSlice(CounterSlice)
  .withState(AnotherState)
  .withProjection(StandaloneProjection)
  .on("SomeEvent")
    .do(handler)
    .to(resolver)
  .build();
```

### Act options

`act().build(options?)` accepts a small `ActOptions` object for tuning the orchestrator:

```typescript
const app = act()
  .withState(Counter)
  .build({
    maxSubscribedStreams: 5_000, // default 1000
    settleDebounceMs: 25,        // default 10
  });
```

- **`maxSubscribedStreams`** (default `1000`) — cap for the LRU set tracking already-subscribed reaction targets. Apps that mint many dynamic targets (e.g. one stream per user activity) should raise this; the LRU is a memory bound, not a correctness mechanism — eviction at most causes a redundant `subscribe()` call.
- **`settleDebounceMs`** (default `10`) — debounce window used by `settle()` when no per-call `debounceMs` is given. Coalesces commits in the same tick into a single correlate→drain pass. Lower for tight tests; raise for bursty production traffic.
- **`onlyLanes`** (default: every declared lane) — restrict this process to a subset of declared drain lanes (ACT-1103). See [Lanes](#lanes) below.
- **`listen`** (default `true`) — subscribe to `Store.notify` on this instance. Set `false` on writer-only instances: commits still notify, but the instance doesn't subscribe to the channel. The subscriber-connection budget is the practical scaling ceiling for the notify/listen pattern; writer-only fleets shouldn't spend it.
- **`drain`** (default `true`) — run the local reaction pipeline. Set `false` to make `correlate()`, `drain()`, and `settle()` no-ops and skip auto-cycle workers. The `notified` lifecycle event still fires when `listen` is on, so observability sidecars (`listen: true, drain: false`) work.

### Deployment shapes via `listen` / `drain`

The two flags are orthogonal — independent costs, independent toggles:

| `listen` | `drain` | Use case |
|---|---|---|
| `true` | `true` | Default. Reactive instance in a multi-process cluster. |
| `false` | `true` | Single-instance app. Nothing else to listen to, but own commits still trigger reactions. Minor optimization. |
| `false` | `false` | Pure writer fleet (write-heavy frontend, ingest worker, API server). Notifies on commit but doesn't react. |
| `true` | `false` | Observability sidecar. Sees every cross-process commit via the `notified` lifecycle event without processing it. |

```typescript
// Writer fleet — scales horizontally without touching the subscriber budget.
const writer = act().withState(Order).build({ listen: false, drain: false });

// Reactive fleet — same codebase, opposite flags. Sized to the reaction workload.
const reactor = act()
  .withState(Order)
  .on("OrderPlaced").do(reduceInventory).to("inventory")
  .build(); // defaults: listen + drain
```

Commits from the writer fleet emit notifications (that's part of the store's commit protocol); the reactor fleet picks them up via its `Store.notify` subscription and runs reactions locally.

## Lanes

By default, every reaction lives in a single implicit `"default"` lane: one `DrainController` runs the whole pipeline with one timing budget. That works until reactions diverge — a webhook delivery wants `leaseMillis` measured in tens of seconds, a best-effort notification wants short retries, and a long projection replay needs a generous claim budget. Tuning any one of them globally penalises the others.

`.withLane({...})` declares an independent drain lane with its own controller, lease budget, claim limit, and cycle cadence. Reactions opt in via `.to({lane})`; reactions without an explicit lane stay in `"default"`.

```typescript
const app = act()
  .withState(Ticket)
  .withLane({ name: "webhooks", leaseMillis: 30_000, streamLimit: 5, cycleMs: 500 })
  .withLane({ name: "best-effort", leaseMillis: 1_000, streamLimit: 20, cycleMs: 50 })
  .on("OrderConfirmed")
    .do(deliverWebhook)
    .to({ target: "webhooks-out", lane: "webhooks" })
  .on("OrderConfirmed")
    .do(emitMetric)
    .to({ target: "metrics-out", lane: "best-effort" })
  .build();
```

### `LaneConfig` fields

- **`name`** — the lane identifier. `"default"` is reserved for the implicit lane; declaring it explicitly throws.
- **`leaseMillis`** — lease window for `claim()` calls in this lane. Sized to the longest expected handler invocation in the lane plus headroom.
- **`streamLimit`** — max streams claimed per cycle. Bounds the parallel-handler dispatch budget for the lane.
- **`cycleMs`** — when set, auto-starts a per-lane `setTimeout` chain that calls the controller's `drain()` at this cadence. The timer is `unref()`'d so it doesn't keep the process alive; `app.shutdown()` clears it. When omitted, the lane drains alongside the Act-level `settle()` loop.

Each declared lane field overrides caller-passed `DrainOptions` at drain time — `withLane({leaseMillis: 30_000})` would be meaningless if `drain({leaseMillis: 1_000})` could erase it. Caller options only apply when the lane is silent on the field.

### Type-safe lane references

The builder threads declared lane names into its `TLanes` generic. `.to({lane: "..."})` and `ActOptions.onlyLanes` are narrowed to that union at the call site — typos fail compile:

```typescript
const app = act()
  .withState(Ticket)
  .withLane({ name: "webhooks" })
  .on("OrderConfirmed")
    .do(deliverWebhook)
    // @ts-expect-error "wbhooks" is not a declared lane
    .to({ target: "out", lane: "wbhooks" })
  .build({
    // @ts-expect-error same — caught at the options site too
    onlyLanes: ["wbhooks"],
  });
```

Slices declare their own lanes via the same `.withLane(...)` method; `act().withSlice(slice)` merges the slice's lanes into the Act's set. Conflicting timing configs (same lane name, different `leaseMillis`/`streamLimit`/`cycleMs` between the slice and the Act) throw at composition time — pick one declaration.

### Re-laning at restart

`subscribe()` UPSERTs each stream's lane on every call. If you change a target's lane in the builder and restart, the store rewrites the persisted lane on the next `correlate()`. Online re-laning (changing a stream's lane while workers hold leases) is **not** supported — the safe trigger is process restart.

### Conflicting lane assignments

Two reactions routing to the same `(target, source)` stream must declare the same lane. Lanes have no ordering, so there's no `max()` merge analogous to priority — the build-time scan throws on disagreement:

```typescript
// throws at act().build()
act()
  .withState(Ticket)
  .withLane({ name: "slow" }).withLane({ name: "fast" })
  .on("OrderConfirmed").do(handlerA).to({ target: "shared", lane: "slow" })
  .on("OrderConfirmed").do(handlerB).to({ target: "shared", lane: "fast" })
  .build();
```

### `onlyLanes` — process-per-lane deployment

`ActOptions.onlyLanes` restricts which lanes' controllers boot in this process. With `onlyLanes: ["webhooks"]`, only the webhook controller runs; other declared lanes are silent. Workers in different processes coordinate via the store's `SKIP LOCKED` semantics, so the same image can be deployed as one-process-per-lane without code changes.

This is an escape hatch, not the primary path. A single process with multiple declared lanes already gets fast-lane responsiveness — `Act._drainAll` runs every controller's drain in parallel, so a slow lane's in-flight handler doesn't block a fast lane's claim. `onlyLanes` is for the cases where you want hardware isolation (different CPU/memory per lane) on top of that.

## Port/Adapter Pattern

Infrastructure concerns (logging, storage, caching) use singleton adapters injected via port functions. All three ports follow the same pattern — first call wins, with a sensible default:

```typescript
import { log, store, cache } from "@rotorsoft/act";

const logger = log();   // ConsoleLogger (default)
const s = store();       // InMemoryStore (default)
const c = cache();       // InMemoryCache (default)
```

### Logger

The default `ConsoleLogger` emits JSON lines in production (compatible with GCP, AWS CloudWatch, Datadog) and colorized output in development — zero dependencies.

```typescript
import { log } from "@rotorsoft/act";

const logger = log();
logger.info("Application started");
```

For pino, inject the adapter from `@rotorsoft/act-pino`:

```typescript
import { log } from "@rotorsoft/act";
import { PinoLogger } from "@rotorsoft/act-pino";

log(new PinoLogger({ level: "debug", pretty: true }));
```

The `Logger` interface is minimal and compatible with pino, winston, bunyan, and other popular loggers:

```typescript
interface Logger extends Disposable {
  level: string;
  fatal(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  trace(obj: unknown, msg?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}
```

### Store

```typescript
import { store } from "@rotorsoft/act";
import { PostgresStore } from "@rotorsoft/act-pg";

// Development: in-memory (default)
const s = store();

// Production: inject PostgreSQL
store(new PostgresStore({
  host: "localhost",
  database: "myapp",
  user: "postgres",
  password: "secret",
  schema: "public",
  table: "events",
}));

// Embedded / single-node: SQLite via libSQL
import { SqliteStore } from "@rotorsoft/act-sqlite";
store(new SqliteStore({ url: "file:myapp.db" }));
```

### Cache

Cache is always-on with `InMemoryCache` (LRU, maxSize 1000) as the default:

```typescript
import { cache } from "@rotorsoft/act";

// Default: InMemoryCache — no setup needed
// For distributed deployments:
cache(new RedisCache({ url: "redis://localhost:6379" }));
```

The `Cache` interface is async for forward-compatibility with external caches:

```typescript
interface Cache extends Disposable {
  get<TState>(stream: string): Promise<CacheEntry<TState> | undefined>;
  set<TState>(stream: string, entry: CacheEntry<TState>): Promise<void>;
  invalidate(stream: string): Promise<void>;
  clear(): Promise<void>;
}
```

### Resource Disposal

All adapters (logger, store, cache, and custom disposers) are cleaned up via `dispose()()`:

```typescript
import { dispose } from "@rotorsoft/act";

// Register custom cleanup
dispose(async () => {
  await redis.quit();
});

// Trigger cleanup (graceful shutdown or test teardown)
await dispose()();
```

## Custom Store Implementation

Implement the `Store` interface for custom backends:

```typescript
interface Store extends Disposable {
  seed(): Promise<void>;
  drop(): Promise<void>;
  commit(stream, msgs, meta, expectedVersion?): Promise<Committed[]>;
  query(callback, filter?): Promise<number>;
  claim(lagging, leading, by, millis, lane?): Promise<Lease[]>;
  subscribe(streams): Promise<{ subscribed: number; watermark: number }>;
  ack(leases): Promise<Lease[]>;
  block(leases): Promise<(Lease & { error })[]>;
  reset(streams): Promise<number>;
  truncate(targets): Promise<TruncateResult>;
  query_streams(callback, query?): Promise<{ maxEventId: number; count: number }>;
  dispose(): Promise<void>;
}
```

`claim()` atomically discovers and locks streams for processing using PostgreSQL's `FOR UPDATE SKIP LOCKED` pattern — zero-contention competing consumers where workers never block each other. `subscribe()` registers new streams for reaction processing and returns the count of newly registered streams. `query_streams()` is read-only introspection over subscription positions — used by operational dashboards (projection lag, blocked subscriptions) without opening a second connection or running raw SQL against the adapter-specific streams table. Version-based optimistic concurrency must be implemented correctly. See the [PostgresStore source](https://github.com/rotorsoft/act-root/blob/master/libs/act-pg/src/PostgresStore.ts) for a production-grade reference.
