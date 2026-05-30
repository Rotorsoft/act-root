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

The `Store` interface in `libs/act/src/types/ports.ts`. The framework needs the store to do these things:

```ts
interface Store extends Disposable, EventSource {
  // EventSource gives us:
  // query<E>(callback: (event: Committed<E>) => void, query?: Query): Promise<number>;

  seed(): Promise<void>;
  drop(): Promise<void>;
  commit(stream, msgs, meta, expectedVersion?): Promise<Committed[]>;
  claim(lagging, leading, by, millis, lane?): Promise<Lease[]>;
  subscribe(streams): Promise<{ subscribed; watermark }>;
  ack(leases): Promise<Lease[]>;
  block(leases): Promise<BlockedLease[]>;
  reset(input: string[] | StreamFilter): Promise<number>;
  unblock(input: string[] | StreamFilter): Promise<number>;
  prioritize(filter: StreamFilter, priority): Promise<number>;
  truncate(targets): Promise<Map<stream, { deleted; committed }>>;
  query_streams(callback, query?): Promise<QueryStreamsResult>;
  query_stats(input, options?): Promise<Map<stream, StreamStats>>;
  // Optional, capability-gated:
  notify?(handler): NotifyDisposer | Promise<NotifyDisposer>;
  restore?(driver: (callback: (event: Committed) => Promise<number>) => Promise<void>): Promise<void>;
}
```

`reset`, `unblock`, and `prioritize` share the same `StreamFilter` shape (`stream` / `stream_exact` / `source` / `source_exact` / `blocked` / `lane`). `reset` and `unblock` also accept a plain `string[]` for targeted operations. `unblock` always restricts to blocked streams regardless of what the filter passes — there's no "unblock unblocked streams" use case. `reset` is for projection rebuilds (watermark → -1); `unblock` is for poison-message recovery (watermark preserved).

`claim` takes an optional `lane` filter (ACT-1103). When set, only streams in the named lane are eligible; when omitted, the claim spans every lane — preserving pre-1103 behavior. Adapters that haven't migrated yet can leave `lane` unread on the SQL side and still satisfy the contract until they opt in. `subscribe`'s row shape gained an optional `lane` field for the same release; adapters UPSERT it on every call so a restarted Act with a new lane assignment moves streams without a manual migration.

