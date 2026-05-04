---
id: extension-points
title: Extension points
---

# Extension points

Three pluggable contracts: `Store`, `Cache`, `Logger`. Each is exposed as a singleton port. A new adapter implements the contract; calling the port with the adapter installs it (first call wins).

This page covers each contract, its invariants, and the concrete adapters in this repo. Anyone writing a new adapter should be able to read this page plus the contract source and build something correct.

## The port pattern

Every infrastructure dependency in the framework is reached via a port — a singleton getter that lazily initializes a default the first time it's called:

```ts
import { store, cache, log, dispose } from "@rotorsoft/act";

// Defaults install on first call
store();   // → InMemoryStore
cache();   // → InMemoryCache
log();     // → ConsoleLogger

// Or inject before first read
import { PostgresStore } from "@rotorsoft/act-pg";
store(new PostgresStore({ /* ... */ }));   // sets the singleton
const s = store();                          // returns the PostgresStore
```

First call wins by design. Once an adapter is registered, subsequent calls with a different argument are ignored. This forces app initialization to be deterministic and prevents mid-run swaps that would corrupt state.

The `dispose()` port collects cleanup callbacks. Adapters' `dispose()` methods are wired into this so they release resources (DB pools, file handles) on shutdown. Order: registered disposers run in reverse, then port adapters in reverse registration order.

## Store contract

The `Store` interface in `libs/act/src/types/ports.ts`. The framework needs the store to do these eleven things:

```ts
interface Store extends Disposable {
  seed(): Promise<void>;
  drop(): Promise<void>;
  commit(stream, msgs, meta, expectedVersion?): Promise<Committed[]>;
  query(callback, filter?): Promise<number>;
  claim(lagging, leading, by, millis): Promise<Lease[]>;
  subscribe(streams): Promise<{ subscribed; watermark }>;
  ack(leases): Promise<Lease[]>;
  block(leases): Promise<BlockedLease[]>;
  reset(streams): Promise<number>;
  truncate(targets): Promise<Map<stream, { deleted; committed }>>;
  query_streams(callback, query?): Promise<QueryStreamsResult>;
}
```

### Invariants an adapter must hold

- **Per-stream version monotonicity**: every event for a given stream has a `version` that's strictly greater than the previous event's `version` for that stream, starting at 0.
- **Optimistic concurrency**: when `expectedVersion` is provided, `commit` MUST throw `ConcurrencyError` if the stream's current head version doesn't match. This includes catching adapter-specific unique-constraint violations and re-throwing as `ConcurrencyError`. Callers cannot retry correctly on adapter-specific errors.
- **Atomic commits**: a multi-event commit is all-or-nothing. Either all events land or none do.
- **Atomic truncate**: `truncate` deletes all events for a stream and inserts the seed event in a single transaction. Partial states are not observable.
- **Lease exclusivity**: a successful `claim` returns leases that no concurrent `claim()` can return again until released by `ack`/`block`/timeout.
- **Tombstone semantics**: a tombstone event is a regular event with `name === TOMBSTONE_EVENT`. Adapters don't need to know what it means — the framework's `action()` reads the head event to decide. Adapters just need to return tombstones in queries like any other event.

### Concrete adapters

| Adapter | Where | Use case |
|---|---|---|
| `InMemoryStore` | `libs/act/src/adapters/in-memory-store.ts` | Tests, single-process dev |
| `PostgresStore` | `libs/act-pg/src/PostgresStore.ts` | Production multi-process |
| `SqliteStore` | `libs/act-sqlite/src/SqliteStore.ts` | Embedded, single-node |

### What the framework does NOT promise the adapter

