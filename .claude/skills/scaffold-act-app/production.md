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

## Cache Strategy

Cache is always-on by default with `InMemoryCache` (LRU, maxSize 1000). It stores the latest state checkpoint per stream, eliminating full event replay on every `load()`. Actions update the cache after each successful commit; concurrency errors invalidate stale entries automatically.

### Single-Process Deployment

No configuration needed — `InMemoryCache` works transparently. All `load()` calls after the first action are guaranteed cache hits with zero store replay, regardless of stream length.

### Multi-Process / Distributed Deployment

`InMemoryCache` is per-process — each worker maintains its own cache. This is fine for most deployments because:
- Cache misses simply fall back to the store (with snapshots for cold-start resilience)
- The cache is rebuilt naturally as actions are processed

For workloads where cross-process cache sharing matters (e.g., many workers loading the same hot streams), implement the `Cache` interface backed by Redis:

```typescript
import { cache } from "@rotorsoft/act";

cache(new RedisCache({ url: process.env.REDIS_URL ?? "redis://localhost:6379" }));
```

The `Cache` interface is async, so external adapters work without changing framework code:

```typescript
interface Cache extends Disposable {
  get<TState>(stream: string): Promise<CacheEntry<TState> | undefined>;
  set<TState>(stream: string, entry: CacheEntry<TState>): Promise<void>;
  invalidate(stream: string): Promise<void>;
  clear(): Promise<void>;
}
```

### Snapshots for Cold-Start Resilience

On process restart or LRU eviction, the cache is empty. Configure `.snap()` on long-lived states to limit event replay from the store:

```typescript
const Account = state({ Account: schema })
  // ...
  .snap((s) => s.patches >= 50)  // snapshot every 50 events
  .build();
```

Without snapshots, a cold-start `load()` replays the entire event stream. With snap@50, it replays at most 49 events from the last snapshot.

## Background Correlation (Large-Scale)

For high-throughput deployments, use periodic background correlation instead of (or in addition to) `app.settle()`:

```typescript
import { dispose } from "@rotorsoft/act";

// Periodic correlation resolution — discovers new reaction streams every 3s
const stop = app.start_correlations({ after: 0, limit: 10 }, 3000);

// Graceful shutdown — dispose() cleans up all adapters (store, cache, etc.)
process.on("SIGTERM", async () => {
  stop();
  await dispose()();
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

These patterns apply when building apps that need live state push (SSE/WebSockets) on top of act's event sourcing. Use `@rotorsoft/act-sse` for incremental state broadcast.

Install: `pnpm -F @my-app/app add @rotorsoft/act-sse`

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

### Incremental State Broadcast with `@rotorsoft/act-sse`

Instead of sending the full aggregate state to every client after each action, `act-sse` computes RFC 6902 JSON Patches between consecutive states and sends only the diff — falling back to full state when the patch is too large or the client needs to resync.

**Version contract:** `_v` is always set from `snap.event.version` — the event store's monotonic stream version. No separate version counters.

```
  app.do() → snap
      │
      ▼
  deriveState(snap)              ← app-specific (overlay presence, deadlines, etc.)
  state._v = snap.event.version  ← event store version is the single source of truth
      │
      ▼
  broadcast.publish(streamId, state)
      │
      ├── compare(prev, state) → RFC 6902 ops
      ├── ops ≤ threshold  → PatchMessage  { _type: "patch", _baseV, _v, _patch }
      ├── ops > threshold  → FullStateMessage { _type: "full", _v, ...state }
      └── push to all SSE subscribers
      │
      ▼
  Client: applyBroadcastMessage(msg, cached)
      │
      ├── full   → accept if _v ≥ cachedV
      ├── patch  → apply if _baseV === cachedV
      ├── stale  → skip (client ahead, mutation response arrived first)
      └── behind → invalidate + refetch (client missed a version)
```

### Server-Side Setup

```typescript
import { BroadcastChannel, PresenceTracker } from "@rotorsoft/act-sse";
import type { BroadcastState } from "@rotorsoft/act-sse";

// Extend BroadcastState with your app-specific fields
type MyAppState = BroadcastState & {
  // ... your domain state shape
  turnDeadline: string | null;
};

// Create broadcast channel + presence tracker
const broadcast = new BroadcastChannel<MyAppState>({
  maxPatchOps: 50,   // fall back to full state above this
  cacheSize: 50,     // LRU cache entries
});
const presence = new PresenceTracker();

