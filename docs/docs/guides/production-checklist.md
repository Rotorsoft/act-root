---
id: production-checklist
title: Production checklist
sidebar_position: 3
---

# Production checklist

A walk-through of the wiring you actually need to run an Act app in production. This is the page to consult when moving from `pnpm dev` to a deployed service. Each section is the minimum that's not negotiable, plus the knobs you'll tune in the next 90 days of operating.

## 1. Pick a real store

The default `InMemoryStore` is a no-op on `seed()` and loses everything on restart. Production needs a persistent store:

```typescript
import { store } from "@rotorsoft/act";
import { PostgresStore } from "@rotorsoft/act-pg";

store(new PostgresStore({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT ?? 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  schema: process.env.DB_SCHEMA ?? "public",
  table: process.env.DB_TABLE ?? "events",
}));
```

A few production-relevant defaults to override depending on workload:

- **`max` connections (PG pool).** The `pg.Pool` default is 10. For drain-heavy workloads (many parallel reaction streams), raise to match your Postgres `max_connections` budget.
- **`schema` and `table`.** Multi-tenant apps often want one schema per tenant. The store accepts both — use them rather than namespacing stream IDs.
- **Initialize the schema.** Run `await store().seed()` once on first deploy (creates the `events` and `_streams` tables, indexes, etc.). Idempotent — safe to keep in your bootstrap.

`SqliteStore` from `@rotorsoft/act-sqlite` is the right choice for embedded / single-node deployments. Same interface; no pool tuning.

## 2. Wire `settle()` to `"committed"`

Without this, projections and reactions never run. The canonical pattern, set once at bootstrap:

```typescript
app.on("committed", () => app.settle());
```

`settle()` is debounced (default 10ms) and non-blocking. Multiple commits inside the debounce window collapse into a single `correlate → drain` pass. The function returns void; await the `"settled"` event when you need to know the framework is idle.

