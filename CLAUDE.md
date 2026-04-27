# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Act is an event sourcing + CQRS + Actor Model framework for TypeScript. The core philosophy: any system distills into **Actions → {State} ← Reactions**. This monorepo contains the core framework libraries and example applications demonstrating various complexity levels.

## Project Structure

This is a pnpm monorepo with two main sections:

- **`/libs`** - Core framework libraries
  - `@rotorsoft/act` - Core event sourcing framework
  - `@rotorsoft/act-pg` - PostgreSQL adapter for production
  - `@rotorsoft/act-sqlite` - SQLite adapter (libSQL) for embedded/single-node deployments
  - `@rotorsoft/act-patch` - Immutable deep-merge patch utility
  - `@rotorsoft/act-sse` - Server-Sent Events for incremental state broadcast

- **`/packages`** - Example applications
  - `calculator` - Simple state machine example
  - `wolfdesk` - Complex ticketing system (from "Learning Domain-Driven Design")
  - `server` - tRPC backend integration
  - `client` - React frontend with Vite

## Common Commands

### Development
```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run tests with coverage
pnpm test

# Type check
pnpm typecheck

# Lint
pnpm lint
pnpm lint:fix

# Run specific examples
pnpm dev:calculator
pnpm dev:wolfdesk
pnpm dev:trpc  # runs both server and client concurrently

# Clean all build artifacts
pnpm clean

# Nuclear option - remove all node_modules and build artifacts
pnpm scrub
```

### Testing
```bash
# Run all tests
pnpm test

# Run tests in watch mode
vitest

# Run tests for specific package
pnpm -F calculator test
pnpm -F wolfdesk test

# Run single test file
vitest packages/calculator/src/__tests__/calculator.test.ts
```

### Database (for examples using PostgreSQL)
```bash
# Run migrations for shared database
pnpm -F shared drizzle:migrate

# Note: migrations run automatically before test suite
```

## Core Architecture

### Three Fundamental Concepts

1. **State** - Domain entities/aggregates with consistency boundaries
   - Defined using Zod schemas for type safety
   - Have initial state and event patches (reducers)
   - Define actions (commands) that emit events

2. **Actions** - User/system intents that modify state
   - Validated using Zod schemas
   - Target a specific stream (state instance)
   - Must emit one or more events
   - Can have invariants (business rules checked before execution)

3. **Reactions** - Asynchronous handlers triggered by events
   - Update other state streams or external systems
   - Include resolver to determine target stream
   - Support retry and error handling
   - Enable event correlation and dynamic stream discovery
   - **Auto-inject `reactingTo`**: When a reaction handler calls `app.do()` without the `reactingTo` parameter, the framework automatically injects the triggering event, maintaining the correlation chain by default. Pass an explicit `reactingTo` to override.

### State Builder Pattern

States are built using a fluent API. `.emits()` declares events with passthrough reducers by default (`({ data }) => data`). Use `.patch()` only for events that need custom reducers. Use `.emit("EventName")` for actions where the payload passes through directly as event data.

```typescript
const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({
    Incremented: z.object({ amount: z.number() })
  })
  .patch({  // optional — only for events needing custom reducers
    Incremented: ({ data }, state) => ({ count: state.count + data.amount })
  })
  .on({ increment: z.object({ by: z.number() }) })
    .emit((action) => ["Incremented", { amount: action.by }])
  .build();

// Simpler: when event data matches state shape and action payload matches event data
const DigitBoard = state({ DigitBoard: schema })
  .init(() => defaults)
  .emits({ DigitCounted: z.object({ digit: z.enum(DIGITS) }) })
  // no .patch() needed — passthrough is the default
  .on({ CountDigit: z.object({ digit: z.enum(DIGITS) }) })
    .emit("DigitCounted")  // string passthrough — action payload becomes event data
  .build();
```

### Utility Types

`InferEvents` and `InferActions` extract inferred types from a built State object, avoiding repetition of the Zod-to-plain-type mapping boilerplate.

```typescript
import type { InferEvents, InferActions } from "@rotorsoft/act";

type Events = InferEvents<typeof Counter>;
// => { Incremented: { amount: number } }

type Actions = InferActions<typeof Counter>;
// => { increment: { by: number } }

// Combine multiple states:
type AllEvents = InferEvents<typeof StateA> & InferEvents<typeof StateB>;
```

