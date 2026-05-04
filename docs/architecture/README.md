# Architecture

Contributor-facing notes on how the framework's subsystems work together. The public README and JSDoc cover the user-facing surface; this directory covers the parts you only need when working *on* the framework.

Each page targets one subsystem, focuses on the *why* behind the shape (not just the *what* — the source has that), and includes a small ASCII diagram where it helps.

## Pages

| Page | Topic |
|---|---|
| [`concurrency-model.md`](./concurrency-model.md) | Optimistic concurrency (`commit` + `expectedVersion`) vs stream leasing (`claim` + `FOR UPDATE SKIP LOCKED`); how they don't interact |
| [`cache-and-snapshots.md`](./cache-and-snapshots.md) | Two checkpoint layers (in-memory cache + persisted snapshots), how `load()` reads both, time-travel bypass |
| [`correlation-and-drain.md`](./correlation-and-drain.md) | Static vs dynamic resolvers; `_armed` skip-flag; dual-frontier drain; settle's debounced catch-up loop |
| [`close-cycle.md`](./close-cycle.md) | Six phases of close-the-books; failure semantics at each phase; idempotency guarantees |
| [`event-schema-evolution.md`](./event-schema-evolution.md) | Versioned event names; non-breaking-via-defaults vs breaking-via-new-name; why upcasting was rejected |
| [`extension-points.md`](./extension-points.md) | `Store`, `Cache`, `Logger` contracts; invariants adapters must hold; concrete implementations in this repo |

## Audience

A new contributor onto the framework. After reading these six pages plus the relevant source modules, you should be able to:

- Reason about concurrency without confusing optimistic concurrency and lease exclusivity
- Trace a `load()` call through cache and snapshot layers and explain what each output field means
- Walk a reaction from commit → correlate → drain → handler invocation
- Predict what `app.close()` does at every failure point
- Add a new event version without breaking existing readers
- Implement a new `Store`/`Cache`/`Logger` adapter that the framework will trust

## Where to look in source

Every page links to the relevant source files at the bottom. The internal modules are under `libs/act/src/internal/`; the adapters are under `libs/act/src/adapters/` and the lib-specific packages (`libs/act-pg/`, `libs/act-sqlite/`, `libs/act-pino/`).
