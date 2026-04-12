# Server & Production

Server setup in `packages/app/src/` and production deployment patterns.

**Dev vs production server:** The dev server seeds sample data and uses `InMemoryStore` (default) — fast iteration, no database needed. The production server uses `PostgresStore`, calls `settle()` on startup to process any pending reactions from previous runs, and expects data to already exist. Never put seed logic in the production server.

**The cardinal rule of event-sourced APIs: snapshots are truth, projections are eventually consistent.** After `app.do()`, the returned snapshot has all events applied immediately. Projections run asynchronously via `settle()` and may lag. In request handlers, always return data from snapshots. Projections are for list views and background queries, not for mutation responses.

**The `doAction()` helper exists for a reason.** `app.do()` returns an array of snapshots (one per emitted event). Destructuring `const [snap] = await app.do(...)` silently drops later snapshots if the action emits multiple events. Always use the last snapshot: `snaps[snaps.length - 1]`. The `doAction()` helper wraps this to prevent the mistake.

## Dev Server (seed data + API)

```typescript
// packages/app/src/dev-server.ts
import { createHTTPServer } from "@trpc/server/adapters/standalone";
import cors from "cors";
import { app, systemActor } from "@my-app/domain";
import { router, createContext } from "./api/index.js";
import { hashPassword } from "./api/auth.js";

async function seed() {
  const system = { ...systemActor, name: "Seed Script" };

  // Seed domain data via app.do()
  await app.do("CreateItem", { stream: "item-1", actor: system }, { name: "Example Item" });

  // Seed admin user
  const adminHash = hashPassword("admin");
  await app.do("RegisterUser", { stream: "admin", actor: system }, {
    email: "admin", name: "Admin", provider: "local", providerId: "admin", passwordHash: adminHash,
  });
  await app.do("AssignRole", { stream: "admin", actor: system }, { role: "admin" });

  // Drain reactions + projections
  for (let i = 0; i < 3; i++) {
    const { leased } = await app.correlate({ after: -1, limit: 500 });
    if (leased.length === 0) break;
    await app.drain({ streamLimit: 100, eventLimit: 500 });
  }

  console.log("Seeded dev data");
  console.log("  Admin user: admin/admin");
}

const server = createHTTPServer({
  middleware: cors({ origin: true, credentials: true }),
  router,
  createContext,
});
server.listen(4000);

await seed();
console.log("\nAPI server running at http://localhost:4000");
```

## Production Server

```typescript
// packages/app/src/server.ts
import { createHTTPServer } from "@trpc/server/adapters/standalone";
import cors from "cors";
import { app } from "@my-app/domain";
import { router, createContext } from "./api/index.js";
import { bootstrap } from "./bootstrap.js";

await bootstrap();

const server = createHTTPServer({
  middleware: cors({ origin: true, credentials: true }),
  router,
  createContext,
});
const port = Number(process.env.PORT) || 4000;
server.listen(port);

console.log(`Server listening on http://localhost:${port}`);
```

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

## Idempotent API Requests

Request-level idempotency belongs in API middleware, not in the event sourcing framework. Act uses optimistic concurrency (`expectedVersion`) for conflict detection at the store level.

For safe client retries, add a tRPC middleware with a dedicated cache:

```typescript
// packages/app/src/api/middleware.ts
const idempotencyKeys = new Map<string, { response: unknown; expiresAt: number }>();
const IDEMPOTENCY_TTL = 86_400_000; // 24 hours

export const idempotent = t.middleware(async ({ ctx, next, rawInput }) => {
  const key = (rawInput as any)?.idempotencyKey as string | undefined;
  if (key) {
    const cached = idempotencyKeys.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return { ok: true, data: cached.response } as any;
    }
  }
  const result = await next({ ctx });
  if (key && result.ok) {
    idempotencyKeys.set(key, {
      response: (result as any).data,
      expiresAt: Date.now() + IDEMPOTENCY_TTL,
    });
  }
  return result;
});

// Usage in router
const protectedIdempotent = protectedProcedure.use(idempotent);