### Projection Builder

Projections are read-model updaters that react to events and update external state (databases, caches, etc.). Unlike slices, projections have no states and handlers do not receive the app interface.

```typescript
import { projection } from "@rotorsoft/act";

// Handlers receive (event, stream)
const TicketProjection = projection("tickets")
  .on({ TicketOpened })
    .do(async ({ stream, data }) => {
      await db.insert(tickets).values({ id: stream, ...data });
    })
  .on({ TicketClosed })
    .do(async ({ stream, data }) => {
      await db.update(tickets).set(data).where(eq(tickets.id, stream));
    })
  .build();
```

- `projection(target?)` - Creates a builder; optional default target stream for all handlers
- `.on({ EventName: schema })` - Register an event handler (record shorthand)
- `.do(handler)` - Handler receives `(event, stream)`
- `.to(resolver)` - Override the default resolver per handler
- `.batch(handler)` - Register a batch handler for bulk event processing (static-target projections only). Receives `ReadonlyArray<BatchEvent<TEvents>>` — a discriminated union where `switch (event.name)` narrows both `name` and `data`. When defined, always called instead of individual `.do()` handlers.
- `.build()` - Returns a `Projection` with `_tag: "Projection"`

#### Batched Projection Replay

For high-throughput replay scenarios (rebuilding projections, catch-up after downtime), use `.batch()` to process all events in a single transaction instead of one at a time:

```typescript
const TicketProjection = projection("tickets")
  .on({ TicketOpened })
    .do(async ({ stream, data }) => { /* single-event fallback */ })
  .on({ TicketClosed })
    .do(async ({ stream, data }) => { /* single-event fallback */ })
  .batch(async (events, stream) => {
    await db.transaction(async (tx) => {
      for (const event of events) {
        switch (event.name) {
          case "TicketOpened": /* bulk insert */ break;
          case "TicketClosed": /* bulk update */ break;
        }
      }
    });
  })
  .build();
```

- `.batch()` is only available on static-target projections (`projection("target")`)
- When defined, always called — even for a single event (no conditional switching)
- `BatchEvent<TEvents>` is a distributive discriminated union enabling exhaustive `switch` with `default: never`
- `.do()` handlers serve as fallback for projections without `.batch()`

### Slice Builder

Slices group partial states with scoped reactions into self-contained feature modules (vertical slice architecture). Handlers receive the full `IAct` interface for action dispatch, state loading, and event querying.

**Slice design decisions:**

- **Lifecycle slice first** — every state starts with a lifecycle slice that owns the CRUD-like actions (create, update, close/delete). It may also contain simple reaction flows.
- **One slice per reaction flow** — when reactions are introduced, each serial chain (event → reaction → action → state → event → reaction → …) lives in its own slice. A long serial chain stays in one slice when there is no fan-out at any junction point.
- **Slices are minimal and self-contained** — each slice includes only the state it owns. It defines its own actions, events, patches, reactions, and projections. No foreign states needed.
- **Single state schema, multiple partials** — one Zod schema defines the full state shape. Each slice declares a partial via `state({ Name: Schema })` with its own `.init()`, `.emits()`, `.patch()`, and `.on()`. The framework merges partials at build time.
- **Redeclare trigger events via `.emits()`** — when a slice reacts to an event it doesn't produce, it redeclares the event in `.emits()` so `.on("EventName")` compiles. The passthrough default is discarded in favor of the custom reducer from the partial that owns the event.
- **One custom patch per event enforced at build time** — the merge detects conflicting custom patches for the same event and throws. Re-registration of the same patch (same state via different slices) is allowed. Passthroughs always yield to custom reducers.
- **Serial chains connect slices** — when one slice's output event is another's input with no other subscribers, they can be merged into a single slice.

```typescript
import { slice } from "@rotorsoft/act";

// Handlers receive (event, stream, app) — app implements IAct
const CreationSlice = slice()
  .withState(TicketCreation)
  .withState(TicketOperations)
  .withProjection(TicketProjection)  // embed projection (events must be subset of slice events)
  .on("TicketOpened")
    .do(async (event, _stream, app) => {
      // reactingTo is auto-injected — no need to pass event explicitly
      await app.do("AssignTicket", target, payload);
      const snapshot = await app.load(TicketCreation, event.stream);
      const events = await app.query_array({ stream: event.stream });
    })
    .to((event) => ({ target: event.stream }))
  .build();
```