- Connection pooling — the adapter implements it (PG: `pg.Pool`; SQLite: libSQL's built-in)
- Transactions — the adapter wraps multi-step operations as needed
- Schema migration — adapters define their own DDL in `seed()`; users run it explicitly
- Auth/connection strings — adapter constructor takes a config; framework doesn't inspect

## Cache contract

```ts
interface Cache extends Disposable {
  get<TState>(stream): Promise<CacheEntry<TState> | undefined>;
  set<TState>(stream, entry): Promise<void>;
  invalidate(stream): Promise<void>;
  clear(): Promise<void>;
}

interface CacheEntry<TState> {
  readonly state: TState;
  readonly version: number;
  readonly event_id: number;
  readonly patches: number;
  readonly snaps: number;
}
```

### Invariants

- **`get` is a hint, not a contract**: the cache may return undefined at any time (eviction, network failure for a Redis-backed adapter, cold start). The framework treats `undefined` the same as a logical miss and falls back to store replay.
- **`set` is best-effort**: failures are logged but don't propagate. The cache is an optimization, not source of truth.
- **`invalidate` should be reliable**: when called after `ConcurrencyError`, the framework relies on the entry being gone. A failed `invalidate` followed by a `get` returning the old entry would surface stale state. Adapters should treat this as a critical path.
- **Async by design**: the interface is async even for in-memory implementations. Don't optimize away the async — Redis/external caches need it.

### Concrete adapters

| Adapter | Where | Use case |
|---|---|---|
| `InMemoryCache` | `libs/act/src/adapters/in-memory-cache.ts` | Single-process; LRU, default `maxSize: 1000` |

For distributed deployments, a Redis-backed adapter is the natural extension. Not provided in this repo because Redis-vs-Memcached-vs-other choice is app-specific.

## Logger contract

```ts
interface Logger extends Disposable {
  level: string;
  // Each level overloads on (obj, msg?) and (msg) — see ports.ts
  fatal(obj: unknown, msg?: string): void;
  fatal(msg: string): void;
  // ... error, warn, info, debug, trace follow the same pair of overloads
  child(bindings: Record<string, unknown>): Logger;
}
```

### Invariants

- **No-throw**: log calls must never throw. A misbehaving logger crashing the framework is the classic operability footgun.
- **Level gating**: levels above `level` should be no-ops. The `tracing` module checks `logger.level === "trace"` to decide whether to instrument event-sourcing and drain ops with breadcrumb logs. Lying about the level disables tracing silently.
- **`child(bindings)` returns a logger that forwards to the same sink with merged bindings**. Used by `Act.create_correlations` and similar to add a per-instance binding (e.g., `correlationId`).

### Concrete adapters

| Adapter | Where | Use case |
|---|---|---|
| `ConsoleLogger` | `libs/act/src/adapters/console-logger.ts` | Default. JSON in production, colorized human-readable in dev. Zero deps. |
| `PinoLogger` | `libs/act-pino/src/index.ts` | Production deployments using pino's transport ecosystem. |

## Wiring it together — a minimal app

```ts
import { act, store, cache, log, dispose } from "@rotorsoft/act";
import { PostgresStore } from "@rotorsoft/act-pg";
import { InMemoryCache } from "@rotorsoft/act";  // re-exported from main
import { PinoLogger } from "@rotorsoft/act-pino";

// 1. Wire ports BEFORE constructing Act
log(new PinoLogger({ level: "info" }));
store(new PostgresStore({ host: "...", database: "...", schema: "events", table: "events" }));
cache(new InMemoryCache({ maxSize: 5000 }));

// 2. Build the Act instance
const app = act()
  .withState(...)
  .build();

// 3. Run as normal
await app.do("...", target, payload);
```

If any port is left to default, the framework wires the in-memory implementation for that port. Useful for tests; deliberate for production.

## Pointers

- `libs/act/src/ports.ts` — `port()` factory and the three default ports
- `libs/act/src/types/ports.ts` — `Store`, `Cache`, `Logger`, `Disposable` contracts
- `libs/act/src/adapters/` — default in-memory implementations of all three
- `libs/act-pg/src/PostgresStore.ts`, `libs/act-sqlite/src/SqliteStore.ts`, `libs/act-pino/src/index.ts` — production adapters
- `libs/act-pg/test/stress/` — multi-process stress harness exercising the Store contract under contention; useful as a worked example of which invariants the framework actually depends on