// After every app.do() — the single broadcast entry point
function broadcastState(streamId: string, snap: Snap) {
  const state = deriveFullState(snap);           // app-specific state derivation
  state._v = snap.event.version;                 // MUST set from event store version
  const withPresence = applyPresence(state, streamId); // app-specific overlay
  broadcast.publish(streamId, withPresence);
}

// For non-event state changes (e.g. presence toggle)
function broadcastPresenceChange(streamId: string) {
  const cached = broadcast.getState(streamId);
  if (!cached) return;
  const withPresence = applyPresence(cached, streamId);
  broadcast.publishOverlay(streamId, withPresence);
}
```

### Client-Side Patch Application

```typescript
import { applyBroadcastMessage } from "@rotorsoft/act-sse";

// In SSE onData handler (React Query):
onData: (msg) => {
  const cached = utils.getState.getData({ streamId });
  const result = applyBroadcastMessage(msg, cached);

  if (result.ok) {
    utils.getState.setData({ streamId }, result.state);
  } else if (result.reason === "behind" || result.reason === "patch-failed") {
    utils.getState.invalidate({ streamId }); // trigger full refetch
  }
  // "stale" → no-op (client already has newer state from mutation response)
}
```

### SSE Subscription Pattern (tRPC)

```typescript
import type { BroadcastMessage } from "@rotorsoft/act-sse";

onStateChange: publicProcedure
  .input(z.object({ streamId: z.string(), identityId: z.string().optional() }))
  .subscription(async function* ({ input, signal }) {
    const { streamId, identityId } = input;

    let resolve: (() => void) | null = null;
    let pending: BroadcastMessage<MyAppState> | null = null;

    const cleanup = broadcast.subscribe(streamId, (msg) => {
      pending = msg;
      if (resolve) { resolve(); resolve = null; }
    });

    if (identityId) {
      presence.add(streamId, identityId);
      broadcastPresenceChange(streamId);
    }

    try {
      // Yield current state on connect (always full state for reconnects)
      const cached = broadcast.getState(streamId);
      if (cached) yield { _type: "full" as const, ...cached, serverTime: new Date().toISOString() };

      while (!signal?.aborted) {
        if (!pending) {
          await new Promise<void>((r) => {
            resolve = r;
            signal?.addEventListener("abort", () => r(), { once: true });
          });
        }
        if (signal?.aborted) break;
        if (pending) {
          const msg = pending;
          pending = null;
          yield msg;
        }
      }
    } finally {
      cleanup();
      if (identityId) {
        presence.remove(streamId, identityId);
        broadcastPresenceChange(streamId);
      }
    }
  }),
```

### Aggregate Snapshots vs Projection State

The snapshot from `app.do()` has all event patches applied — it is the authoritative current state. Projections run asynchronously via `settle()` and can lag behind by any amount.

**Rule: The hot path (API responses, SSE push, in-memory cache) must use aggregate snapshots, never projection state.**

The `BroadcastChannel` from `act-sse` maintains an LRU cache seeded from aggregate snapshots. Projections should maintain their own cache to avoid double-apply bugs.

```typescript
// Hot path: broadcast from aggregate snapshot (uses act-sse internally)
const snap = await doAction("Update", target, payload);
broadcastState(streamId, snap);

// Projection: writes DB + its own cache only
async function writeProjection(streamId: string, state: State) {
  await db.upsert(streamId, state);
  projCache.set(streamId, state);
  // NEVER write to broadcast.cache here — projection state may be stale
}
```

### The Double-Apply Bug

If a projection's read-modify-write falls back to the live cache on a miss, it reads state that already has event patches applied (from the aggregate snapshot). The projection then re-applies those same patches, corrupting counters, indices, and other incremental fields.

```typescript
// BUG — live cache holds post-event snapshots, projection double-applies
async function upsertProjection(streamId, mutator) {
  let state = projCache.get(streamId) ?? broadcast.getState(streamId);
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

All code paths that call `app.do()` — API handlers, background workers, timers — should funnel through one broadcast function that calls `broadcast.publish()`. This guarantees consistent cache seeding, subscriber push, and side effects (e.g., scheduling timers).

```typescript
const snap = await doAction("SomeAction", target, payload);
broadcastState(streamId, snap); // single function, every path
```

### Bootstrap Order

Initialize in this order: DB → event store (+ optional cache adapter) → initial settle (replays events and runs projections) → warm caches → enable background processes.

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