- `slice()` - Creates a builder
- `.withState(state)` - Register a partial state (include all states whose actions handlers need)
- `.withProjection(proj)` - Embed a built `Projection` within the slice. The projection's events must be a subset of the slice's state events (enforced at compile time). Projection handlers keep their `(event, stream)` signature — no app interface.
- `.on(eventName)` - React to an event from the slice's states (string, not record)
- `.do(handler)` - Handler receives `(event, stream, app)` where `app` is a scoped `IAct` proxy (do, load, query, query_array). When `app.do()` is called without `reactingTo`, the triggering event is auto-injected to maintain the correlation chain. Pass an explicit `reactingTo` to override.
- `.to(resolver)` - Set the target stream resolver
- `.build()` - Returns a `Slice` with `_tag: "Slice"`

### Act Orchestrator

The main orchestrator wires together states, slices, projections, and reactions using separate typed methods:

```typescript
const app = act()
  .withState(Counter)              // State
  .withSlice(CreationSlice)        // Slice (may embed projections via .withProjection())
  .withProjection(TicketProjection) // Standalone Projection (for cross-slice events)
  .on("SomeEvent")                 // Inline reaction
    .do(handler)
    .to(resolver)
  .build();

// Execute actions
await app.do("increment", { stream: "counter1", actor: { id: "1", name: "User" }}, { by: 5 });

// Load current state
const snapshot = await app.load(Counter, "counter1");

// Process reactions (event-driven workflows)
await app.drain({ streamLimit: 100, eventLimit: 1000 });

// Debounced correlate→drain for production (non-blocking, emits "settled" when done)
app.settle();
```

### Time-Travel Queries

`load()` accepts an optional `asOf` parameter (`AsOf = Pick<Query, "before" | "created_before" | "created_after" | "limit">`) to load state at a specific point in time:

```typescript
// Load state as-of a specific event ID (exclusive)
await app.load(Counter, "counter-1", undefined, { before: 5000 });

// Load state as-of a specific timestamp (exclusive)
await app.load(Counter, "counter-1", undefined, { created_before: new Date("2025-12-31") });

// Replay with a callback to inspect each intermediate state
await app.load(Counter, "counter-1", (snap) => {
  console.log(snap.event?.id, snap.state);
}, { before: 5000 });
```

When `asOf` is present, `load()` bypasses the cache (read and write) and replays from the beginning with snapshots — the query filters exclude any snapshot past the cutoff. This is read-only; `action()` always operates on current state.

### Close the Books

`close()` archives, tombstones, and truncates streams from the operational store. This is the event sourcing equivalent of "closing the books" in accounting — summarize the period, archive the detail, and optionally restart with a fresh opening balance.

```typescript
const result = await app.close([
  {
    stream: "order-123",
    restart: true,  // restart with snapshot of final state
    archive: async () => {
      const events = await app.query_array({ stream: "order-123", stream_exact: true });
      await s3.putObject({ Key: "order-123.json", Body: JSON.stringify(events) });
    },
  },
  { stream: "order-456" },  // tombstoned (permanently closed)
]);

// result: { truncated: Map<stream, {deleted, committed}>, skipped: string[] }
```

**Archive pattern for large streams** — the archive callback receives only the stream name. Use `app.query()` with a callback for streaming pagination, or `app.query_array()` for small streams:

```typescript
// Streaming: page through events without loading all into memory
archive: async (stream) => {
  let batch: any[] = [];
  let page = 0;
  await app.query({ stream, stream_exact: true, with_snaps: true }, (event) => {
    batch.push(event);
    if (batch.length >= 1000) {
      // flush batch to cold storage
      await s3.putObject({ Key: `${stream}/page-${page++}.json`, Body: JSON.stringify(batch) });
      batch = [];
    }
  });
  if (batch.length) await s3.putObject({ Key: `${stream}/page-${page}.json`, Body: JSON.stringify(batch) });
}
```

**Execution flow (each step gates the next):**

