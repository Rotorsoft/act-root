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
import { z } from "zod";

const CounterProjection = projection("counters")
  .on({ Incremented: z.object({ amount: z.number() }) })
    .do(async ({ stream, data }) => { /* update read model */ })
  .build();
```

### Batched replay

For high-throughput rebuilds (e.g. catching up after a long downtime, or projecting onto a fresh read model), define a `.batch(handler)` that processes every event for a stream in a single transaction. When defined, `.batch()` is *always* called instead of the per-event `.do()` handlers.

```typescript no-check
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
import { projection, slice, state } from "@rotorsoft/act";
import { z } from "zod";

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ amount: z.number() }) })
  .on({ increment: z.object({ by: z.number() }) })
    .emit((action) => ["Incremented", { amount: action.by }])
  .build();

const CounterProjection = projection("counters")
  .on({ Incremented: z.object({ amount: z.number() }) })
    .do(async ({ stream, data }) => { /* update read model */ })
  .build();

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

```typescript no-check
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
import { act, state } from "@rotorsoft/act";
import { z } from "zod";

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ amount: z.number() }) })
  .on({ increment: z.object({ by: z.number() }) })
    .emit((action) => ["Incremented", { amount: action.by }])
  .build();

const app = act()
  .withState(Counter)
  .build({
    maxSubscribedStreams: 5_000,            // default 1000
    settleDebounceMs: 25,                   // default 10
    circuitBreaker: { failureThreshold: 3, cooldownMs: 10_000 }, // defaults 5 / 30_000
  });
```