Tune the debounce via `act().build({ settleDebounceMs: 25 })` if your workload bursts in tight loops (you'll see the `"settled"` event fire more often, with smaller batches).

## 3. Listen for `"blocked"`

When a reaction handler exceeds its retry budget, Act marks the stream `blocked: true` and stops processing it. Without an alert, you'll discover the problem when a customer notices their projection is stale.

```typescript
app.on("blocked", (blocked) => {
  for (const { stream, error, retry } of blocked) {
    logger.error({ stream, error, retry }, "stream blocked");
    metrics.increment("act.streams.blocked", { stream });
  }
});
```

Pair with monitoring: `act.streams.blocked` should be a 0-floor counter. Any non-zero is a paging condition. Use `app.blocked_streams()` to inspect what's blocked, then recover with `app.unblock(input)` after fixing the root cause — the stream resumes from where it stopped without re-processing history. `unblock` accepts either an explicit name list or a `StreamFilter` for bulk recovery (e.g., `app.unblock({ stream: "^webhooks-out-" })` to clear a whole family at once). Use `app.reset(input)` only when you actually want to rebuild from event 0 (projection rebuilds).

Per-reaction defaults: `maxRetries: 3`, `blockOnError: true`. Tune via `.do(handler, { maxRetries: 5, blockOnError: false })` per handler — see [Error handling → Per-reaction options](../concepts/error-handling.md#per-reaction-options).

## 4. Set a snapshot policy

On cold start (process restart or LRU eviction), `load()` replays every event in the stream. For a 50,000-event stream, that's a perceptible delay. Snapshots cap the replay distance — define a snap predicate per state:

```typescript
const Counter = state(/* … */)
  .init(/* … */)
  .emits(/* … */)
  .patch(/* … */)
  .on(/* … */)
  .snap((s) => s.patches >= 50)
  .build();
```

The framework calls your predicate after each commit. When it returns true, Act writes a `__snapshot__` event containing the current state. On the next cold load, the replay starts from the most recent snapshot — never further back than `s.patches` events.

Reasonable starting policies:

- **`s.patches >= 50`** for short-lived streams (orders, user sessions): bounds replay to ~50 events.
- **`s.patches >= 500`** for long-lived streams (counters, inventory items): fewer snapshots, smaller event log.
- **No snap policy** for streams with bounded length (single-day TTLs, capped event count): cheaper than snapping.

Snapshot writes are fire-and-forget; they don't block the action's return. Failures log via `snap()`'s try/catch but never propagate.

## 5. Idempotency at the API edge

Act's optimistic concurrency catches stream-version conflicts (`ConcurrencyError`) but doesn't dedupe API requests. If a client retries a network-failed `POST`, you can commit the same domain event twice.

This is a **caller** concern — typically a tRPC/Express middleware that caches responses by an `idempotencyKey` header:

```typescript
const seen = new Map<string, { body: unknown; expiresAt: number }>();

const idempotent = t.middleware(async ({ rawInput, next }) => {
  const key = (rawInput as any)?.idempotencyKey;
  if (key) {
    const cached = seen.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return { ok: true, data: cached.body };
    }
  }
  const result = await next();
  if (key && result.ok) {
    seen.set(key, { body: result.data, expiresAt: Date.now() + 86_400_000 });
  }
  return result;
});
```

For multi-instance deployments, swap the in-memory `Map` for Redis. The point is to keep "have I seen this request before?" out of the event log — correlation IDs there are for tracing, not deduplication.

## 6. Graceful shutdown

Signal handling is built in. Importing the framework registers `process.once` handlers for `SIGINT`, `SIGTERM`, `uncaughtException`, and `unhandledRejection`, all routed through `disposeAndExit`. You don't bind signal handlers yourself — register the cleanup that's specific to your application:

```typescript
import { dispose } from "@rotorsoft/act";

dispose(async () => {
  await httpServer.close();
});

dispose(async () => {
  await redis.quit();
});
```

When a signal fires, the shutdown sequence runs in this order: custom disposers in reverse registration order, then port adapters (logger, store, cache) in reverse registration order, then `process.exit`. Reverse order matters — the HTTP server stops accepting connections before the store closes, so an in-flight request can still finish its commit.

`dispose()` called with no argument returns the trigger function, useful for manual shutdown or tests:

```typescript
afterAll(async () => {
  await dispose()();
});
```

In production, `disposeAndExit("ERROR")` from an uncaught promise is deliberately suppressed (logged as a warning, process kept alive) so a transient failure in a non-critical path doesn't kill the service. SIGINT/SIGTERM still exit cleanly.

## 7. Logging

Default is `ConsoleLogger` — one JSON line per event in production (set `NODE_ENV=production`), colorized human output in dev. For pino's transport ecosystem (file rotation, OpenTelemetry, etc.):

```typescript
import { log } from "@rotorsoft/act";
import { PinoLogger } from "@rotorsoft/act-pino";

log(new PinoLogger({ level: process.env.LOG_LEVEL ?? "info" }));
```

`LOG_LEVEL=trace` enables breadcrumb logging across `load`, `action`, `claim`, `ack`, `block` — useful for debugging a specific stream's drain trajectory. Don't ship `trace` to production unless you've sized your log pipeline for it.

## 8. Observability

Three counters cover most operational questions:

| Metric | When to alert |
|---|---|
| `act.streams.blocked` (gauge) | `> 0` for more than 1 minute |
| `act.commit.concurrency_error` (counter) | sustained rate above ~1% of commits |
| `act.settle.duration_ms` (histogram) | p99 above your tolerable lag |

Hook them via the lifecycle events:

```typescript
app.on("blocked", (xs) => metrics.gauge("act.streams.blocked", xs.length));
app.on("settled", (drain) => {
  metrics.histogram("act.settle.duration_ms", performance.now() - tStart);
  metrics.counter("act.events.processed", drain.fetched);
});
// Concurrency errors come up as exceptions thrown by app.do() — instrument
// them in your tRPC/Express error middleware.
```

The `act-inspector` workspace package gives you a UI on top of the same `query_streams` primitive metrics tools query. It's not a production runtime — run it against a snapshot DB for incident analysis.

## 9. Closing the books

For long-running streams that accumulate events you'll never replay (year-old order history, archived chat sessions), use `app.close()` to archive and truncate:

```typescript
const result = await app.close([
  {
    stream: "order-2024-12345",
    archive: async () => {
      const events = await app.query_array({
        stream: "order-2024-12345",
        stream_exact: true,
      });
      await s3.putObject({
        Key: "orders/2024-12345.json",
        Body: JSON.stringify(events),
      });
    },
  },
]);

app.on("closed", ({ truncated, skipped }) => {
  logger.info({ truncated: truncated.size, skipped }, "books closed");
});
```

Closed streams are tombstoned — `app.do()` against them throws `StreamClosedError`. To re-open with a fresh starting state, `close()` with `restart: true`. See [Architecture → Close cycle](../architecture/close-cycle.md) for the full safety semantics.

## 10. Sizing lanes

If reactions in this app have heterogeneous timing profiles — webhook delivery measured in seconds alongside metric emission measured in microseconds — split them across lanes (ACT-1103). Without lanes, every reaction shares one `leaseMillis` and one `streamLimit`, and the slowest handler dictates the budget for everyone.

```typescript
const app = act()
  .withState(Ticket)
  .withLane({ name: "webhooks", leaseMillis: 30_000, streamLimit: 5, cycleMs: 500 })
  .withLane({ name: "metrics",  leaseMillis: 1_000,  streamLimit: 50, cycleMs: 50  })
  .on("OrderConfirmed").do(deliverWebhook).to({ target: "webhooks-out", lane: "webhooks" })
  .on("OrderConfirmed").do(emitMetric).to({ target: "metrics-out",  lane: "metrics" })
  .build();
```

**Sizing each field:**

- **`leaseMillis`** — set to the longest expected handler invocation in the lane plus headroom (50–100%). A lease shorter than the handler causes premature re-claim and double dispatch; a lease far longer than the handler delays crash recovery (a dead worker's leases stay parked until expiry). For webhook lanes, match your HTTP client timeout. For best-effort lanes, sub-second is usually right.
- **`streamLimit`** — bounds the per-cycle parallel handler budget. With slow handlers (100 ms+), keep this low so an erroring batch doesn't tie up a wide pool of leases. With fast handlers, raise it to amortize the claim round-trip.
- **`cycleMs`** — when set, the lane's controller drives itself at this cadence (independent of the Act's settle loop). Best for "always-on" lanes that need low commit-to-ack latency without callers explicitly driving `settle()`. Omit for lanes that are fine running on the settle debounce.

**Sanity checks for the sizing:**

- [ ] Slow lane's `leaseMillis` ≥ the longest expected handler runtime in that lane
- [ ] Fast lane's `cycleMs` matches the responsiveness target (e.g., 10 ms for sub-100 ms acks)
- [ ] No reaction targets the same stream via two reactions with different lanes (the build-time scan throws on this)
- [ ] If running process-per-lane, `ACT_ONLY_LANES` / `ActOptions.onlyLanes` is wired from env so the same image deploys to every lane
- [ ] Inspector / dashboards filter by `lease.lane` and `position.lane` — every lifecycle event now carries it

See [Configuration → Lanes](../concepts/configuration.md#lanes) for the full API surface, and `libs/act/PERFORMANCE.md § Lane Fan-out` for the headline number: ~7× faster fast-event latency under slow-lane backpressure on Postgres.

## Pre-deploy quick check

Before pushing to production, walk this list mentally:

- [ ] `store(new PostgresStore({…}))` (or SqliteStore) configured before any state is loaded
- [ ] `await store().seed()` runs at bootstrap (idempotent)
- [ ] `app.on("committed", () => app.settle())` wired
- [ ] `app.on("blocked", …)` wired to monitoring
- [ ] Snap policies set on long-lived states
- [ ] Idempotency middleware on mutation endpoints
- [ ] `dispose()` wired to SIGINT/SIGTERM
- [ ] `LOG_LEVEL` and `NODE_ENV` set appropriately
- [ ] Lifecycle metrics exported (blocked, settled, concurrency)
- [ ] Lanes sized per latency class (or all reactions sharing one timing budget is genuinely fine)

Once these are in place, the framework runs itself.