1. **Correlate** — discover pending reaction targets
2. **Safety check** — skip streams with pending reactions (skipped entirely when no reactive events)
3. **Guard** — commit `__tombstone__` with `expectedVersion` per stream (blocks concurrent writes via `action()` guard). Streams that fail with `ConcurrencyError` are moved to `skipped`.
4. **Archive** — user callback per stream. Streams are guarded — no concurrent writes possible. If any throws, streams remain guarded but not truncated.
5. **Truncate + seed** — atomic per-store transaction: delete all events, insert `__snapshot__` (restart) or `__tombstone__` (close) as the sole event.
6. **Cache** — invalidate (tombstoned) or warm (restarted)
7. **Emit "closed"** — lifecycle event with `CloseResult`

**Safety guarantees:**
- Guard failure (concurrent write) → stream moved to `skipped`, untouched
- Archive failure → streams are guarded (writes blocked), not truncated. Retryable.
- Truncate + seed is atomic — if it fails, the guard tombstone remains, stream is safe
- Idempotent — closing already-tombstoned streams is a no-op

**Tombstone events** (`__tombstone__`): A tombstone marks a stream as permanently closed. `action()` throws `StreamClosedError` when the last event on a stream is a tombstone. The only way to reopen is via `close()` with `restart: true`.

**`truncate()` Store primitive** — atomically deletes all events, removes stream metadata, and inserts a seed event (`__snapshot__` or `__tombstone__`) in a single transaction. Returns `{ deleted: number, committed: Committed[] }` so callers can use the real store-assigned event IDs (e.g., for cache warming).

**Meta traceability** — all events in a close operation share a correlation UUID. Guard tombstones start the chain; truncate seeds reference the guard via `causation.event`.

```typescript
app.on("closed", (result: CloseResult) => {
  console.log(`Closed ${result.truncated.size}, skipped ${result.skipped.length}`);
});
```

### Event Sourcing Model

- **Append-only event log** - Complete audit trail, immutable history
- **State reconstruction** - Replay events to rebuild state at any point
- **Snapshots** - Optimization for long event streams
- **Optimistic concurrency** - Version-based conflict detection
- **Stream isolation** - Each state instance has its own event stream

### Port/Adapter Pattern

The framework uses a port/adapter pattern for persistence and caching via singleton accessors:

#### Store

- **InMemoryStore** - Default, useful for tests and prototyping
- **PostgresStore** (`@rotorsoft/act-pg`) - Production-ready with atomic claim, snapshots, and connection pooling
- **SqliteStore** (`@rotorsoft/act-sqlite`) - libSQL-backed adapter for embedded or single-node deployments; serializes writes at the DB level, equivalent to PG's `FOR UPDATE SKIP LOCKED` for single-server

Switch stores using the `store()` singleton:

```typescript
import { store } from "@rotorsoft/act";
import { PostgresStore } from "@rotorsoft/act-pg";

store(new PostgresStore({
  host: "localhost",
  port: 5432,
  database: "mydb",
  user: "user",
  password: "pass",
  schema: "public",
  table: "events"
}));
```

#### Cache

Cache is always-on with `InMemoryCache` (LRU, maxSize 1000) as the default. It stores the latest state checkpoint per stream, avoiding full event replay on every `load()`. Actions update the cache after each successful commit; concurrency errors invalidate stale entries.

```typescript
import { cache } from "@rotorsoft/act";

// Cache is active by default — load() and action() use it transparently
// Replace with a custom adapter (e.g., Redis) for distributed caching:
cache(new RedisCache({ url: "redis://localhost:6379" }));
```

The `Cache` interface is async for forward-compatibility with external caches:

```typescript
interface Cache extends Disposable {
  get<TState>(stream: string): Promise<CacheEntry<TState> | undefined>;
  set<TState>(stream: string, entry: CacheEntry<TState>): Promise<void>;
  invalidate(stream: string): Promise<void>;
  clear(): Promise<void>;
}
```

**Cache vs Snapshots:** Both are checkpoints at different layers. Cache (in-memory) is checked first on every `load()`, eliminating store round-trips on warm hits. Snapshots (in-store as `__snapshot__` events) are the fallback on cache miss (cold start, LRU eviction, process restart). On cache hit, snapshot events are skipped (`with_snaps: false`).

## Key Architectural Patterns

### Dual-Frontier Drain Strategy

The framework's event processing uses two frontiers:

- **Lagging frontier** - New or behind streams catch up quickly
- **Leading frontier** - Active streams process continuously
- **Fast-forwarding** - Prevents slow streams from blocking fast ones
- **Parallel processing** - Multiple streams processed concurrently with atomic claiming