- **`maxSubscribedStreams`** (default `1000`) — cap for the LRU tracking what each **dynamically resolved** reaction target was last subscribed at. Apps that mint many dynamic targets (e.g. one stream per user activity) should raise this; for those the LRU is a memory bound, not a correctness mechanism — eviction at most causes a redundant `subscribe()` call, and a target's lane survives being forgotten because the store merges lane with priority rather than overwriting it (#1599). Targets declared statically (`.to({ target, lane, priority })`) are never evicted: they are a bounded, build-time-known list held outside the LRU, so their declared lane and priority stay owned by the build-time subscribe no matter how much dynamic churn passes through (#1582).
- **`settleDebounceMs`** (default `10`) — debounce window used by `settle()` when no per-call `debounceMs` is given. Coalesces commits in the same tick into a single correlate→drain pass. Lower for tight tests; raise for bursty production traffic.
- **`onlyLanes`** (default: every declared lane) — restrict this process to a subset of declared drain lanes (ACT-1103). See [Lanes](#lanes) below.
- **`listen`** (default `true`) — subscribe to `Store.notify` on this instance. Set `false` on writer-only instances: commits still notify, but the instance doesn't subscribe to the channel. The subscriber-connection budget is the practical scaling ceiling for the notify/listen pattern; writer-only fleets shouldn't spend it.
- **`drain`** (default `true`) — run the local reaction pipeline. Set `false` to make `correlate()`, `drain()`, and `settle()` no-ops and skip auto-cycle workers. The `notified` lifecycle event still fires when `listen` is on, so observability sidecars (`listen: true, drain: false`) work.
- **`circuitBreaker`** (defaults: `failureThreshold` 5, `cooldownMs` 30_000) — see [Circuit breaker](#circuit-breaker) below. Out-of-range values throw a `ZodError` at `build()`.
- **`validateFoldedState`** (default `false`) — a debugging aid that parses folded state against its declared schema after every reduction. See [Debugging: validating folded state](#debugging-validating-folded-state) below.

### Circuit breaker

Every `Act` owns one circuit breaker, shared by the drain, settle, and autoclose loops. After `failureThreshold` consecutive store failures it **opens** — those loops skip the store while it's open instead of hammering a down backend — and `cooldownMs` later it **schedules its own retry** (a drain attempt): a pass closes it, a failure re-opens it and reschedules. So recovery is automatic regardless of lane configuration. While the store stays down it keeps probing once per `cooldownMs` (each failed probe re-emits the [`error` event](./error-handling#store-failures-and-the-circuit-breaker)); the timer is `unref()`'d and cleared on recovery or `dispose()`. See [Store failures and the circuit breaker](./error-handling#store-failures-and-the-circuit-breaker).

```typescript
import { act, state } from "@rotorsoft/act";
import { z } from "zod";

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ amount: z.number() }) })
  .on({ increment: z.object({ by: z.number() }) })
    .emit((action) => ["Incremented", { amount: action.by }])
  .build();

const app = act()
  .withState(Counter)
  .build({ circuitBreaker: { failureThreshold: 3, cooldownMs: 10_000 } });
```

- **`failureThreshold`** (default `5`) — consecutive store failures that trip the breaker open.
- **`cooldownMs`** (default `30_000`) — how long it stays open before a half-open trial.

A single-node deployment rarely needs to tune this; raise the threshold for flaky networks, lower the cooldown for faster recovery probing.

### Debugging: validating folded state

Act validates action inputs (against their `.on({...})` schema) and emitted events (against their `.emits({...})` schema), but it does **not** validate the state a reducer folds those events into — reducers are trusted to be total. A reducer that produces schema-violating state (the calculator divide-by-zero that folds `result: NaN` into a `z.number()` field, #1230) fails silently at the source and surfaces hops later as a confusing downstream error.

`validateFoldedState` closes that gap. When set, every reduction — on the command path (`do`), on `load`/cold-replay, and inside the `projection(...).of(state)` projection fold — parses the merged full state against the owning state's declared schema. A bad reduction throws a `ValidationError` **at the triggering event**, whose `target` names the state and the event (`"<state>.<event>#<id>"`), so you see the reducer that produced the bad value instead of the symptom downstream.

```typescript no-check
const app = act()
  .withState(Calculator)
  .build({ validateFoldedState: true }); // dev / CI only
```

This is a **debugging and CI aid, not a production guard**. Turn it on while developing new reducers or in CI to catch total-reducer bugs at the source; leave it off in production.

- **Zero cost when off.** The reduction pipeline names three things: a **reducer** (a state's `.patch()` handler) turns one event into a partial, a **patch step** merges that partial into state, and the **fold** is the loop applying the patch step across a stream's events. The patch step is selected once at `build()` — the same way the orchestrator picks bare vs trace-decorated store ops from the log level. When off (the default), the fold loop is byte-identical to a bare reduction: the validating patch step is never selected, so there is no per-event cost, not even a branch. Flipping the flag is the entire opt-in; there is no per-state wiring.
- **On the projection path**, a bad reduction throws inside the fold batch handler, which blocks the stream — the `ValidationError` message rides the [`blocked`](./error-handling#blocked-streams) lifecycle event's `error`. Recover the same way you recover any blocked stream once the reducer is fixed.
- **Warm cache reads fold nothing**, so they are never validated — the flag guards reductions, not reads. A cold replay (a fresh `load`, a `reset`, or a time-travel `asOf` query) is what re-runs the reducers.

### Deployment shapes via `listen` / `drain`

The two flags are orthogonal — independent costs, independent toggles:

| `listen` | `drain` | Use case |
|---|---|---|
| `true` | `true` | Default. Reactive instance in a multi-process cluster. |
| `false` | `true` | Single-instance app. Nothing else to listen to, but own commits still trigger reactions. Minor optimization. |
| `false` | `false` | Pure writer fleet (write-heavy frontend, ingest worker, API server). Notifies on commit but doesn't react. |
| `true` | `false` | Observability sidecar. Sees every cross-process commit via the `notified` lifecycle event without processing it. |

```typescript
import { act, state } from "@rotorsoft/act";
import { z } from "zod";

const Order = state({ Order: z.object({ placed: z.boolean() }) })
  .init(() => ({ placed: false }))
  .emits({ OrderPlaced: z.object({ sku: z.string() }) })
  .on({ placeOrder: z.object({ sku: z.string() }) })
    .emit("OrderPlaced")
  .build();

// Writer fleet — scales horizontally without touching the subscriber budget.
const writer = act().withState(Order).build({ listen: false, drain: false });

// Reactive fleet — same codebase, opposite flags. Sized to the reaction workload.
const reactor = act()
  .withState(Order)
  .on("OrderPlaced")
    .do(async (event) => { /* reduce inventory */ })
    .to("inventory")
  .build(); // defaults: listen + drain
```

Commits from the writer fleet emit notifications (that's part of the store's commit protocol); the reactor fleet picks them up via its `Store.notify` subscription and runs reactions locally.

## Lanes

By default, every reaction lives in a single implicit `"default"` lane: one `DrainController` runs the whole pipeline with one timing budget. That works until reactions diverge — a webhook delivery wants `leaseMillis` measured in tens of seconds, a best-effort notification wants short retries, and a long projection replay needs a generous claim budget. Tuning any one of them globally penalises the others.

`.withLane({...})` declares an independent drain lane with its own controller, lease budget, claim limit, and cycle cadence. Reactions opt in via `.to({lane})`; reactions without an explicit lane stay in `"default"`.

```typescript no-check
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

```typescript no-check
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

`subscribe()` writes a stream's lane on the same rule it merges priority: the lane rides the max, so a subscribe at or **above** the stored priority sets the lane and one below leaves it alone. The highest priority registered for a stream therefore owns its lane, durably. If you change a target's lane in the builder and restart, the store rewrites the persisted lane on the next `correlate()` — a restart re-subscribes at the same declared priority, and equal priority writes the lane. Online re-laning (changing a stream's lane while workers hold leases) is **not** supported — the safe trigger is process restart.

The rule exists so that a caller which has *forgotten* what a stream carries cannot re-lane it ([#1599](https://github.com/Rotorsoft/act-root/issues/1599)). The orchestrator remembers each dynamically resolved target in a bounded LRU (`maxSubscribedStreams`), and a record can go missing two ways: eviction under pressure, and a restart, which starts every process with an empty map while the rows persist. A missing record reads as never-seen, so without the merge a low-priority resolution would win a lane it had already lost, and a worker sharded on the declared lane would never claim that stream again. One corner follows from the same rule: a stream whose stored priority was raised out of band with `prioritize()` keeps its lane until a subscribe reaches that priority.

### Conflicting lane assignments

Two reactions routing to the same `target` stream must declare the same lane — regardless of their `source`. A stream drains on exactly one lane, so lane must agree target-wide; lanes have no ordering, so there's no `max()` merge analogous to priority — the build-time scan throws on disagreement:

```typescript no-check
// throws at act().build()
act()
  .withState(Ticket)
  .withLane({ name: "slow" }).withLane({ name: "fast" })
  .on("OrderConfirmed").do(handlerA).to({ target: "shared", lane: "slow" })
  .on("OrderConfirmed").do(handlerB).to({ target: "shared", lane: "fast" })
  .build();
```

"The same lane" is decided on the **resolved** lane name, not on how it was spelled. Omitting `lane` and writing `lane: "default"` name the identical lane, so the two forms agree and the build succeeds — a target reached from a generated call site that spells the default out and a hand-written one that leaves it off is a legal configuration, not a conflict:

```typescript no-check
// builds — both reactions land on the default lane
act()
  .withState(Ticket)
  .withLane({ name: "slow" })
  .on("OrderConfirmed").do(handlerA).to({ target: "shared", lane: "default" })
  .on("OrderConfirmed").do(handlerB).to({ target: "shared" })
  .build();
```

A **dynamic** `.to(fn)` resolver is a function until an event arrives, so the build-time scan has nothing to inspect. Correlate applies the same rules where the answer finally exists:

- Two dynamic resolutions disagreeing on one target's lane at equal priority keep the lane the target was first discovered on, and log an error naming both. The lane isn't corrected mid-run — a live stream's lane is the one its in-flight leases were taken under, and re-laning is restart-driven. Until you align the resolvers, the losing reaction runs inside the winner's `leaseMillis` and `streamLimit`, and a process restricted to the losing lane via `onlyLanes` never runs it at all. "Disagreeing" is decided on the **resolved** lane name here too: an omitted `lane` is the default lane, so a resolution that leaves it off and one that names `slow` are the same conflict the build-time guard throws on, reported with `"default"` spelled out. A resolution that outranks what the target already carries isn't a conflict — priority decides the lane, and that outcome is the documented `max()` rule rather than a silent tie.
- A resolution naming an **undeclared** lane is rerouted to `default` and logged — and the rerouted lane is compared like any other, so a target already on `slow` reports the conflict too. No controller claims an undeclared lane, so the stream would otherwise sit at watermark `-1` forever, invisible to `blocked_streams()` and every other health surface. Note that `TLanes` already rejects an undeclared lane at compile time for both resolver forms, so this backstop only fires when the types are bypassed — JavaScript callers, a cast, or a helper whose return type widens `lane` to `string`.

Both are reported **once per offending declaration, not once per target**. A resolver fires for every matching event and the documented per-aggregate shape `.to(e => ({target: e.stream}))` mints a fresh target each time, so a per-target report would scale the log with your aggregate count instead of with the number of declarations you have to fix. The report is keyed on the reaction's handler name plus the lane(s) involved; one resolved target rides along in the message as a concrete example to go look at. Two different misdeclarations still report separately — and a lane conflict reports once per direction it lands, since which side wins is "first discovered" and can differ from target to target.

### `onlyLanes` — process-per-lane deployment

`ActOptions.onlyLanes` restricts which lanes' controllers boot in this process. With `onlyLanes: ["webhooks"]`, only the webhook controller runs; other declared lanes are silent. Workers in different processes coordinate via the store's `SKIP LOCKED` semantics, so the same image can be deployed as one-process-per-lane without code changes.

The exclusion is enforced at `claim()`: every controller filters by its own lane name, so an instance never drains a lane it wasn't given. That includes the implicit `default` lane — once any lane is declared, `default` is an ordinary filtered lane like the rest, and a worker booted with `onlyLanes: ["default"]` claims default-lane streams only. The unfiltered claim (no lane argument, so the adapter keeps its single-lane query shape) is reserved for apps that never call `withLane`.

This is an escape hatch, not the primary path. A single process with multiple declared lanes already gets fast-lane responsiveness — `Act._drainAll` runs every controller's drain in parallel, so a slow lane's in-flight handler doesn't block a fast lane's claim. `onlyLanes` is for the cases where you want hardware isolation (different CPU/memory per lane) on top of that.

Because no single `onlyLanes`-filtered instance drains every lane, the correctness burden shifts to the cluster: the union of every worker's `onlyLanes` must cover every declared lane (`∪ onlyLanes ⊇ declared lanes`), or a lane ends up with no controller anywhere and its streams stall. To surface a half-configured rollout, an instance whose `onlyLanes` excludes a declared lane logs a one-line startup advisory naming the orphaned lane(s) — expected per instance on a sharded cluster, a bug only when the same lane is orphaned by every instance. See [Production checklist → Sizing lanes](../guides/production-checklist.md) for how to reconcile the advisories.

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

```typescript no-check
import { cache } from "@rotorsoft/act";

// Default: InMemoryCache — no setup needed
// For distributed deployments:
cache(new RedisCache({ url: "redis://localhost:6379" }));
```

The `Cache` interface is async for forward-compatibility with external caches:

```typescript no-check
interface Cache extends Disposable {
  get<TState>(stream: string): Promise<CacheEntry<TState> | undefined>;
  set<TState>(stream: string, entry: CacheEntry<TState>): Promise<void>;
  invalidate(stream: string): Promise<void>;
  clear(): Promise<void>;
}
```

### Resource Disposal

All adapters (logger, store, cache, and custom disposers) are cleaned up via `dispose()()`:

```typescript no-check
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

```typescript no-check
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
