# @rotorsoft/act-pg

[![NPM Version](https://img.shields.io/npm/v/@rotorsoft/act-pg.svg)](https://www.npmjs.com/package/@rotorsoft/act-pg)
[![NPM Downloads](https://img.shields.io/npm/dm/@rotorsoft/act-pg.svg)](https://www.npmjs.com/package/@rotorsoft/act-pg)
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
- **Atomic Stream Claiming** - Zero-contention competing consumers via `FOR UPDATE SKIP LOCKED`
- **Auto Schema Setup** - `seed()` creates all required tables, indexes, and schema
- **Cross-Process `LISTEN`/`NOTIFY`** (opt-in) - Set `notify: true` to wake `settle()` immediately on remote commits — no polling lag for horizontally-scaled deployments. Off by default. See [PERFORMANCE.md](./PERFORMANCE.md) for the latency benchmark.
- **Multi-Tenant** - Isolate tenants using separate schemas

## Cross-Process Reactions (opt-in)

For multi-instance deployments, `PostgresStore` implements the optional `Store.notify` hook via `LISTEN`/`NOTIFY` so the orchestrator wakes `settle()` immediately on commits from other processes — no polling delay.

**Opt-in via the `notify: true` config flag.** The cost (per-commit `pg_notify`, dedicated `LISTEN` client per process) is wasted in single-instance deployments, so it defaults to **off** — existing callers see zero behavior change after upgrading. Multi-process apps that need sub-poll wakeup enable it on every store instance involved (writers and listeners both):

```ts
import { act, store } from "@rotorsoft/act";
import { PostgresStore } from "@rotorsoft/act-pg";

const config = { schema: "myapp", table: "events", notify: true };

// Worker A (writer)
store(new PostgresStore(config));
const app = act().withState(Order).build();
await app.do("placeOrder", { stream: "order-1", actor }, payload);

// Worker B (reactions, separate process / pod / box)
store(new PostgresStore(config));   // same DB, same opt-in
const app = act()
  .withState(Order)
  .on("OrderPlaced").do(reduceInventory).to("inventory-1")
  .build();
// On Worker A's commit, Worker B wakes within ~10 ms (vs. polling: ≥ poll interval).
// Optional: tap the lifecycle event for fan-out.
app.on("notified", (n) => sse.broadcast(n));
```

When `notify: true`:
- `commit()` issues one `NOTIFY act_commit_<schema>_<table>` per transaction with the full event batch as a JSON payload.
- The orchestrator auto-subscribes once at `build()` (one dedicated PG client per process — size your pool accordingly).
- The store self-filters its own commits (per-instance UUID in the payload), so the `notified` lifecycle event surfaces only **cross-process** activity. Local commits already arm drain via `do()`.

When `notify: false` (the default): `commit()` skips the `pg_notify` SQL entirely, and `notify` is undefined on the store instance — the orchestrator's auto-wire short-circuits, no LISTEN client is allocated.

`notify` is a hint, not a contract: lost notifications fall back to the existing debounce/poll path. Correctness is preserved.

**Build-time contract:** call `store(adapter)` *before* `act()...build()`. The orchestrator binds notify to whichever store is current at construction; late injection won't take effect.

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
- `leased_by` / `leased_until` - distributed processing claim info
- `blocked` / `error` - error tracking for failed streams
- `priority` - scheduling priority (default 0; higher wins lagging-frontier ties — see [Priority lanes](https://rotorsoft.github.io/act-root/docs/architecture/priority-lanes))

The `priority` column is added by `seed()` via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so existing tables migrate transparently. A composite index on `(blocked, priority DESC, at)` supports the saturated-claim ORDER BY without a sort step.

## Competing Consumer Pattern

The PostgreSQL adapter uses `FOR UPDATE SKIP LOCKED` for atomic stream claiming — the idiomatic PostgreSQL competing consumer pattern. The `claim()` method discovers streams with pending events and locks them in a single query:

- Workers never block each other — locked rows are silently skipped
- No race between discovery and locking (unlike a separate poll + lease)
- Same pattern used by pgBoss, Graphile Worker, and other production job queues
- Enables horizontal scaling by simply adding more workers

This replaces the previous two-step poll/lease approach, eliminating contention and simplifying the drain cycle.

## Related

- [@rotorsoft/act](https://www.npmjs.com/package/@rotorsoft/act) - Core framework
- [Documentation](https://rotorsoft.github.io/act-root/)
- [Examples](https://github.com/rotorsoft/act-root/tree/master/packages)

## License

[MIT](https://github.com/rotorsoft/act-root/blob/master/LICENSE)