This enables high-throughput event processing with eventual consistency guarantees.

### Event Correlation

Dynamic stream discovery through correlation metadata:

- Each action/event includes `correlation` (request ID) and `causation` (what triggered it)
- **Auto-injected `reactingTo`**: Inside reaction handlers, `app.do()` automatically uses the triggering event as `reactingTo` when omitted. This maintains the correlation chain without developer effort. Explicitly passing `reactingTo` overrides the default.
- Reactions can discover new streams to process by querying uncommitted events
- `app.correlate()` - Manual correlation; returns `{ subscribed, last_id }` where `subscribed` is the count of newly registered streams
- `app.settle()` - Debounced, non-blocking correlate→drain loop; emits `"settled"` when done. Stops when `subscribed === 0` (no new streams discovered)
- `app.start_correlations()` - Periodic background correlation

**Important:** `correlate()` must be called before `drain()` to register reaction target streams with the store via `subscribe()`. Without correlation, `drain()` has no streams to process. In tests: `await app.correlate(); await app.drain();`. In production: use `app.settle()` for debounced correlate→drain with a `"settled"` lifecycle event, or `app.start_correlations()` for background discovery.

**Correlation optimization:** At build time, resolvers are classified as static (known target) or dynamic (function). Static targets are subscribed once at init; correlate only scans for dynamic resolvers. An in-memory checkpoint advances `after` across calls, initialized from `max(at)` on the streams table at cold start. When no dynamic resolvers exist, correlate is skipped entirely in settle.

**Drain optimization:** At build time, `_reactive_events` collects event names with at least one registered reaction. In `do()`, the `_needs_drain` flag is set when a committed event matches. `drain()` returns immediately when the flag is false — saving 3 DB round-trips (claim, query, ack) per non-reactive cycle. The flag clears only when drain completes with nothing acked, blocked, or errored. Cold start sets the flag in `_init_correlation()` to process historical events. Default `maxPasses` is 1 (single correlate→drain pass per settle).

### Idempotency

Act uses **optimistic concurrency** (`expectedVersion`) for conflict detection at the event store level. Request-level idempotency (safe client retries) is an **API middleware concern**, not a framework concern.

Framework-level deduplication (e.g., checking event correlation metadata before commit) was evaluated and rejected due to:
- **TOCTOU races** — concurrent retries both pass the check before either commits
- **Semantic overloading** — correlation is a trace ID that propagates through reactions; reusing it as an idempotency key conflates two concerns
- **Cross-action dedup** — different actions with the same key silently swallow the second
- **State drift** — dedup returns current state, not state-as-of-original-commit
- **No TTL** — stale keys in the immutable event log block reuse forever

**Recommended pattern:** tRPC middleware with a dedicated cache (in-memory Map with TTL, or Redis for distributed deployments):

```typescript
const idempotencyKeys = new Map<string, { response: unknown; expiresAt: number }>();

const idempotent = t.middleware(async ({ ctx, next, rawInput }) => {
  const key = (rawInput as any)?.idempotencyKey;
  if (key) {
    const cached = idempotencyKeys.get(key);
    if (cached && cached.expiresAt > Date.now()) return { ok: true, data: cached.response };
  }
  const result = await next({ ctx });
  if (key && result.ok) {
    idempotencyKeys.set(key, { response: result.data, expiresAt: Date.now() + 86_400_000 });
  }
  return result;
});
```

This cleanly separates "has this request been processed?" (API concern) from "what events exist?" (event store concern).

### Invariants

Business rules enforced before actions execute:

```typescript
import { type Invariant } from "@rotorsoft/act";

const mustBeOpen: Invariant<{ status: string }> = {
  description: "Ticket must be open",
  valid: (state) => state.status === "open",
};

const mustBeAssigned: Invariant<{ assignedTo: string }, { id: string; name: string }> = {
  description: "Must be assigned to you",
  valid: (state, actor) => state.assignedTo === actor?.id,
};

.on({ closeTicket: z.object({ reason: z.string() }) })
  .given([mustBeOpen, mustBeAssigned])
  .emit("TicketClosed")  // passthrough — action payload { reason } becomes event data
```

### Snapshotting Strategy