export const appRouter = router({
  transferFunds: protectedIdempotent
    .input(z.object({
      idempotencyKey: z.string().optional(),
      amount: z.number(),
      streamId: z.string(),
    }))
    .mutation(async ({ input, ctx }) => {
      const snap = await doAction("TransferFunds",
        { stream: input.streamId, actor: ctx.actor },
        { amount: input.amount });
      return snap.state;
    }),
});
```

For distributed deployments, replace the in-memory Map with Redis. The client sends a unique `idempotencyKey` per logical request (typically a UUID generated before the first attempt). Retries send the same key.

**Why not at the framework level?** Framework-level dedup (checking event metadata before commit) has TOCTOU races under concurrent retries, conflates correlation IDs (trace IDs) with idempotency keys, and provides no TTL for stale entries.

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

### Projection Optimization Strategies

Not all events need to hit the database. When a broadcast cache already serves real-time state to clients, projections can be optimized to only persist **summary data** for **lifecycle events** — the subset that changes entity existence or membership.

#### Lifecycle-Only Projections

Classify events into two tiers:

| Tier | Examples | Projection behavior |
|------|---------|---------------------|
| **Lifecycle** — changes existence/membership | `Created`, `MemberAdded`, `Completed`, `Archived`, `Deleted` | Persist summary to DB |
| **Operational** — high-frequency state changes | `Updated`, `ItemMoved`, `FieldChanged`, `EntryLogged` | Skip — broadcast cache is source of truth |

The projection registers handlers **only for lifecycle events**. Operational events are not projected at all — the broadcast cache (seeded after every `app.do()`) is the single source of truth for full state.

```typescript
// Only lifecycle events — no operational handlers needed
const OrderProjection = projection("orders")
  .on({ OrderCreated })
  .do(async (event) => { await persistSummary(event.stream); })
  .on({ MemberAdded })
  .do(async (event) => { await persistSummary(event.stream); })
  .on({ OrderCompleted })
  .do(async (event) => { await persistSummary(event.stream); })
  .build();

// Handler reads from broadcast cache (always hot after app.do())
async function persistSummary(streamId: string): Promise<void> {
  const state = broadcast.getState(streamId);
  if (!state) return; // cold start — bootstrap will rebuild
  const summary = toSummary(state); // lightweight ~500B vs ~2KB full state
  await db.upsert(streamId, summary);
}
```

**Impact:** A typical entity with 250 events might have only ~13 lifecycle events — **95% fewer DB writes**, with each write **75% smaller** (summary vs full state).

#### List View Cache Freshness

The DB projection only updates on lifecycle events, but list views need fresh aggregate counts (totals, progress indicators, etc.) after every event. Solve this with a `settled` listener that syncs broadcast cache → in-memory list cache:

```typescript
app.on("settled", () => {
  for (const [id, state] of broadcast.cache.entries()) {
    listCache.set(id, toSummary(state));
  }
});
```

The list cache stays fresh after every event batch. The DB only writes on lifecycle events. Clients get current data from the list cache; the DB is for cold-start recovery only.

#### Cold-Start Recovery

During server restart, the broadcast cache is empty. Projection handlers skip (no state to read). After `app.settle()` completes:

1. Load summaries from DB (correct for completed/inactive entities from previous run)
2. Rebuild **active** entities from event log → seed broadcast cache + overwrite summaries
3. Enable background processes (timers, scheduled jobs, etc.)

```typescript
async function bootstrap() {
  await initDb();
  await store().seed();
  await settleOnce(); // projection advances watermark, handlers skip

  const entities = await getEntities(); // from DB (previous run)
  const activeIds = Object.entries(entities)
    .filter(([, e]) => e.status !== "completed")
    .map(([id]) => id);

  for (const id of activeIds) {
    const state = await rebuildFromEvents(id);
    broadcast.cache.set(id, { ...state, _v: 0 });
  }

  enableBackgroundProcesses();
}
```

Only active entities replay events (typically few). Completed entities keep their DB summaries from the previous run.

#### Projection Versioning — Rebuilding Stale Projections

When the projected read model shape changes (new fields, renamed fields, derived data), completed entities need their projections rebuilt from the event log. SQL migrations can handle simple data transformations, but when the change requires replaying events through application logic (patches), use **projection versioning** — an application-level migration that runs once per version bump.

**Schema:** Add a `projection_version` integer column (default 0) to the projection table.

```sql
-- Drizzle migration
ALTER TABLE projections ADD COLUMN IF NOT EXISTS projection_version INTEGER NOT NULL DEFAULT 0;
```

**Version constant:** Bump this when the projection shape changes.

```typescript
// schema.ts
export const PROJECTION_VERSION = 1; // bump to trigger rebuild on next deploy
```

**`writeProjection` stamps the version:**

```typescript
async function writeProjection(id: string, data: ProjectionData) {
  await db.insert(projections)
    .values({ id, data, projectionVersion: PROJECTION_VERSION })
    .onConflictDoUpdate({
      target: projections.id,
      set: { data, projectionVersion: PROJECTION_VERSION },
    });
}
```

**Bootstrap queries for stale rows and rebuilds them once:**

```typescript
async function getStaleIds(): Promise<string[]> {
  const rows = await db.select({ id: projections.id })
    .from(projections)
    .where(lt(projections.projectionVersion, PROJECTION_VERSION));
  return rows.map((r) => r.id);
}

