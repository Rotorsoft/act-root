# Production Deployment

Covers production-specific concerns beyond what's in [monorepo-template.md](monorepo-template.md). The template already provides `app.settle()`, auth crypto, `createContext()`, and dev seed scripts.

## Switch to PostgreSQL

```typescript
import { store } from "@rotorsoft/act";
import { PostgresStore } from "@rotorsoft/act-pg";

store(new PostgresStore({
  host: process.env.PG_HOST ?? "localhost",
  port: Number(process.env.PG_PORT ?? 5432),
  database: process.env.PG_DATABASE ?? "myapp",
  user: process.env.PG_USER ?? "postgres",
  password: process.env.PG_PASSWORD ?? "secret",
  schema: "public",
  table: "events",
}));
```

Install: `pnpm -F @my-app/app add @rotorsoft/act-pg`

## Background Correlation (Large-Scale)

For high-throughput deployments, use periodic background correlation instead of (or in addition to) `app.settle()`:

```typescript
// Periodic correlation resolution — discovers new reaction streams every 3s
const stop = app.start_correlations({ after: 0, limit: 10 }, 3000);

// Graceful shutdown
process.on("SIGTERM", () => {
  stop();
  store().dispose();
});
```

## Automated Jobs

Query projected read models and dispatch actions on schedules:

```typescript
import { systemActor } from "@my-app/domain";

async function autoClose(batchSize: number) {
  const stale = await db.select()
    .from(items)
    .where(lt(items.closeAfter, Date.now()))
    .limit(batchSize);

  for (const item of stale) {
    await app.do("CloseItem", { stream: item.id, actor: systemActor }, {})
      .catch(console.error);
  }
}

setInterval(() => autoClose(10), 15_000);
```

## Error Handling in Production

```typescript
import { Errors } from "@rotorsoft/act";

try {
  await app.do("CreateItem", target, payload);
} catch (error) {
  if (error.message === Errors.ValidationError) { /* bad input */ }
  if (error.message === Errors.InvariantError) { /* rule violated */ }
  if (error.message === Errors.ConcurrencyError) { /* retry */ }
}
```

Error constants: `Errors.ValidationError = "ERR_VALIDATION"`, `Errors.InvariantError = "ERR_INVARIANT"`, `Errors.ConcurrencyError = "ERR_CONCURRENCY"`.

## Drain Options

```typescript
await app.drain({
  streamLimit: 100,   // Max streams to fetch per cycle
  eventLimit: 1000,   // Max events per stream
  leaseMillis: 10000, // Lease duration in ms
});
```

## Observability

```typescript
// Observe all state changes
app.on("committed", (snapshots) => { /* log, metrics */ });

// React when system settles after settle() completes
app.on("settled", (drain) => { /* notify SSE clients, update caches */ });

// Catch reaction failures
app.on("blocked", (leases) => { /* alert on blocked streams */ });

// Query events directly
const events = await app.query_array({ stream: "my-stream" });
```

Set `LOG_LEVEL=debug` or `LOG_LEVEL=trace` for verbose framework logging (uses pino).

## Real-Time Application Patterns

These patterns apply when building apps that need live state push (SSE/WebSockets) on top of act's event sourcing.

### `app.do()` Returns One Snapshot Per Event — Use the Last One

Actions can emit multiple events. `app.do()` returns an array with one snapshot per event. Destructuring `const [snap] = await app.do(...)` silently discards later snapshots.

```typescript
// WRONG — only gets state after the first event
const [snap] = await app.do("EndTurn", target, payload);

// RIGHT — gets final state after all events applied
const snaps = await app.do("EndTurn", target, payload);
const snap = snaps[snaps.length - 1];
```

Wrap this in a helper to avoid the mistake:
```typescript
async function doAction(action: string, target: any, payload: any) {
  const snaps = await app.do(action, target, payload);
  return snaps[snaps.length - 1];
}
```

### Aggregate Snapshots vs Projection State

The snapshot from `app.do()` has all event patches applied — it is the authoritative current state. Projections run asynchronously via `settle()` and can lag behind by any amount.

**Rule: The hot path (API responses, SSE push, in-memory cache) must use aggregate snapshots, never projection state.**

When your app maintains an in-memory cache for real-time push, keep two separate caches:
- **Live cache** — seeded only from aggregate snapshots after `app.do()`. Serves SSE subscribers and reconnecting clients.
- **Projection cache** — private to the projection. Used for its own read-modify-write cycle.

```typescript
// Hot path: seed live cache from aggregate snapshot
function broadcastState(streamId: string, snap: Snap) {
  const state = deriveFullState(snap);
  liveCache.set(streamId, state);
  pushToSubscribers(streamId, state);
}

// Projection: writes DB + its own cache only
async function writeProjection(streamId: string, state: State) {
  await db.upsert(streamId, state);
  projCache.set(streamId, state);
  // NEVER write to liveCache here — projection state may be stale
}
```

### The Double-Apply Bug

If a projection's read-modify-write falls back to the live cache on a miss, it reads state that already has event patches applied (from the aggregate snapshot). The projection then re-applies those same patches, corrupting counters, indices, and other incremental fields.

```typescript
// BUG — live cache holds post-event snapshots, projection double-applies
async function upsertProjection(streamId, mutator) {
  let state = projCache.get(streamId) ?? liveCache.get(streamId);
  mutator(state); // patches applied twice
  await writeProjection(streamId, state);
}

// FIX — fall back to DB only, never live cache
async function upsertProjection(streamId, mutator) {
  let state = projCache.get(streamId);
  if (!state) {
    state = await db.select(streamId) ?? defaultState();
  }
  mutator(state);
  await writeProjection(streamId, state);
}
```

### Single Broadcast Function

All code paths that call `app.do()` — API handlers, background workers, timers — should funnel through one broadcast function. This guarantees consistent cache seeding, subscriber push, and side effects (e.g., scheduling timers).

```typescript
const snap = await doAction("SomeAction", target, payload);
broadcastState(streamId, snap); // single function, every path
```

### Bootstrap Order

Initialize in this order: DB → event store → initial settle (replays events and runs projections) → warm caches → enable background processes.

```typescript
async function bootstrap() {
  await initDb();
  await store().seed();
  await new Promise<void>((resolve) => {
    app.on("settled", function handler() {
      app.off("settled", handler);
      resolve();
    });
    app.settle();
  });
  await warmCaches();
  enableBackgroundProcesses();
}
```

### `settle()` Is Async — Don't Read Projections in the Hot Path

After `app.do()`, `settle()` fires projections in the background. In request handlers, always return state from the snapshot, not from a projection read.

```typescript
// RIGHT — snapshot is immediate and authoritative
const snap = await doAction("Update", target, payload);
broadcastState(streamId, snap);
return { state: snap.state };

// WRONG — projection may not have processed this event yet
const state = await readProjection(streamId); // stale
```

## Seed Data for Development

See `dev-server.ts` in [monorepo-template.md](monorepo-template.md) for the complete seed pattern. Key points:
- Use `systemActor` for seed actions
- Call `correlate()` + `drain()` in a loop after seeding to process all reactions and projections
- Seed an admin user with `hashPassword()` for development access
