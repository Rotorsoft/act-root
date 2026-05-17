# @rotorsoft/act

[![NPM Version](https://img.shields.io/npm/v/@rotorsoft/act.svg)](https://www.npmjs.com/package/@rotorsoft/act)
[![NPM Downloads](https://img.shields.io/npm/dm/@rotorsoft/act.svg)](https://www.npmjs.com/package/@rotorsoft/act)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

_Event sourcing without the ceremony — three primitives, Zod end to end, no broker required._

## Why this package

Most event-sourcing frameworks ask you to learn five concepts before you can ship a feature: aggregates, commands, events, sagas, projections. Act asks you to learn three: **Actions → {State} ← Reactions**. Your domain stays in TypeScript, your schemas stay in Zod, your events live in an event store (in-memory by default; swap in Postgres or SQLite via the sibling adapters). The framework wires the pipeline — validation, append-only commit, derived state, fan-out reactions, drain under back-pressure, blocked-stream recovery.

This package is the framework itself: the builders (`state`, `slice`, `projection`, `act`), the port interfaces (`Store`, `Cache`, `Logger`) with bundled in-memory implementations, the orchestrator that runs the correlate → drain loop, and the snapshot/cache layer that keeps `load()` fast on long streams. The published surface is stable under [SemVer](../../STABILITY.md) at 1.0.

For the marketing-shaped overview (what's cool about Act, who it's for, why teams pick it), see the [root README](../../README.md).

## Installation

```bash
pnpm add @rotorsoft/act
```

For production, also install one of the durable stores: [`@rotorsoft/act-pg`](https://www.npmjs.com/package/@rotorsoft/act-pg) (Postgres) or [`@rotorsoft/act-sqlite`](https://www.npmjs.com/package/@rotorsoft/act-sqlite) (SQLite). The bundled `InMemoryStore` is used by default and is intended for development and tests.

## Quick start

```ts
import { act, state } from "@rotorsoft/act";
import { z } from "zod";

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ amount: z.number() }) })
  .patch({ Incremented: ({ data }, s) => ({ count: s.count + data.amount }) })
  .on({ increment: z.object({ by: z.number() }) })
  .emit((action) => ["Incremented", { amount: action.by }])
  .build();

const app = act().withState(Counter).build();

await app.do("increment", { stream: "counter1", actor: { id: "1", name: "u" } }, { by: 5 });
const snap = await app.load(Counter, "counter1");
console.log(snap.state); // { count: 5 }
```

Define state, declare actions, dispatch, load. Everything else — projections, reactions, slices, cross-process drain, time-travel — is more of the same builder calls.

## API

Top-level exports:

- **Builders** — `state()`, `slice()`, `projection()`, `act()` build the domain. `withState`, `withSlice`, `withProjection` compose them.
- **Ports** — `store()`, `cache()`, `log()` are first-call-wins singletons; pass an adapter on first call to override the default. `dispose()` registers shutdown callbacks.
- **`Act` orchestrator** — `do`, `load`, `query`, `query_array`, `query_streams`, `query_stats`, `drain`, `settle`, `correlate`, `reset`, `unblock`, `blocked_streams`, `close` plus lifecycle events (`committed`, `notified`, `settled`, `blocked`, `closed`, …).
- **Errors** — `ValidationError`, `InvariantError`, `ConcurrencyError`, `StreamClosedError`, `NonRetryableError` plus the `Errors` constants for string-matching.
- **In-memory adapters** — `InMemoryStore`, `InMemoryCache`, `ConsoleLogger`.
- **Constants** — `SNAP_EVENT`, `TOMBSTONE_EVENT`.
- **Types** — full re-export of port interfaces, builder result types, lifecycle event payloads.

Full type reference: [typedoc](https://rotorsoft.github.io/act-root/docs/api/).

## Common patterns

### Slices and projections

`slice()` groups partial state with scoped reactions (vertical-slice architecture); `projection()` builds read-model updaters. Compose with `.withSlice()` / `.withProjection()`:

```ts
import { projection, slice } from "@rotorsoft/act";

// Projection — read-model updater. Handlers receive (event, stream).
const CounterProjection = projection("counters")
  .on({ Incremented: z.object({ amount: z.number() }) })
    .do(async ({ stream, data }) => { /* update read model */ })
  .build();

// Slice — partial state + scoped reactions. Handlers receive (event, stream, app).
const CounterSlice = slice()
  .withState(Counter)
  .withProjection(CounterProjection)
  .on("Incremented")
    .do(async (event, _stream, app) => { /* dispatch via app */ })
    .to("counter-target")
  .build();

const app = act().withSlice(CounterSlice).build();
```

Standalone projections (cross-slice events) work at the `act()` level via `.withProjection()`.

### Lifecycle wiring at bootstrap

```ts
import { dispose, log, store } from "@rotorsoft/act";
import { PostgresStore } from "@rotorsoft/act-pg";

store(new PostgresStore({ /* … */ }));
await store().seed();

app.on("committed", () => app.settle());          // drain reactions on every commit
app.on("blocked", (xs) => log().error({ xs }));   // page on blocked streams
dispose(async () => { /* your cleanup */ });      // wired into SIGINT/SIGTERM
```

See the [production checklist](https://rotorsoft.github.io/act-root/docs/guides/production-checklist) for the full pre-deploy walkthrough.

### Time-travel

```ts
await app.load(Counter, "counter1", undefined, { before: 5000 });            // state at event id
await app.load(Counter, "counter1", undefined, { created_before: someDate }); // state at timestamp
```

Same `load()` as everything else. The third parameter is a step-through callback that receives each intermediate snapshot during replay.

### Recovery loop (operating Act)

When a reaction handler fails past its retry budget (or throws `NonRetryableError`), the stream is blocked and stays out of `claim()` results. Operators:

```ts
const blocked = await app.blocked_streams();
// Inspect, fix the underlying cause, then:
await app.unblock(["webhooks-out-customer-42"]);
await app.unblock({ stream: "^webhooks-out-" }); // bulk
```

`unblock` resumes from where the stream stopped — it does **not** replay history. Use `app.reset(...)` only for projection rebuilds.

## Compatibility

- **Node**: >=22.18.0
- **Peer**: `zod` ^4.4.3
- **Bundled deps**: `@rotorsoft/act-patch` (state reducer)
- **Module formats**: ESM + CJS
- **TypeScript**: strict mode recommended for full inference

## Stability

Public API governed by the [Act Stability Charter](../../STABILITY.md). The charter names exactly which surfaces are protected by SemVer (builders, `Act` interface, port interfaces, lifecycle event shapes, public type exports) and what's free to evolve (internal modules, performance characteristics, log formats). Breaking changes require a `BREAKING CHANGE:` commit footer and a written migration note. Charter takes effect at 1.0 (gated on [milestone 1.0](https://github.com/Rotorsoft/act-root/milestone/1)).

## Related packages

- **[@rotorsoft/act-pg](https://www.npmjs.com/package/@rotorsoft/act-pg)** — PostgreSQL store. Production default.
- **[@rotorsoft/act-sqlite](https://www.npmjs.com/package/@rotorsoft/act-sqlite)** — SQLite store. Single-node / edge.
- **[@rotorsoft/act-http](https://www.npmjs.com/package/@rotorsoft/act-http)** — `webhook` for outbound POST from reactions; `/sse` subpath for incremental state broadcast.
- **[@rotorsoft/act-pino](https://www.npmjs.com/package/@rotorsoft/act-pino)** — pino logger adapter.
- **[@rotorsoft/act-patch](https://www.npmjs.com/package/@rotorsoft/act-patch)** — immutable deep-merge patch utility used by state reducers.
- **[@rotorsoft/act-tck](https://www.npmjs.com/package/@rotorsoft/act-tck)** — conformance suite for `Store`/`Cache`/`Logger` adapters.
- **[@rotorsoft/act-diagram](https://www.npmjs.com/package/@rotorsoft/act-diagram)** — interactive SVG diagram of the domain model + `act` CLI.

## Documentation

- **[Get started](https://rotorsoft.github.io/act-root/docs/intro)** — 5-minute walkthrough.
- **[Concepts](https://rotorsoft.github.io/act-root/docs/intro)** — state management, event sourcing, error handling, real-time, testing, configuration.
- **[Architecture](https://rotorsoft.github.io/act-root/docs/architecture)** — concurrency model, cache + snapshots, correlation + drain, cross-process reactions, priority lanes, close-cycle, schema evolution, extension points.
- **[Guides](https://rotorsoft.github.io/act-root/docs/intro)** — production checklist, projections to database, external integration, writing a custom store/cache/logger, contributing a new package, contracts CLI.
- **[PERFORMANCE.md](./PERFORMANCE.md)** — measured throughput numbers, optimization history, and the reaction-latency benchmark answering "how long from `do()` to reaction firing?"
- **[BENCH.md](../../BENCH.md)** — index of every benchmark in the workspace with run commands.

## License

MIT
