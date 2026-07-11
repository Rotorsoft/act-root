# @rotorsoft/act-pg

[![NPM Version](https://img.shields.io/npm/v/@rotorsoft/act-pg.svg)](https://www.npmjs.com/package/@rotorsoft/act-pg)
[![NPM Downloads](https://img.shields.io/npm/dm/@rotorsoft/act-pg.svg)](https://www.npmjs.com/package/@rotorsoft/act-pg)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

_PostgreSQL event store for [@rotorsoft/act](https://www.npmjs.com/package/@rotorsoft/act). ACID, connection-pooled, multi-process — production default for Act deployments. Lane-aware claim/ack via `streams.lane` + `streams_lane_ix` since v0.25.0 ([ACT-1103](https://github.com/Rotorsoft/act-root/issues/733))._

## Why this package

Act's in-memory store is fine for development and tests, but production needs durable events, cross-process coordination, and a query path that scales past a single Node process. `PostgresStore` is the canonical production implementation of Act's `Store` port: full ACID guarantees from PG, atomic stream claiming via `FOR UPDATE SKIP LOCKED` (no application-layer locking required), optional `LISTEN`/`NOTIFY` for sub-poll cross-process wakeup, and auto-managed schema via `seed()`.

The adapter passes the same conformance suite (`@rotorsoft/act-tck`) as InMemoryStore and SqliteStore, so swapping it in is a one-line bootstrap change.

## Installation

```bash
pnpm add @rotorsoft/act @rotorsoft/act-pg
```

## Quick start

```ts
import { act, state, store } from "@rotorsoft/act";
import { PostgresStore } from "@rotorsoft/act-pg";
import { z } from "zod";

store(new PostgresStore({
  host: "localhost",
  port: 5432,
  database: "myapp",
  user: "postgres",
  password: "secret",
}));

// One-time schema setup (idempotent — safe to leave in your bootstrap).
await store().seed();

// From here, the framework is identical to the InMemory version.
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

- **`PostgresStore`** — class implementing Act's `Store` port. Construct once, pass to `store()`.
- **`PostgresConfig`** — constructor options (host/port/db/user/password/schema/table/notify).

Full type reference: [typedoc](https://github.com/Rotorsoft/act-root/blob/master/docs/docs/api/act-pg/src/README.md).

## Configuration

All fields are optional and have sensible defaults:

| Option | Default | Description |
|---|---|---|
| `host` | `localhost` | PostgreSQL host |
| `port` | `5432` | PostgreSQL port |
| `database` | `postgres` | Database name |
| `user` | `postgres` | Database user |
| `password` | `postgres` | Database password |
| `schema` | `public` | Schema for event + streams tables |
| `table` | `events` | Base name (`<table>` for events, `<table>_streams` for subscriptions) |
| `notify` | `false` | Opt-in `LISTEN`/`NOTIFY` for cross-process commit wakeup (see below) |
| `max` | `20` | Pool size ceiling (see [Pool tuning](#pool-tuning)) |
| `connectionTimeoutMillis` | `10000` | Client-acquisition timeout — a saturated pool fails fast as `StoreError` instead of hanging |
| `idleTimeoutMillis` | `30000` | Idle clients stay warm across drain cycles before being closed |
| `statement_timeout` | `60000` | Per-statement server-side ceiling — a wedged statement releases its client instead of holding it hostage |
| …rest of `pg.PoolConfig` | (pg defaults) | Pass-through to node-postgres pool config |

```ts
// Production deployment via env vars
store(new PostgresStore({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT ?? 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  schema: process.env.DB_SCHEMA ?? "public",
  max: 40,  // pool size — raise for drain-heavy workloads
}));
```

Multi-tenant deployments often want one schema per tenant. The store accepts both — use them rather than namespacing stream IDs.

### Pool tuning

Nearly every store method checks out a client for a multi-statement transaction — `commit`, `claim`, `ack`, `block`, `subscribe`, `truncate`, `restore` all hold one from `BEGIN` to `COMMIT`. Concurrency stacks up from three directions:

- **Drain lanes.** Every declared lane (plus the implicit `"default"`) runs its own `DrainController`, and all controllers drain in parallel. Within a lane, up to `streamLimit` (default 10) reaction handlers run concurrently — each handler that commits (`app.do` inside a slice) holds a client for the duration of its commit transaction.
- **API traffic.** Every in-flight action handled by your HTTP/tRPC layer holds a client during its commit.
- **`notify: true`.** One extra dedicated long-lived LISTEN client per process.

Sizing rule per process:

```
max ≥ Σ(streamLimit per lane) + peak concurrent API commits + (notify ? 1 : 0) + headroom (2–4)
```

The default `max: 20` covers the single-default-lane case (10) plus modest API concurrency and the LISTEN client. Raise it when you add lanes or expect bursty API traffic; keep the sum across all worker processes under your Postgres `max_connections` budget (minus superuser/maintenance reservations).

When the pool does saturate, acquisition fails after `connectionTimeoutMillis` as a `StoreError` whose `operation` names the starved method (`"commit"`, `"claim"`, …) and whose `cause` carries the driver error — a clear signal to resize, instead of an indefinite hang.

## Common patterns

### Cross-process `LISTEN`/`NOTIFY` (opt-in)

For multi-instance deployments, `PostgresStore` implements the optional `Store.notify` hook via `LISTEN`/`NOTIFY` so the orchestrator wakes `settle()` immediately on commits from other processes — no polling delay. Off by default to keep single-instance deployments allocation-free; enable on every store instance in a multi-process app:

```ts
const config = { schema: "myapp", table: "events", notify: true };

// Worker A (writer)
store(new PostgresStore(config));
const app = act().withState(Order).build();
await app.do("placeOrder", { stream: "order-1", actor }, payload);

// Worker B (reactions, separate process)
store(new PostgresStore(config));
const app = act()
  .withState(Order)
  .on("OrderPlaced").do(reduceInventory).to("inventory-1")
  .build();
// Worker B wakes within ~10ms of Worker A's commit (vs. ≥ poll interval).
app.on("notified", (n) => sse.broadcast(n)); // optional fan-out
```

When `notify: true`: `commit()` issues one `NOTIFY act_commit_<schema>_<table>` per transaction with the full event batch as JSON. The store self-filters its own commits (per-instance UUID), so the `"notified"` lifecycle event surfaces only cross-process activity. Size your pool to account for one extra dedicated LISTEN client per process.

`notify` is a hint, not a contract — lost notifications fall back to the existing debounce/poll path. Correctness is preserved.

**Build-time contract:** call `store(adapter)` *before* `act()…build()`. The orchestrator binds notify to whichever store is current at construction time.

### Competing consumer (free horizontal scaling)

`claim()` uses `FOR UPDATE SKIP LOCKED` — the idiomatic Postgres competing-consumer pattern. Workers never block each other; locked rows are silently skipped. Same approach as pgBoss and Graphile Worker.

Add a second pod, run the same Act app — drain workload splits with zero application-layer coordination. No external job queue, no Redis lock.

### Schema setup

```ts
await store().seed();
```

Idempotent. Creates the events table, the streams (subscription) table, and the indexes that support the claim and notify paths. Safe to leave in your bootstrap. The store transparently runs `ADD COLUMN IF NOT EXISTS` migrations for new optional columns (e.g. `priority` for [priority lanes](https://rotorsoft.github.io/act-root/docs/architecture/priority-lanes)), so existing deployments upgrade in place.

### Database schema reference

Created by `seed()`:

- **Events** (`{schema}.{table}`): `id` (serial PK), `name`, `data` (jsonb), `stream`, `version`, `created` (timestamptz), `meta` (jsonb). Unique index on `(stream, version)`.
- **Streams** (`{schema}.{table}_streams`): `stream` (PK), `source`, `at`, `retry`, `blocked`, `error`, `leased_by`, `leased_until`, `priority`. Composite index on `(blocked, priority DESC, at)` for the saturated-claim ordering.

## Operational concerns

The unpartitioned default schema is the right shape for almost every Act application. If you find yourself wondering whether your `events` table needs partitioning, the first answer is almost always `Act.close()` — see the [Production checklist](https://rotorsoft.github.io/act-root/docs/guides/production-checklist) and the [auto-close epic (#802)](https://github.com/Rotorsoft/act-root/issues/802) for the policies that keep a steady-state events table without partitioning.

For the narrow set of workloads where `close()` genuinely can't help (regulated append-only audit logs, single-aggregate giants, retention-window bulk archival, parallel-rebuild bottlenecks), the operator playbook lives at [`recipes/scaling/`](../../recipes/scaling/README.md) — the page leads with "don't" and walks through the gates before reaching any SQL.

## When to use this vs `act-sqlite`

| You want… | Use |
|---|---|
| Multi-server deployment, distributed processing | `act-pg` |
| Sub-poll cross-process reaction latency | `act-pg` (with `notify: true`) |
| Embedded / single-server / edge | `act-sqlite` |
| Zero-config local dev / tests | The default `InMemoryStore` |

Both adapters pass the same conformance suite — your application code doesn't change.

## Compatibility

- **Node**: >=22.23.1
- **PostgreSQL**: >=14 (uses `FOR UPDATE SKIP LOCKED`, `LISTEN`/`NOTIFY`, JSONB)
- **Peer**: `@rotorsoft/act` >=0.39.0, `zod` ^4.4.3
- **Bundled deps**: `pg` ^8.20.0
- **Module formats**: ESM + CJS

## Stability

Public API governed by the [Act Stability Charter](../../STABILITY.md). `PostgresStore` implements the `Store` contract from `@rotorsoft/act` and is validated against `@rotorsoft/act-tck` across PostgreSQL 14/15/16/17 in CI. Charter is **in effect as of 1.0.0**; the milestone tracker is [milestone 1.0](https://github.com/Rotorsoft/act-root/milestone/1).

## Related packages

- **[@rotorsoft/act](https://www.npmjs.com/package/@rotorsoft/act)** — the framework whose `Store` port this implements.
- **[@rotorsoft/act-sqlite](https://www.npmjs.com/package/@rotorsoft/act-sqlite)** — sibling store adapter for single-node / edge deployments.
- **[@rotorsoft/act-tck](https://www.npmjs.com/package/@rotorsoft/act-tck)** — conformance suite. `PostgresStore` passes `runStoreTck` with `capabilities: { notify: true }`.
- **[@rotorsoft/act-pino](https://www.npmjs.com/package/@rotorsoft/act-pino)** — pino logger adapter, common pairing for production deployments.

## Documentation

- **[Production checklist](https://rotorsoft.github.io/act-root/docs/guides/production-checklist)** — operator-facing guide for taking an Act app to production with this store.
- **[Cross-process reactions](https://rotorsoft.github.io/act-root/docs/architecture/cross-process-reactions)** — when to enable `notify`, what the latency looks like.
- **[Concurrency model](https://rotorsoft.github.io/act-root/docs/architecture/concurrency-model)** — lease lifecycle, `claim`/`ack`/`block`/timeout, optimistic concurrency.
- **[Writing a custom Store adapter](https://rotorsoft.github.io/act-root/docs/guides/writing-a-store)** — the recipe `PostgresStore` itself follows, for authors building against other databases.
- **[PERFORMANCE.md](./PERFORMANCE.md)** — measured throughput numbers, including the `notify` latency benchmark.
- **[Scaling recipes](../../recipes/scaling/README.md)** — operator playbook for the symptoms `act-pg` apps hit at the edges (close-the-books, archival, partitioning). Read this before reaching for any DDL.

## License

MIT