Control when snapshots are taken for cold-start resilience (on cache miss, process restart, or LRU eviction, snapshots limit how much of the event stream must be replayed):

```typescript
.snap((snap) => snap.patches >= 10)  // Snapshot every 10 events
```

Snap writes are fire-and-forget — the cache is updated synchronously within `action()`, so subsequent reads see the post-commit state immediately without waiting for the store write.

### Projection Rebuild

Projections are derived data — disposable by design. When a projection's logic changes (new fields, bug fix, different aggregation), reset its watermark with `app.reset(...)` and let the existing drain machinery replay all events from the beginning:

```typescript
// Reset the projection stream watermark to -1 and arm the drain flag
await app.reset(["my-projection"]);

// Trigger settle — it loops correlate→drain until caught up, then emits "settled"
app.settle({ eventLimit: 1000 });
```

**Always call `app.reset(...)` — never `store().reset(...)` directly.** Both reset the watermark, but only `app.reset(...)` raises the orchestrator's internal `_needs_drain` flag. A settled app (no recent commits) has `_needs_drain === false`, so `drain()`/`settle()` short-circuit and skip the replay if you reset at the store level. `app.reset(...)` wraps `store().reset(...)` and arms the flag in one call.

**`settle()` drains to completion by default.** It loops correlate→drain until a pass produces no progress (no new subscriptions, no acks, no blocks). `maxPasses` defaults to `Infinity` and only acts as a kill-switch for runaway reaction loops — for ordinary catch-up, the natural exit handles paginated streams of any length. A single `app.settle()` after `app.reset(...)` is enough.

**Typical production workflow:**
1. Deploy updated projection code
2. Clear projected data (truncate read-model table, flush cache)
3. Call `await app.reset(["projection-target"])` to reset watermarks and arm drain
4. Call `app.settle()` once — it drives the catch-up to completion

### Event Schema Evolution

Events are immutable — their schemas must evolve without breaking historical data. Act uses **versioned event names** instead of upcasting, preserving full type safety through Zod schemas.

**Non-breaking changes** (adding optional fields with defaults) work naturally — the Zod schema evolves and the patch handler provides defaults:

```typescript
// Before: TicketOpened had only title
// After: added priority with a default
.emits({
  TicketOpened: z.object({
    title: z.string(),
    priority: z.enum(["low", "medium", "high"]).default("medium"),
  })
})
.patch({
  TicketOpened: ({ data }, state) => ({
    ...state,
    title: data.title,
    priority: data.priority ?? "medium",  // handles old events
  })
})
```

**Breaking changes** (renaming fields, changing types, removing fields) require a new versioned event name. Old event types remain in the schema so historical events stay type-safe:

```typescript
.emits({
  // v1: original schema (keep for historical events)
  TicketOpened: z.object({ title: z.string(), type: z.string() }),
  // v2: breaking change — renamed "type" to "category", added priority
  TicketOpened_v2: z.object({
    title: z.string(),
    priority: z.enum(["low", "medium", "high"]),
    category: z.string(),
  }),
})
.patch({
  TicketOpened: ({ data }, state) => ({
    ...state,
    title: data.title,
    category: data.type,           // map old field to new state shape
    priority: "medium",            // default for v1 events
  }),
  TicketOpened_v2: ({ data }, state) => ({
    ...state,
    title: data.title,
    priority: data.priority,
    category: data.category,
  }),
})
// New actions emit v2
.on({ openTicket: z.object({ title: z.string(), priority: z.enum(["low", "medium", "high"]), category: z.string() }) })
  .emit((action) => ["TicketOpened_v2", { title: action.title, priority: action.priority, category: action.category }])
```

**Why not upcasting?** Upcasting (transforming old event data to the current schema at read time) is common in other frameworks but relies on loosely-typed transforms (`unknown → unknown`). Act's Zod schemas are the source of truth — versioned event names keep every schema version explicit and type-safe. Reducers, projections, and queries all benefit from full TypeScript inference with no type erasure.

## Code Organization

### Core Library (`libs/act/src`)

