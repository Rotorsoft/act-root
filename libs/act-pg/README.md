# @rotorsoft/act-pg

[![NPM Version](https://img.shields.io/npm/v/@rotorsoft/act-pg.svg)](https://www.npmjs.com/package/@rotorsoft/act-pg)
[![NPM Downloads](https://img.shields.io/npm/dm/@rotorsoft/act-pg.svg)](https://www.npmjs.com/package/@rotorsoft/act-pg)
[![Build Status](https://github.com/rotorsoft/act-root/actions/workflows/ci-cd.yml/badge.svg?branch=master)](https://github.com/rotorsoft/act-root/actions/workflows/ci-cd.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

PostgreSQL event store adapter for [@rotorsoft/act](https://www.npmjs.com/package/@rotorsoft/act). Provides persistent, production-ready event storage with ACID guarantees, connection pooling, and distributed stream processing.

## Installation

```sh
npm install @rotorsoft/act @rotorsoft/act-pg
# or
pnpm add @rotorsoft/act @rotorsoft/act-pg
```

**Requirements:** Node.js >= 22.18.0, PostgreSQL >= 14

## Usage

```typescript
import { act, state, store } from "@rotorsoft/act";
import { PostgresStore } from "@rotorsoft/act-pg";
import { z } from "zod";

// Inject the PostgreSQL store before building your app
store(new PostgresStore({
  host: "localhost",
  port: 5432,
  database: "myapp",
  user: "postgres",
  password: "secret",
}));

// Initialize tables (creates schema, events table, streams table, and indexes)
await store().seed();

// Build and use your app as normal
const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ amount: z.number() }) })
  .patch({ Incremented: ({ data }, s) => ({ count: s.count + data.amount }) })  // optional — only for custom reducers
  .on({ increment: z.object({ by: z.number() }) })
    .emit((action) => ["Incremented", { amount: action.by }])
  .build();

const app = act().withState(Counter).build();
await app.do("increment", { stream: "counter1", actor: { id: "1", name: "User" } }, { by: 1 });
```

## Configuration

All configuration fields are optional and have sensible defaults:

| Option | Default | Description |
|--------|---------|-------------|
| `host` | `localhost` | PostgreSQL host |
| `port` | `5432` | PostgreSQL port |
| `database` | `postgres` | Database name |
| `user` | `postgres` | Database user |
| `password` | `postgres` | Database password |
| `schema` | `public` | Schema for event tables |
| `table` | `events` | Base name for event tables |

### Custom Schema and Table Names

```typescript
const pgStore = new PostgresStore({
  host: "db.example.com",
  database: "production",
  user: "app_user",
  password: process.env.DB_PASSWORD,
  schema: "events",       // custom schema
  table: "act_events",    // creates act_events and act_events_streams tables
});
```

### Environment-Based Configuration

```typescript
if (process.env.NODE_ENV === "production") {
  store(new PostgresStore({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || "5432"),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  }));
}
// In development, the default InMemoryStore is used
```

## Features

- **ACID Transactions** - Events are committed atomically within PostgreSQL transactions
- **Optimistic Concurrency** - Version-based conflict detection prevents lost updates
- **Connection Pooling** - Uses [node-postgres](https://node-postgres.com/) Pool for efficient connection management
- **Stream Leasing** - Distributed processing with lease-based coordination
- **Auto Schema Setup** - `seed()` creates all required tables, indexes, and schema
- **NOTIFY/LISTEN** - Real-time event notifications via PostgreSQL channels
- **Multi-Tenant** - Isolate tenants using separate schemas

## Database Schema

Calling `seed()` creates two tables:

**Events table** (`{schema}.{table}`) - stores all committed events:
- `id` (serial) - global event sequence
- `name` - event type name
- `data` (jsonb) - event payload
- `stream` - stream identifier
- `version` - per-stream sequence number
- `created` (timestamptz) - event timestamp
- `meta` (jsonb) - correlation, causation, and actor metadata

**Streams table** (`{schema}.{table}_streams`) - tracks stream processing state for reactions:
- `stream` - stream identifier
- `at` - last processed event position
- `leased_by` / `leased_until` - distributed processing lease info
- `blocked` / `error` - error tracking for failed streams

## Related

- [@rotorsoft/act](https://www.npmjs.com/package/@rotorsoft/act) - Core framework
- [Documentation](https://rotorsoft.github.io/act-root/)
- [Examples](https://github.com/rotorsoft/act-root/tree/master/packages)

## License

[MIT](https://github.com/rotorsoft/act-root/blob/master/LICENSE)