async function bootstrap() {
  // ... initDb, settle, warm caches ...

  // Seed broadcast cache for active entities (memory only, no DB write)
  for (const id of activeIds) {
    const state = await rebuildFromEvents(id, { persist: false });
    broadcast.cache.set(id, { ...state, _v: 0 });
  }

  // Rebuild stale projections — runs once per PROJECTION_VERSION bump
  const staleIds = (await getStaleIds()).filter((id) => !activeIds.includes(id));
  for (const id of staleIds) {
    await rebuildFromEvents(id); // replays events, calls writeProjection (stamps version)
  }
  if (staleIds.length > 0) {
    log.info("Bootstrap: rebuilt stale projections", {
      count: staleIds.length,
      version: PROJECTION_VERSION,
    });
  }
}
```

**Key properties:**
- Active entities always rebuild into memory (broadcast cache doesn't survive restarts)
- Completed entities rebuild only when `projection_version < PROJECTION_VERSION`
- After rebuild, `writeProjection` stamps them — next restart skips them
- SQL migrations handle pure data transforms; projection versioning handles changes requiring event replay through application patches

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

### Drizzle Migrations

**Migrations run via `drizzle-kit` CLI before the app starts — never programmatically.** The `db:migrate` script in `packages/app/package.json` runs `cd ../domain && pnpm drizzle-kit migrate`, which reads `drizzle.config.ts` and applies pending migrations.

```bash
# Schema change workflow:
# 1. Edit packages/domain/src/drizzle/schema.ts
# 2. Generate migration SQL:
pnpm -F @my-app/domain drizzle:generate
# 3. Review the generated SQL in packages/domain/drizzle/
# 4. Apply (happens automatically on next dev:api or start):
pnpm -F @my-app/domain drizzle:migrate
# 5. Commit the migration files + meta/ snapshots to git
```

For tests, run migrations with the test DB URL via `execSync`:

```typescript
import { execSync } from "node:child_process";
execSync(`DATABASE_URL=${TEST_DB_URL} pnpm drizzle-kit migrate`, { cwd: "path/to/domain", stdio: "pipe" });
```

> **Never use `drizzle-kit push` in production or shared environments** — only for rapid local prototyping. It provides no audit trail and can cause irreversible data loss.

### Bootstrap Order

Initialize in this order: DB → event store (+ optional cache adapter) → wire `committed` listener → initial settle (replays events and runs projections) → warm caches → enable background processes.

**Critical pattern: settle on committed events.** Reactions produce new events during drain. Those new events fire `committed`, which must trigger another `settle()` to process the reaction's output through projections and further reactions. Without this, projection streams lag behind after reaction chains. Wire `app.on("committed", () => app.settle())` **before** the initial settle so that events produced during startup settle are also processed.

```typescript
async function bootstrap() {
  await initDb();
  await store().seed();

  const settleOpts = { maxPasses: 10, streamLimit: 100, eventLimit: 1000 };

  // Settle after every commit — ensures reaction chains fully propagate
  app.on("committed", () => app.settle(settleOpts));

  // Settle on startup — replays pending events and runs projections
  await new Promise<void>((resolve) => {
    app.on("settled", function handler() {
      app.off("settled", handler);
      resolve();
    });
    app.settle(settleOpts);
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

See dev-server.ts above for the complete seed pattern. Key points:
- Use `systemActor` for seed actions
- Call `correlate()` + `drain()` in a loop after seeding to process all reactions and projections
- Seed an admin user with `hashPassword()` for development access