- **`state-builder.ts`** - State builder API and types
- **`act-builder.ts`** - Act orchestrator builder API
- **`slice-builder.ts`** - Slice builder for vertical slice architecture
- **`projection-builder.ts`** - Projection builder for read-model updaters
- **`merge.ts`** - Shared merge utilities for schema/state composition
- **`act.ts`** - Act orchestrator runtime
- **`ports.ts`** - Singleton port/adapter pattern for `store()` and `cache()`
- **`adapters/`** - Built-in adapters (InMemoryStore, InMemoryCache)
- **`event-sourcing.ts`** - Core `load()` and `action()` functions with cache integration
- **`logger.ts`** - Pino-based logging
- **`errors.ts`** - Framework error types
- **`types.ts`** - Core type definitions (Message, Committed, Snapshot, etc.)

### PostgreSQL Adapter (`libs/act-pg/src`)

- **`postgres-store.ts`** - PostgreSQL implementation of Store interface
- **`types.ts`** - PostgreSQL-specific types and schemas

### SQLite Adapter (`libs/act-sqlite/src`)

- **`SqliteStore.ts`** - libSQL-backed implementation of the Store interface (single-node, embedded)

### Examples

Each example demonstrates different framework capabilities:

- **Calculator** - Single state machine, reactions, projection rebuild demo (`pnpm -F calculator dev:rebuild`), close-the-books demo (`pnpm -F calculator dev:close`)
- **WolfDesk** - Multiple aggregates, projections, complex reactions, invariants
- **Server/Client** - Integration with external APIs (tRPC), web application pattern

## Development Workflow

### Making Changes

1. The codebase uses strict TypeScript - all code must type check
2. Pre-commit hooks run linting and formatting automatically
3. Pre-push hooks run the full test suite
4. Use Zod schemas for all runtime validation
5. Events are immutable - never modify event data structures
6. Keep state machines focused and cohesive - separate concerns into multiple states

### Adding New Features to Core

1. Add types to `libs/act/src/types.ts` if needed
2. Implement in appropriate module (`state.ts`, `act.ts`, etc.)
3. Add tests in `__tests__` directory
4. Update example applications to demonstrate usage
5. Ensure InMemoryStore, PostgresStore, and SqliteStore all support the feature

### Adding a New Library to `/libs`

When introducing a brand-new package (e.g., `@rotorsoft/act-foo`), seed a baseline tag **before** the first PR merges to `master` — otherwise `semantic-release` defaults the very first release to `1.0.0` (regardless of the version in `package.json`).

```bash
# After creating the package on a feature branch and BEFORE the first merge:
git tag @rotorsoft/act-foo-v0.0.0 <commit-on-master-or-pre-feature>
git push origin @rotorsoft/act-foo-v0.0.0
```

Also remember to:
- Add the package name to the `cd` matrix in `.github/workflows/ci-cd.yml`
- Copy `.releaserc.json` from a sibling lib and update `tagFormat`
- Wire it into the root `README.md`, `CLAUDE.md`, `docs/sidebars.ts`, `docs/typedoc.json`, `docs/tsconfig.json`, and any relevant skills under `.claude/skills/`

### Documentation Guidelines

- **README** — shows current patterns and strategies only, not historical benchmarks
- **PERFORMANCE.md** — tracks performance evolution with before/after benchmark data per optimization
- When adding a performance optimization, add benchmark results to `PERFORMANCE.md` and link from README
- READMEs should briefly mention the pattern/strategy and reference `PERFORMANCE.md` for details

### Testing Patterns

- Tests use the InMemoryStore and InMemoryCache by default (fast, isolated)
- Use `store().seed()` in `beforeEach` to reset state between tests
- Use `dispose()()` in `afterAll` to clean up all adapters (store, cache, and any custom disposers)
- Create helper functions for common action sequences
- Verify both events and final state in assertions
- Test invariant violations with `expect(async () => ...).rejects.toThrow()`

### Commit Message Format

The project uses conventional commits with a custom validation hook:

```bash
<type>(<scope>): <subject>

# Types: feat, fix, docs, style, refactor, test, chore
# Scope: package name (act, act-pg, calculator, wolfdesk, etc.)
# Subject: imperative mood, lowercase, no period
```

## Important Constraints

- **Node >= 22.18.0** required
- **pnpm >= 10.32.1** required (not npm or yarn)
- **TypeScript strict mode** enabled
- **Zod schemas required** for all actions, events, and state
- **Immutable events** - never mutate event data
- **Stream names are strings** - can be any string identifier
- **Actor context required** - all actions need actor info (id + name)

## Store Interface Contract

