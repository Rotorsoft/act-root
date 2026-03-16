# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Act is an event sourcing + CQRS + Actor Model framework for TypeScript. The core philosophy: any system distills into **Actions → {State} ← Reactions**. This monorepo contains the core framework libraries and example applications demonstrating various complexity levels.

## Project Structure

This is a pnpm monorepo with two main sections:

- **`/libs`** - Core framework libraries
  - `@rotorsoft/act` - Core event sourcing framework
  - `@rotorsoft/act-pg` - PostgreSQL adapter for production
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

Projections are read-model updaters that react to events and update external state (databases, caches, etc.). Unlike slices, projections have no states and handlers do not receive a `Dispatcher`.

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
- `.to(resolver)` / `.void()` - Override the default resolver per handler
- `.build()` - Returns a `Projection` with `_tag: "Projection"`

### Slice Builder

Slices group partial states with scoped reactions into self-contained feature modules (vertical slice architecture). Handlers receive a typed `Dispatcher` for cross-state action dispatch.

```typescript
import { slice } from "@rotorsoft/act";

// Handlers receive (event, stream, app) — app is a typed Dispatcher
const CreationSlice = slice()
  .withState(TicketCreation)
  .withState(TicketOperations)
  .withProjection(TicketProjection)  // embed projection (events must be subset of slice events)
  .on("TicketOpened")
    .do(async (event, _stream, app) => {
      await app.do("AssignTicket", target, payload, event);
    })
    .void()
  .build();
```

- `slice()` - Creates a builder
- `.withState(state)` - Register a partial state (include all states whose actions handlers need)
- `.withProjection(proj)` - Embed a built `Projection` within the slice. The projection's events must be a subset of the slice's state events (enforced at compile time). Projection handlers keep their `(event, stream)` signature — no Dispatcher.
- `.on(eventName)` - React to an event from the slice's states (string, not record)
- `.do(handler)` - Handler receives `(event, stream, app)` where `app` is a `Dispatcher`
- `.to(resolver)` / `.void()` - Set the target stream resolver
- `.build()` - Returns a `Slice` with `_tag: "Slice"`

**Important:** `.void()` reactions are **never processed by `drain()`** — the void resolver returns `undefined`, so drain filters them out. Use `.to(resolver)` for any reaction that must be discovered and executed during drain. Use `.void()` only for inline side effects that don't need drain processing.

### Act Orchestrator

The main orchestrator wires together states, slices, projections, and reactions using separate typed methods:

```typescript
const app = act()
  .withState(Counter)              // State
  .withSlice(CreationSlice)        // Slice (may embed projections via .withProjection())
  .withProjection(TicketProjection) // Standalone Projection (for cross-slice events)
  .on("SomeEvent")                 // Inline reaction
    .do(handler)
    .to(resolver)  // or .void() for side effects only
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
- **PostgresStore** - Production-ready with atomic claim, snapshots, and connection pooling

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
- Reactions can discover new streams to process by querying uncommitted events
- `app.correlate()` - Manual correlation; returns `{ subscribed, last_id }` where `subscribed` is the count of newly registered streams
- `app.settle()` - Debounced, non-blocking correlate→drain loop; emits `"settled"` when done. Stops when `subscribed === 0` (no new streams discovered)
- `app.start_correlations()` - Periodic background correlation

**Important:** `correlate()` must be called before `drain()` to register reaction target streams with the store via `subscribe()`. Without correlation, `drain()` has no streams to process. In tests: `await app.correlate(); await app.drain();`. In production: use `app.settle()` for debounced correlate→drain with a `"settled"` lifecycle event, or `app.start_correlations()` for background discovery.

**Correlation optimization:** At build time, resolvers are classified as static (known target) or dynamic (function). Static targets are subscribed once at init; correlate only scans for dynamic resolvers. An in-memory checkpoint advances `after` across calls, initialized from `max(at)` on the streams table at cold start. When no dynamic resolvers exist, correlate is skipped entirely in settle.

**Drain optimization:** At build time, `_reactive_events` collects event names with at least one registered reaction. In `do()`, the `_needs_drain` flag is set when a committed event matches. `drain()` returns immediately when the flag is false — saving 3 DB round-trips (claim, query, ack) per non-reactive cycle. The flag clears only when drain completes with nothing acked, blocked, or errored. Cold start sets the flag in `_init_correlation()` to process historical events. Default `maxPasses` is 1 (single correlate→drain pass per settle).

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

### Examples

Each example demonstrates different framework capabilities:

- **Calculator** - Single state machine, no reactions, simple event flow
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
5. Ensure both InMemoryStore and PostgresStore support the feature

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
- **"No events committed"** - Action didn't emit any events. Check `.emit()` implementation.

### Debugging

- Set `LOG_LEVEL=debug` or `LOG_LEVEL=trace` for verbose logging
- Use `app.on("committed", ...)` to observe all state changes
- Use `app.on("settled", ...)` to react when `settle()` completes all correlate/drain passes
- Use `app.on("blocked", ...)` to catch reaction processing failures
- Query events directly: `await app.query_array({ stream: "mystream" })`

### Performance

- **Cache is always-on** — warm reads skip the store entirely, delivering consistent throughput regardless of stream length. No configuration needed.
- **Use snapshots for cold-start resilience** — on process restart or LRU eviction, snaps limit how much of the event stream must be replayed. Set `.snap((s) => s.patches >= 50)` for most use cases.
- **Cache invalidation is automatic** — concurrency errors invalidate the stale cache entry, forcing a fresh load on the next access.
- Tune `streamLimit` and `eventLimit` in drain options
- Monitor claim times - if too short, streams thrash; if too long, processing slows
- PostgreSQL: Add indexes on stream, version, and created columns
- Consider partitioning the events table for very large deployments
