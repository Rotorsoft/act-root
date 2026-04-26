# @rotorsoft/act-sqlite

[![NPM Version](https://img.shields.io/npm/v/@rotorsoft/act-sqlite.svg)](https://www.npmjs.com/package/@rotorsoft/act-sqlite)
[![NPM Downloads](https://img.shields.io/npm/dm/@rotorsoft/act-sqlite.svg)](https://www.npmjs.com/package/@rotorsoft/act-sqlite)
[![Build Status](https://github.com/rotorsoft/act-root/actions/workflows/ci-cd.yml/badge.svg?branch=master)](https://github.com/rotorsoft/act-root/actions/workflows/ci-cd.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

SQLite event store adapter for [@rotorsoft/act](https://www.npmjs.com/package/@rotorsoft/act). Provides persistent, file-based event storage with ACID guarantees via [`@libsql/client`](https://github.com/tursodatabase/libsql-client-ts). Ideal for single-server deployments, edge functions, and embedded applications.

## Installation

```sh
npm install @rotorsoft/act @rotorsoft/act-sqlite
# or
pnpm add @rotorsoft/act @rotorsoft/act-sqlite
```

**Requirements:** Node.js >= 22.18.0

## Usage

```typescript
import { act, state, store } from "@rotorsoft/act";
import { SqliteStore } from "@rotorsoft/act-sqlite";
import { z } from "zod";

// Inject the SQLite store before building your app
store(new SqliteStore({ url: "file:myapp.db" }));

// Initialize tables (creates events table, streams table, and indexes)
await store().seed();

// Build and use your app as normal
const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ amount: z.number() }) })
  .patch({ Incremented: ({ data }, s) => ({ count: s.count + data.amount }) })
  .on({ increment: z.object({ by: z.number() }) })
    .emit((action) => ["Incremented", { amount: action.by }])
  .build();

const app = act().withState(Counter).build();
await app.do("increment", { stream: "counter1", actor: { id: "1", name: "User" } }, { by: 1 });
```

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `url` | `file::memory:` | SQLite connection URL. Use `file:path.db` for persistent storage. |
| `authToken` | — | Auth token for libSQL server connections (Turso). |

### File-Based Storage

```typescript
store(new SqliteStore({ url: "file:data/events.db" }));
```

### In-Memory (Testing)

```typescript
store(new SqliteStore()); // defaults to file::memory:
```

### Turso (Edge)

```typescript
store(new SqliteStore({
  url: process.env.TURSO_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
}));
```

## Features

- **ACID Transactions** — All write operations use SQLite write transactions for atomicity
- **Optimistic Concurrency** — Version-based conflict detection prevents lost updates
- **WAL Mode** — Write-Ahead Logging enables concurrent readers during writes
- **Serialized Writes** — SQLite's single-writer model guarantees mutual exclusion (equivalent to `FOR UPDATE SKIP LOCKED` for single-server use)
- **Auto Schema Setup** — `seed()` creates all required tables and indexes
- **Zero Dependencies** — Only requires `@libsql/client` (no native bindings)
- **Edge-Ready** — Works with Turso for distributed SQLite at the edge

## Database Schema

Calling `seed()` creates two tables:

**Events table** (`events`) — stores all committed events:
- `id` (INTEGER PRIMARY KEY) — global event sequence (autoincrement)
- `name` — event type name
- `data` (TEXT/JSON) — event payload
- `stream` — stream identifier
- `version` — per-stream sequence number
- `created` — ISO 8601 timestamp
- `meta` (TEXT/JSON) — correlation, causation, and actor metadata

**Streams table** (`streams`) — tracks stream processing state:
- `stream` — stream identifier (PRIMARY KEY)
- `source` — source stream pattern for reactions
- `at` — last processed event position (watermark)
- `leased_by` / `leased_until` — processing claim info
- `blocked` / `error` — error tracking for failed streams

## Concurrency Model

SQLite serializes all write transactions at the database level. This means:

- **No lock contention** — write transactions queue automatically
- **Equivalent guarantees** — for single-server deployments, this provides the same isolation as PostgreSQL's `FOR UPDATE SKIP LOCKED`
- **Lease ownership** — `ack()` and `block()` validate `leased_by` to prevent stale workers from interfering

For multi-server deployments requiring distributed stream processing, use [@rotorsoft/act-pg](https://www.npmjs.com/package/@rotorsoft/act-pg) instead.

## SQLite vs PostgreSQL

| Feature | act-sqlite | act-pg |
|---------|-----------|--------|
| Deployment | Single server, edge | Multi-server, distributed |
| Setup | Zero config (file path) | Connection pool config |
| Concurrency | Serialized writes | `FOR UPDATE SKIP LOCKED` |
| JSON storage | TEXT + `json_extract()` | Native JSONB |
| Streaming | Callback pattern | Callback pattern |
| Performance | Fast for moderate loads | Scales horizontally |

## Related

- [@rotorsoft/act](https://www.npmjs.com/package/@rotorsoft/act) — Core framework
- [@rotorsoft/act-pg](https://www.npmjs.com/package/@rotorsoft/act-pg) — PostgreSQL adapter
- [Documentation](https://rotorsoft.github.io/act-root/)
- [Examples](https://github.com/rotorsoft/act-root/tree/master/packages)

## License

[MIT](https://github.com/rotorsoft/act-root/blob/master/LICENSE)