If implementing a custom store, you must implement:

```typescript
interface Store extends Disposable {
  seed(): Promise<void>;                          // Initialize/reset
  drop(): Promise<void>;                          // Destroy
  commit(stream, msgs, meta, expectedVersion?): Promise<Committed[]>;  // Append events
  query(callback, filter?): Promise<number>;      // Read events
  claim(lagging, leading, by, millis): Promise<Lease[]>;  // Atomic discover + lock streams
  subscribe(streams): Promise<{ subscribed: number; watermark: number }>;  // Register streams + max watermark
  ack(leases): Promise<Lease[]>;                  // Release successful leases
  block(leases): Promise<(Lease & { error })[]>;  // Block failed streams
  reset(streams): Promise<number>;                // Reset watermarks for projection rebuild
  truncate(targets: {stream, snapshot?, meta?}[]): Promise<{deleted, committed}>;  // Atomic truncate + seed
  query_streams(callback, query?): Promise<{maxEventId, count}>;  // Read-only introspection of subscription positions
  dispose(): Promise<void>;                       // Cleanup resources
}
```

`claim()` atomically discovers and locks streams for processing using PostgreSQL's `FOR UPDATE SKIP LOCKED` pattern — competing consumers never block each other, and locked rows are silently skipped. This eliminates the race between discovery and locking that existed with the previous poll/lease two-step. `subscribe()` registers new streams for reaction processing (upserts into the streams table) and returns the count of newly registered streams. Version-based optimistic concurrency must be implemented correctly.

## Cache Interface Contract

If implementing a custom cache (e.g., Redis for distributed deployments), you must implement:

```typescript
interface Cache extends Disposable {
  get<TState>(stream: string): Promise<CacheEntry<TState> | undefined>;  // Lookup
  set<TState>(stream: string, entry: CacheEntry<TState>): Promise<void>; // Store checkpoint
  invalidate(stream: string): Promise<void>;                             // Remove entry
  clear(): Promise<void>;                                                // Remove all entries
  dispose(): Promise<void>;                                              // Cleanup resources
}

interface CacheEntry<TState> {
  readonly state: TState;      // Latest state
  readonly version: number;    // Stream version
  readonly event_id: number;   // Last processed event ID
  readonly patches: number;    // Events since last snapshot
  readonly snaps: number;      // Total snapshots taken
}
```

The default `InMemoryCache` is an LRU cache with configurable `maxSize` (default 1000).

## Troubleshooting

### Common Issues

- **ConcurrencyError** - Another process modified the stream. Retry or reload state.
- **InvariantError** - Business rule violated. Check invariant conditions.
- **ValidationError** - Action/event schema validation failed. Check payload structure.
- **StreamClosedError** - Stream has a tombstone event. Use `app.close()` with `restart` to reopen.
- **"No events committed"** - Action didn't emit any events. Check `.emit()` implementation.

### Debugging

- Set `LOG_LEVEL=debug` or `LOG_LEVEL=trace` for verbose logging
- Use `app.on("committed", ...)` to observe all state changes
- Use `app.on("settled", ...)` to react when `settle()` completes all correlate/drain passes
- Use `app.on("blocked", ...)` to catch reaction processing failures
- Use `app.on("closed", ...)` to observe close-the-books operations
- Use `app.load(State, stream, undefined, { before: eventId })` for time-travel queries (see `AsOf` type)
- Query events directly: `await app.query_array({ stream: "mystream" })`
- Query with exact stream match: `await app.query_array({ stream: "mystream", stream_exact: true })` — by default, `stream` uses regex matching; `stream_exact: true` uses exact string equality. `load()` always uses exact match internally.

### Performance

- **Cache is always-on** — warm reads skip the store entirely, delivering consistent throughput regardless of stream length. No configuration needed.
- **Use snapshots for cold-start resilience** — on process restart or LRU eviction, snaps limit how much of the event stream must be replayed. Set `.snap((s) => s.patches >= 50)` for most use cases.
- **Cache invalidation is automatic** — concurrency errors invalidate the stale cache entry, forcing a fresh load on the next access.
- Tune `streamLimit` and `eventLimit` in drain options
- Monitor claim times - if too short, streams thrash; if too long, processing slows
- PostgreSQL: Add indexes on stream, version, and created columns
- Consider partitioning the events table for very large deployments
