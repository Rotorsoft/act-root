---
id: intro
title: Act Framework
---

# Act Framework

**The event-sourcing framework for TypeScript.**

Most business apps can be modeled with just three primitives: **Actions → \{State\} ← Reactions**. Act wires them together with Zod schemas, an immutable event log, and a built-in pipeline that turns reactions into observable workflows. Drop in Postgres for production, SQLite for embedded, or run in-memory for tests; no external message broker required.

## What you get

- **Simplicity** — focus on state, actions, and reactions without boilerplate or code generation
- **Type safety** — TypeScript and Zod for compile-time guarantees and runtime validation
- **Composability** — build complex workflows by composing small, testable state machines
- **Auditability** — every state change is an event, enabling time-travel, debugging, and compliance
- **Adaptability** — swap storage backends, integrate external systems, scale from in-memory to production

## Quick Start

```typescript
import { act, state } from "@rotorsoft/act";
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

const app = act().withState(Counter).build();

const actor = { id: "user1", name: "User" };
await app.do("increment", { stream: "counter1", actor }, { by: 5 });
const snapshot = await app.load(Counter, "counter1");
console.log(snapshot.state.count); // 5
```

## Core Concepts

### Actions → State ← Reactions

1. **Actions** — commands that represent intent to change state
2. **State** — domain entities modeled as immutable data with event-driven transitions
3. **Reactions** — asynchronous responses to state changes that trigger workflows and integrations

### Builders

- **`state()`** — define state machines with actions, events, invariants, and snapshots
- **`projection()`** — read-model updaters that react to events (with optional `.batch()` for high-throughput replay)
- **`slice()`** — vertical feature modules grouping states, projections, and scoped reactions
- **`act()`** — orchestrator that composes states, slices, and projections into an application

### Port/Adapter Pattern

Infrastructure uses swappable adapters injected via `log()`, `store()`, and `cache()` port functions:

- **Logger** — `ConsoleLogger` (default) or `PinoLogger` (`@rotorsoft/act-pino`)
- **Store** — `InMemoryStore` (default), `PostgresStore` (`@rotorsoft/act-pg`), or `SqliteStore` (`@rotorsoft/act-sqlite`)
- **Cache** — `InMemoryCache` (default, LRU) or custom adapters (e.g., Redis)
- **Disposal** — `dispose()()` cleans up all registered adapters on shutdown

### Event Processing

- **Correlation** — dynamic stream discovery via reaction resolvers
- **Drain** — leasing-based reaction processing with dual-frontier strategy
- **Settle** — debounced, non-blocking correlate→drain loop for production
- **Time-travel** — `load()` accepts an `asOf` filter to reconstruct historical state
- **Close the books** — `app.close()` archives, tombstones, or restarts streams

## Packages

### Core

| Package | Description |
|---|---|
| [`@rotorsoft/act`](https://www.npmjs.com/package/@rotorsoft/act) | The framework |
| [`@rotorsoft/act-pg`](https://www.npmjs.com/package/@rotorsoft/act-pg) | PostgreSQL store adapter |
| [`@rotorsoft/act-sqlite`](https://www.npmjs.com/package/@rotorsoft/act-sqlite) | SQLite (libSQL) store adapter |
| [`@rotorsoft/act-patch`](https://www.npmjs.com/package/@rotorsoft/act-patch) | Immutable deep-merge patch utility |

### Supporting

| Package | Description |
|---|---|
| [`@rotorsoft/act-sse`](https://www.npmjs.com/package/@rotorsoft/act-sse) | Server-Sent Events for incremental state broadcast |
| [`@rotorsoft/act-pino`](https://www.npmjs.com/package/@rotorsoft/act-pino) | Pino logger adapter |
| [`@rotorsoft/act-diagram`](https://www.npmjs.com/package/@rotorsoft/act-diagram) | SVG diagram generator |

## Requirements

- Node.js >= 22.18.0
- pnpm >= 10.32.1

## FAQ

**Q: Do I need to use Postgres?**
No. Start with the in-memory store and switch to Postgres or another backend when needed.

**Q: Is Act only for DDD experts?**
No. Act is designed to be approachable for all TypeScript developers, with a focus on simplicity and strong typing.

## License

[MIT](https://github.com/rotorsoft/act-root/blob/master/LICENSE)
