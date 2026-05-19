# @rotorsoft/act-sqlite

[![NPM Version](https://img.shields.io/npm/v/@rotorsoft/act-sqlite.svg)](https://www.npmjs.com/package/@rotorsoft/act-sqlite)
[![NPM Downloads](https://img.shields.io/npm/dm/@rotorsoft/act-sqlite.svg)](https://www.npmjs.com/package/@rotorsoft/act-sqlite)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

_SQLite event store for [@rotorsoft/act](https://www.npmjs.com/package/@rotorsoft/act) via [`@libsql/client`](https://github.com/tursodatabase/libsql-client-ts). File-based, edge-ready, ACID — for single-node deployments. Lane-aware claim/ack via `streams.lane` + `streams_lane_ix` since v0.9.0 ([ACT-1103](https://github.com/Rotorsoft/act-root/issues/733))._

## Why this package

Not every Act app needs Postgres. Single-server apps, embedded deployments, edge functions, and unit tests all want the same thing: a real event store with ACID guarantees, but no operational overhead. `SqliteStore` is that — `@libsql/client` under the hood (zero native bindings, browser-incompatible parts already stripped), full conformance with Act's `Store` port, the same one-line bootstrap swap.

SQLite serializes all writes at the database level. For a single-server deployment this gives you the same isolation guarantees as Postgres's `FOR UPDATE SKIP LOCKED` without any coordination layer. When you outgrow that — multi-server distributed processing, sub-poll cross-process wakeup — swap in `@rotorsoft/act-pg`. Application code doesn't change.

## Installation

```bash
pnpm add @rotorsoft/act @rotorsoft/act-sqlite
```

## Quick start

```ts
import { act, state, store } from "@rotorsoft/act";
import { SqliteStore } from "@rotorsoft/act-sqlite";
import { z } from "zod";

// File-based persistence
store(new SqliteStore({ url: "file:myapp.db" }));

// One-time schema setup (idempotent — safe to leave in your bootstrap).
await store().seed();

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ amount: z.number() }) })
  .patch({ Incremented: ({ data }, s) => ({ count: s.count + data.amount }) })
  .on({ increment: z.object({ by: z.number() }) })
  .emit((a) => ["Incremented", { amount: a.by }])
  .build();

const app = act().withState(Counter).build();
await app.do("increment", { stream: "c1", actor: { id: "1", name: "u" } }, { by: 1 });
```

## API

- **`SqliteStore`** — class implementing Act's `Store` port. Construct once, pass to `store()`.
- **`SqliteConfig`** — constructor options (`url`, `authToken`).

Full type reference: [typedoc](https://github.com/Rotorsoft/act-root/blob/master/docs/docs/api/act-sqlite/src/README.md).

## Configuration

| Option | Default | Description |
|---|---|---|
| `url` | `file::memory:` | libSQL connection URL. Use `file:path.db` for persistent file, `libsql://…` for Turso. |
| `authToken` | — | Auth token for libSQL server connections (Turso). |

### File-based persistence

```ts
store(new SqliteStore({ url: "file:data/events.db" }));
```

### In-memory (tests / quick experiments)

```ts
store(new SqliteStore()); // defaults to file::memory:
```

### Turso (edge)

```ts
store(new SqliteStore({
  url: process.env.TURSO_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
}));
```

## Common patterns

### Schema setup

```ts
await store().seed();
```

Idempotent. Creates the events table, the streams (subscription) table, and the indexes that support claim ordering. PRAGMA `journal_mode=WAL` is set at the same time so readers don't block writers. Safe to leave in your bootstrap.

### Concurrency model

SQLite serializes write transactions at the database level. No application-layer locking, no `FOR UPDATE SKIP LOCKED` needed — writes queue automatically and `ack`/`block` validate `leased_by` to prevent stale workers from interfering. For a single-server deployment, this gives the same isolation guarantees as Postgres.

### Database schema reference

Created by `seed()`:

- **Events** (`events`): `id` (INTEGER PRIMARY KEY AUTOINCREMENT), `name`, `data` (TEXT/JSON), `stream`, `version`, `created` (ISO 8601), `meta` (TEXT/JSON). Unique index on `(stream, version)`.
- **Streams** (`streams`): `stream` (PK), `source`, `at`, `retry`, `blocked`, `error`, `leased_by`, `leased_until`, `priority`. Composite index on `(blocked, priority DESC, at)`.

## When to use this vs `act-pg`

| You want… | Use |
|---|---|
| Single server / embedded / edge | `act-sqlite` |
| Zero infrastructure setup (file path is the config) | `act-sqlite` |
| Edge runtime with Turso replication | `act-sqlite` (with Turso URL) |
| Multi-server, distributed processing | `act-pg` |
| Sub-poll cross-process reaction latency | `act-pg` (with `notify: true`) |
| Heavy write contention across many writers | `act-pg` |

Both adapters pass the same `runStoreTck` suite. Application code doesn't change between them; only the bootstrap line differs.

## What's intentionally not implemented

**`Store.notify`** is absent. The notify hook is a cross-process wake-up signal that lets a horizontally-scaled deployment skip polling lag on remote commits. SQLite is single-node by design — there's no remote writer to be notified of — so the Act orchestrator falls back to the existing debounce/poll path, which is correct for this topology. If you outgrow it, switch to `@rotorsoft/act-pg`.

## Compatibility

- **Node**: >=22.18.0
- **Peer**: `@rotorsoft/act` >=0.39.0, `zod` ^4.4.3
- **Bundled deps**: `@libsql/client` ^0.17.3 (no native bindings)
- **Module formats**: ESM + CJS
- **Runtimes**: Node, Bun, Deno (libSQL pure-TS implementation); also runs in Turso-compatible edge environments

## Stability

Public API governed by the [Act Stability Charter](../../STABILITY.md). Charter takes effect at 1.0 (gated on [milestone 1.0](https://github.com/Rotorsoft/act-root/milestone/1)).

## Related packages

- **[@rotorsoft/act](https://www.npmjs.com/package/@rotorsoft/act)** — the framework whose `Store` port this implements.
- **[@rotorsoft/act-pg](https://www.npmjs.com/package/@rotorsoft/act-pg)** — sibling store adapter for multi-server / distributed deployments.
- **[@rotorsoft/act-tck](https://www.npmjs.com/package/@rotorsoft/act-tck)** — conformance suite. `SqliteStore` passes `runStoreTck`.

## Documentation

- **[Production checklist](https://rotorsoft.github.io/act-root/docs/guides/production-checklist)** — operator-facing guide; the SQLite path is called out where it differs from the PG path.
- **[Concurrency model](https://rotorsoft.github.io/act-root/docs/architecture/concurrency-model)** — lease lifecycle, single-writer guarantees, optimistic concurrency.
- **[Writing a custom Store adapter](https://rotorsoft.github.io/act-root/docs/guides/writing-a-store)** — for authors building against other databases; `SqliteStore` is one of the reference implementations.

## License

MIT