`query_stats` is the per-stream-aggregate primitive (added in [ACT-639](https://github.com/Rotorsoft/act-root/issues/639)). Default returns the head event per stream via an indexed path; opt-in `count`/`tail`/`names` trigger a full scan but share it. Input is `string[]` for an enumerated set or `Pick<StreamFilter, "stream" | "stream_exact">` for pattern selection — subscription-level filters (`source`, `blocked`) live on `query_streams`; compose the two for "stats for blocked subscriptions" workflows.

`restore` is the offline wipe-and-rebuild primitive (added in [ACT-1124](https://github.com/Rotorsoft/act-root/issues/783), reshaped into the current HOF driver pattern by [ACT-1125](https://github.com/Rotorsoft/act-root/issues/784)). Capability-gated — adapters that can't atomically wipe and reinsert in one transaction don't have to implement it. The adapter's job is narrow: open a transaction (PG `BEGIN`, SQLite `BEGIN IMMEDIATE`, InMemory snapshot-and-swap), wipe events + streams/subscriptions, hand the orchestrator a per-event insert callback by invoking `driver(callback)`, then commit or roll back. `RESTART IDENTITY` (PG) / `sqlite_sequence` reset (SQLite) reseed dense ids from 1; InMemory uses `0..N-1`. `created` is preserved verbatim from the source — distinct from `commit`, which always stamps `now()`. Reactions re-subscribe via the orchestrator on the next settle cycle.

### `EventSource` / `EventSink` — the transfer surface

Added by [ACT-1128](https://github.com/Rotorsoft/act-root/issues/787) / [#788](https://github.com/Rotorsoft/act-root/issues/788), the public types `EventSource` and `EventSink` (in `libs/act/src/types/action.ts`) split the read end and the write end of the restore pipeline into separate interfaces, so the same `Act.restore` driver can move events between any source and any sink:

```ts
interface EventSource extends Disposable {
  query<E>(callback: (event: Committed<E>) => void, query?: Query): Promise<number>;
}
interface EventSink extends Disposable {
  restore(driver: (callback: (event: Committed) => Promise<number>) => Promise<void>): Promise<void>;
}
```

`Store extends EventSource` — every adapter is a source for free. The optional `Store.restore` method matches the `EventSink.restore` shape, so a restore-capable store is also a sink. The framework ships `CsvFile` (in `libs/act/src/csv.ts`) as the bundled non-store implementation: it implements both ends so a CSV file can be either side of a transfer (back up a store → CSV, restore a CSV → store, or pipe one CSV to another). Construct with `new CsvFile({ path })` for an on-disk file or `new CsvFile({ blob })` for a string already in memory.

The orchestrator now exposes:

```ts
app.restore(source: EventSource, opts?: ScanOptions, sink?: EventSink): Promise<ScanResult>
```

`sink` defaults to the singleton store (which must declare the `restore` capability); passing an explicit sink routes the transfer elsewhere without binding the singleton. This is how the inspector's unified transfer endpoint moves events between PG ↔ SQLite ↔ CSV without ever changing what's connected.

### Backpressure

The `EventSource.query` callback is typed `(event) => void`, and adapters wrap each invocation in `await Promise.resolve(callback(event))`. TypeScript's "any return ignored when the type says `void`" rule lets the same call site accept both sync (`e => arr.push(e)`, returns `number`) and async (`async e => …`) callbacks. The orchestrator's `scan` (in `libs/act/src/internal/event-sourcing.ts`) puts its per-event work directly inside the source's callback, so the adapter's per-event await throttles the producer to the consumer's pace.

`scan` paginates the source. Each batch calls `source.query` with `limit: ScanOptions.batch_size` (default 500, caller-tunable per `Act.restore` invocation) and `after: <last id seen>`. Stores that respect `limit` (`PostgresStore`'s `pool.query` honors it natively) hold one batch's worth of rows in memory per round trip — adapter cost is O(`batch_size`) regardless of total result size. Sources that ignore the filter and stream everything in one call (`CsvFile`) signal the loop to exit by returning more events than the requested limit; they're memory-safe because they read line-by-line internally.

A million-event PG → CSV transfer holds at most `batch_size` rows in the adapter, one event in flight through the source's callback, and whatever the consumer accumulates downstream — independent of total source size. `CsvFile`, `EventSource`, and `EventSink` are the public surface the rest of the framework speaks.

### `scan`, `Act.restore`, and the destructive path

The orchestrator-side validator lives in `scan` (`libs/act/src/internal/event-sourcing.ts`, alongside `load`/`action`/`snap`/`tombstone`) and is exposed publicly only via `Act.restore(source, opts, sink?)`. `scan` owns iteration over the `EventSource`, validates each event (negative version, malformed `created`), applies `drop_snapshots`, fires `on_progress`, and builds the per-call `old → new` id map that rewrites `meta.causation.event.id` so causation chains survive the renumber. Tools that operate on a raw `Store` without app state (e.g., the inspector) wrap the store in an empty Act via the scoped-ports option and call `app.restore` — the orchestrator path stays the only door in.

`ScanOptions` is interpreted by `scan`, not by adapters. It carries:

- `drop_snapshots` — skip every `__snapshot__` event in the source so the next snap policy regenerates them with current state ([ACT-1125](https://github.com/Rotorsoft/act-root/issues/784))
- `drop_closed_streams` — compact streams that have a `__tombstone__` event ([ACT-1126](https://github.com/Rotorsoft/act-root/issues/785)). Scan walks the source once upfront with a tombstone-name filter to collect closed-stream names, then the main pass drops every **pre-close event** whose stream is in the set. The tombstone is **kept** — it's what makes `app.do()` throw `StreamClosedError` in the rebuilt store, so dropping it would silently reopen the stream. Counted in `ScanResult.dropped.closed_streams`.
- `event_migrations` and `stream_rename` — transfer-time schema migration ([ACT-1126](https://github.com/Rotorsoft/act-root/issues/785)). Schema-guarded event rewrites + bulk stream rename for tenant relocation; see [Concepts → Migration overlay](../concepts/event-sourcing.md#migration-overlay).
- `on_progress` — one callback per event (caller throttles/debounces)
- `dry_run` — validate the source without touching the store (same scan loop, no transaction, no sink call; powers the inspector's transfer-preview)
- `batch_size` — pagination chunk size for the underlying `source.query` calls

All transforms run inside scan's existing pagination loop and atomic-rollback contract — any throw aborts the whole pass.

**Validation is a source operation, not a store operation.** Per-event blockers (malformed `created`, negative `version`) are caught inline by the scan loop on every `Act.restore` call and throw on the first hit; atomic transaction rollback in the sink means a failing restore leaves the target byte-for-byte unchanged. Cross-event invariants (duplicate ids, per-stream version gaps) are not the framework's job — DB `UNIQUE(stream, version)` catches dupes at commit time, and partial backups intentionally have gaps.

### Invariants an adapter must hold

- **Per-stream version monotonicity**: every event for a given stream has a `version` that's strictly greater than the previous event's `version` for that stream, starting at 0.
- **Optimistic concurrency**: when `expectedVersion` is provided, `commit` MUST throw `ConcurrencyError` if the stream's current head version doesn't match. This includes catching adapter-specific unique-constraint violations and re-throwing as `ConcurrencyError`. Callers cannot retry correctly on adapter-specific errors.
- **Atomic commits**: a multi-event commit is all-or-nothing. Either all events land or none do.
- **Atomic truncate**: `truncate` deletes all events for a stream and inserts the seed event in a single transaction. Partial states are not observable.
- **Atomic restore** (when implemented): `restore` wipes events + streams and rewrites the source rows in a single transaction. On any throw mid-iteration, the store reverts byte-for-byte to its pre-call state. Cache invalidation after restore is the caller's responsibility — restore does not touch the `Cache` port.
- **Backpressured query**: adapters MUST invoke the per-event callback as `await Promise.resolve(callback(event))`. Sync callbacks (`(e) => arr.push(e)`) resolve immediately and pay no overhead; async callbacks (`async (e) => …`) throttle the read loop, which is how `scan` and the transfer pipeline avoid OOM on multi-million-event sources.
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

## Scoped ports (per-Act)

The singleton path covers the common case: one Act instance per process, one store, one cache. When you need more than one Act in the same process — each with its own store and/or cache — pass an `ActOptions.scoped` bag at build time:

```ts
import { act, InMemoryCache } from "@rotorsoft/act";
import { PostgresStore } from "@rotorsoft/act-pg";

const tenantApp = act()
  .withState(...)
  .build({
    scoped: {
      store: new PostgresStore({ schema: "tenant_a" }),
      cache: new InMemoryCache({ maxSize: 5000 }),
    },
  });
```

The framework threads the bag through `AsyncLocalStorage` and wraps every public Act method (`do`, `load`, `query`, `drain`, `settle`, `close`, ...) so internal `store()`/`cache()` calls resolve to the scoped ports transparently. Adapters are unchanged. Both `store` and `cache` are required together — sharing a single cache across two distinct stores would collide on stream-keyed entries.

### The shared-builder pattern (multi-tenant, A/B testing)

For more than a couple of Acts — multi-tenant SaaS, parallel test workers, side-by-side store experiments — hold the builder in a constant and call `.build({ scoped: ... })` once per tenant. The builder is reusable: the first build performs one-time work (projection merge, deprecation scan, startup advisory) and subsequent builds reuse the merged registry to produce independent Acts.

```ts
import { act, InMemoryCache, projection, state } from "@rotorsoft/act";
import { PostgresStore } from "@rotorsoft/act-pg";

// Compose the blueprint once — no `.build()` yet.
const tenantBuilder = act()
  .withState(Order)
  .withState(Customer)
  .withProjection(OrderProjection)
  .on("OrderPlaced").do(reduceInventory).to("inventory");

// One Act per tenant, each with its own store + cache.
const apps = new Map<string, ReturnType<typeof tenantBuilder.build>>();
for (const tenant of tenants) {
  apps.set(
    tenant,
    tenantBuilder.build({
      scoped: {
        store: new PostgresStore({ schema: tenant }),
        cache: new InMemoryCache({ maxSize: 5000 }),
      },
    })
  );
}

// New tenants signing up mid-process can call `.build()` lazily too.
function onTenantSignup(tenant: string) {
  apps.set(
    tenant,
    tenantBuilder.build({
      scoped: {
        store: new PostgresStore({ schema: tenant }),
        cache: new InMemoryCache({ maxSize: 5000 }),
      },
    })
  );
}
```

The per-Act mutable state (drain controller, correlate cycle, settle loop, notify subscription, lifecycle emitter) is constructed fresh on every `.build()`. The shared blueprint (registry, states map, batch handlers, deprecation set) is read-only post-build and is passed by reference to each Act — multi-tenant memory cost is dominated by the per-Act mutable state, not by N copies of the registry.

A/B store experiments are the same pattern with `tenants` replaced by the experiment arms — `apps.set("control", build({scoped: oldStore + oldCache}))` and `apps.set("candidate", build({scoped: newStore + newCache}))`.

### When this is necessary

Concrete scenarios:

- **Multi-tenant SaaS in one process.** Each tenant gets a dedicated store (e.g., per-schema `PostgresStore` on a shared host, or one DB per tenant) and a dedicated cache. The application code stays singleton-style — no parameter threading — because internals read `store()`/`cache()` and the ALS context dispatches to the right tenant on every call.
- **Parallel test workers in one process.** Vitest's `--threads=false` worker model and integration tests that want strict isolation without spinning up a process per test. Each test builds its own Act with a fresh `InMemoryStore` + `InMemoryCache`, and concurrent test bodies don't leak through the singleton.
- **Hybrid storage per bounded context.** A monolith where the "orders" context lives in Postgres but "audit" lives in SQLite (or vice versa). Each bounded context gets its own Act bound to its own backing store. Reactions across contexts go through whatever cross-process mechanism the operator wires (HTTP, message bus, or `Store.notify` if both speak the same protocol).
- **Side-by-side store experiments.** Running an existing Act on `PostgresStore` and a candidate Act on a new adapter in parallel to compare correctness or performance under live traffic — both pinned to the same process so they see the same input stream.

### When *not* to use it

- **Single-tenant single-store apps.** Use the singleton path. The scoped overlay is invisible against everyday work but it still adds an `AsyncLocalStorage.run()` wrap on every method call; there's no reason to opt in if you don't need isolation.
- **Different *defaults* on the same store.** If the goal is just "use a different cache size" or "use a different log level," configure that via the adapter constructor on the singleton path. Scoped ports are for distinct adapter instances.

### Contracts and caveats

- **Notify subscriptions bind to the scoped store at construction.** `Store.notify` is wired once per Act, against `options.scoped.store` when scoped or the singleton otherwise. Same as the singleton case: late injection after `build()` doesn't take effect.
- **Lifecycle is the operator's.** Scoped adapters are *not* registered with the framework's `dispose()` registry. You own them — dispose them explicitly (or wrap your own `dispose()` callback that does). The singleton registry only tracks adapters installed via `store(adapter)` / `cache(adapter)` / `log(adapter)`.
- **Logger stays singleton.** `ActOptions.scoped` doesn't include a logger; all Acts in a process share `log()`. Per-Act logger overrides aren't required by current scenarios — add via child binding (`log().child({ tenant: ... })`) at the call site if you need correlation.
- **Performance.** ALS adds no measurable overhead in modern Node — the port getter is ~65 ns whether scoped or not, and `app.do()` / `app.load()` show no difference between scoped and unscoped Acts. See [`libs/act/PERFORMANCE.md` § Per-Act scoped ports](https://github.com/Rotorsoft/act-root/blob/master/libs/act/PERFORMANCE.md).

## Pointers

- `libs/act/src/ports.ts` — `port()` factory and the three default ports
- `libs/act/src/types/ports.ts` — `Store`, `Cache`, `Logger`, `Disposable` contracts
- `libs/act/src/adapters/` — default in-memory implementations of all three
- `libs/act-pg/src/PostgresStore.ts`, `libs/act-sqlite/src/SqliteStore.ts`, `libs/act-pino/src/index.ts` — production adapters
- `libs/act-pg/test/stress/` — multi-process stress harness exercising the Store contract under contention; useful as a worked example of which invariants the framework actually depends on
