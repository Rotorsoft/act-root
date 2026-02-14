# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Act is an event sourcing + CQRS + Actor Model framework for TypeScript. The core philosophy: any system distills into **Actions → {State} ← Reactions**. This monorepo contains the core framework libraries and example applications demonstrating various complexity levels.

## Project Structure

This is a pnpm monorepo with two main sections:

- **`/libs`** - Core framework libraries
  - `@rotorsoft/act` - Core event sourcing framework
  - `@rotorsoft/act-pg` - PostgreSQL adapter for production

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

States are built using a fluent API:

```typescript
const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({
    Incremented: z.object({ amount: z.number() })
  })
  .patch({
    Incremented: (event, state) => ({ count: state.count + event.data.amount })
  })
  .on({ increment: z.object({ by: z.number() }) })
    .emit((action, state) => ["Incremented", { amount: action.by }])
  .build();
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
  .with(TicketCreation)
  .with(TicketOperations)
  .on("TicketOpened")
    .do(async (event, _stream, app) => {
      await app.do("AssignTicket", target, payload, event);
    })
    .void()
  .build();
```

- `slice()` - Creates a builder
- `.with(state)` - Register a partial state (include all states whose actions handlers need)
- `.on(eventName)` - React to an event from the slice's states (string, not record)
- `.do(handler)` - Handler receives `(event, stream, app)` where `app` is a `Dispatcher`
- `.to(resolver)` / `.void()` - Set the target stream resolver
- `.build()` - Returns a `Slice` with `_tag: "Slice"`

**Important:** `.void()` reactions are **never processed by `drain()`** — the void resolver returns `undefined`, so drain filters them out. Use `.to(resolver)` for any reaction that must be discovered and executed during drain. Use `.void()` only for inline side effects that don't need drain processing.

### Act Orchestrator

The main orchestrator wires together states, slices, projections, and reactions. The `.with()` method accepts `State`, `Slice`, or `Projection`:

```typescript
const app = act()
  .with(Counter)           // State
  .with(CreationSlice)     // Slice
  .with(TicketProjection)  // Projection
  .on("SomeEvent")         // Inline reaction
    .do(handler)
    .to(resolver)  // or .void() for side effects only
  .build();

// Execute actions
await app.do("increment", { stream: "counter1", actor: { id: "1", name: "User" }}, { by: 5 });

// Load current state
const snapshot = await app.load(Counter, "counter1");

// Process reactions (event-driven workflows)
await app.drain({ streamLimit: 100, eventLimit: 1000 });
```

### Event Sourcing Model

- **Append-only event log** - Complete audit trail, immutable history
- **State reconstruction** - Replay events to rebuild state at any point
- **Snapshots** - Optimization for long event streams
- **Optimistic concurrency** - Version-based conflict detection
- **Stream isolation** - Each state instance has its own event stream

### Store Abstraction

The framework uses a port/adapter pattern for persistence:

- **InMemoryStore** - Default, useful for tests and prototyping
- **PostgresStore** - Production-ready with leasing, snapshots, and connection pooling

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

## Key Architectural Patterns

### Dual-Frontier Drain Strategy

The framework's event processing uses two frontiers:

- **Lagging frontier** - New or behind streams catch up quickly
- **Leading frontier** - Active streams process continuously
- **Fast-forwarding** - Prevents slow streams from blocking fast ones
- **Parallel processing** - Multiple streams processed concurrently with leasing

This enables high-throughput event processing with eventual consistency guarantees.

### Event Correlation

Dynamic stream discovery through correlation metadata:

- Each action/event includes `correlation` (request ID) and `causation` (what triggered it)
- Reactions can discover new streams to process by querying uncommitted events
- `app.correlate()` - Manual correlation (must be called before `drain()` to discover target streams)
- `app.start_correlations()` - Periodic background correlation

**Important:** `correlate()` must be called before `drain()` to register reaction target streams with the store. Without correlation, `drain()` has no streams to process. In tests: `await app.correlate(); await app.drain();`. In production: use `app.on("committed", () => { app.correlate().then(() => app.drain()).catch(console.error); })` or `app.start_correlations()` for background discovery.

### Invariants

Business rules enforced before actions execute:

```typescript
.on({ closeTicket: z.object({ reason: z.string() }) })
  .given([
    (_, snap) => snap.state.status === "open" || "Ticket must be open",
    (target, snap) => snap.state.assignedTo === target.actor.id || "Must be assigned to you"
  ])
  .emit((action, snap) => ["TicketClosed", { reason: action.reason }])
```

### Snapshotting Strategy

Control when snapshots are taken:

```typescript
.snap((snap) => snap.patchCount >= 10)  // Snapshot every 10 events
```

## Code Organization

### Core Library (`libs/act/src`)

- **`state-builder.ts`** - State builder API and types
- **`act-builder.ts`** - Act orchestrator builder API
- **`slice-builder.ts`** - Slice builder for vertical slice architecture
- **`projection-builder.ts`** - Projection builder for read-model updaters
- **`merge.ts`** - Shared merge utilities for schema/state composition
- **`act.ts`** - Act orchestrator runtime
- **`store/`** - Store interface and InMemoryStore implementation
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

### Testing Patterns

- Tests use the InMemoryStore by default (fast, isolated)
- Use `store().seed()` to reset state between tests
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
- **pnpm >= 10.27.0** required (not npm or yarn)
- **TypeScript strict mode** enabled
- **Zod schemas required** for all actions, events, and state
- **Immutable events** - never mutate event data
- **Stream names are strings** - can be any string identifier
- **Actor context required** - all actions need actor info (id + name)

## Store Interface Contract

If implementing a custom store, you must implement:

```typescript
interface Store {
  seed(): Promise<void>                          // Initialize/reset
  drop(): Promise<void>                          // Destroy
  commit(stream, messages, meta, version?)       // Append events
  query(callback, filter?)                       // Read events
  poll(lagging, leading)                         // Find streams to process
  lease(leases, millis)                          // Acquire processing locks
  ack(leases)                                    // Release successful leases
  block(leases)                                  // Block failed streams
  dispose(): void                                // Cleanup resources
}
```

Both stream leasing and version-based optimistic concurrency must be implemented correctly.

## Troubleshooting

### Common Issues

- **ConcurrencyError** - Another process modified the stream. Retry or reload state.
- **InvariantError** - Business rule violated. Check invariant conditions.
- **ValidationError** - Action/event schema validation failed. Check payload structure.
- **"No events committed"** - Action didn't emit any events. Check `.emit()` implementation.

### Debugging

- Set `LOG_LEVEL=debug` or `LOG_LEVEL=trace` for verbose logging
- Use `app.on("committed", ...)` to observe all state changes
- Use `app.on("blocked", ...)` to catch reaction processing failures
- Query events directly: `await app.query_array({ stream: "mystream" })`

### Performance

- Use snapshots for states with long event histories
- Tune `streamLimit` and `eventLimit` in drain options
- Monitor lease times - if too short, streams thrash; if too long, processing slows
- PostgreSQL: Add indexes on stream, version, and created columns
- Consider partitioning the events table for very large deployments
