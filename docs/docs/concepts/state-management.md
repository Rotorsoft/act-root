---
id: state-management
title: State Management
---

# State Management

Act models domain logic as **state machines** — each entity is a state definition with actions that emit events, and events that patch state.

## State Builder

States are built using a fluent API:

```typescript
import { state } from "@rotorsoft/act";
import { z } from "zod";

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ amount: z.number() }) })
  .patch({
    Incremented: ({ data }, state) => ({ count: state.count + data.amount }),
  })
  .on({ increment: z.object({ by: z.number() }) })
    .emit((action) => ["Incremented", { amount: action.by }])
  .build();
```

### Builder Chain

`state({})` → `.init()` → `.emits({})` → optional `.patch({})` → `.on({})` → optional `.given([])` → `.emit()` → `.build()`

- **`.emits()`** declares events with passthrough reducers by default (`({ data }) => data`)
- **`.patch()`** overrides only events that need custom reducers
- **`.emit("EventName")`** passes the action payload through directly as event data
- **`.emit((action, snapshot, target) => [name, data])`** for computed event data. The handler receives:
  - `action` — the validated action payload
  - `snapshot` — the current state snapshot (`{ state, version, event, ... }`)
  - `target` — the dispatch target (`{ stream, actor }`), useful when the actor or stream id needs to flow into the event

### Partial States

Multiple states sharing the same name merge automatically when composed in slices or the act orchestrator:

```typescript
const TicketCreation = state({ Ticket: z.object({ title: z.string() }) })
  .init(() => ({ title: "" }))
  .emits({ TicketOpened: z.object({ title: z.string() }) })
  .on({ OpenTicket: z.object({ title: z.string() }) })
    .emit("TicketOpened")
  .build();

const TicketOperations = state({ Ticket: z.object({ status: z.string() }) })
  .init(() => ({ status: "open" }))
  .emits({ TicketClosed: z.object({ reason: z.string() }) })
  .on({ CloseTicket: z.object({ reason: z.string() }) })
    .emit("TicketClosed")
  .build();

// These merge into a single "Ticket" state with both actions and events
```

**Patch merge priority:** When partials are merged and both declare the same event:
- One custom, one passthrough → keep the custom one (order doesn't matter)
- Same function reference → re-registration from another slice, allowed
- Two different custom patches → throw error at build time

This means a partial can redeclare an event in `.emits()` (to react to it via `.on()`) without overwriting the custom reducer from the partial that owns the event.

## Invariants

Business rules enforced before actions execute:

```typescript
import { type Invariant } from "@rotorsoft/act";

const mustBeOpen: Invariant<{ status: string }> = {
  description: "Ticket must be open",
  valid: (state) => state.status === "open",
};

.on({ CloseTicket: z.object({ reason: z.string() }) })
  .given([mustBeOpen])
  .emit("TicketClosed")
```

When an invariant fails, the framework throws an `InvariantError` with the description.

## Snapshots

For long-lived streams, configure snapshotting to avoid replaying the entire event history on cold starts:

```typescript
.snap((snap) => snap.patches >= 50)  // snapshot every 50 events
```

Snapshots are persisted as `__snapshot__` events in the store and used as a starting point when the cache is cold (process restart, LRU eviction).

## Cache

Cache is always-on with `InMemoryCache` (LRU, maxSize 1000) as the default. It stores the latest state checkpoint per stream:

- **On `load()`** — cache is checked first; only events after the cached position are replayed from the store
- **On `action()`** — cache is updated after each successful commit
- **On `ConcurrencyError`** — stale cache entries are invalidated automatically

Cache and snapshots are the same checkpoint pattern at different layers. Cache eliminates store round-trips on warm hits; snapshots limit replay on cache miss.

## Projections

Projections are read-model updaters that react to events:

```typescript
import { projection } from "@rotorsoft/act";

const TicketProjection = projection("tickets")
  .on({ TicketOpened })
    .do(async ({ stream, data }) => {
      await db.insert(tickets).values({ id: stream, ...data });
    })
  .build();
```

Projection handlers receive `(event, stream)` — no dispatcher, no state mutations.

## Slices

Slices group partial states with scoped reactions into vertical feature modules:

```typescript
import { slice } from "@rotorsoft/act";

const TicketSlice = slice()
  .withState(TicketCreation)
  .withState(TicketOperations)
  .withProjection(TicketProjection)
  .on("TicketOpened")
    .do(async (event, stream, app) => {
      // reactingTo is auto-injected — no need to pass `event` explicitly
      await app.do("AssignTicket", { stream: event.stream, actor }, payload);
    })
    .to((event) => ({ target: event.stream }))
  .build();
```

Slice handlers receive `(event, stream, app)` where `app` implements `IAct` (`do`, `load`, `query`, `query_array`).

### Auto-injected `reactingTo`

When a slice handler calls `app.do()` without an explicit fourth argument, the framework automatically threads the triggering event in as `reactingTo`, propagating the correlation chain (`correlation` and `causation.event`) through the new commit. Pass an explicit fourth argument only if you want to override that default — e.g., to attribute a side-effect commit to a different upstream event.

## Act Orchestrator

The orchestrator composes everything:

```typescript
const app = act()
  .withState(Counter)
  .withSlice(TicketSlice)
  .withProjection(AuditProjection)
  .build();

const snaps = await app.do("increment", { stream: "counter1", actor }, { by: 5 });
const snapshot = await app.load(Counter, "counter1");
```

### Snapshot shape

Both `app.do()` (returns one snapshot per emitted event) and `app.load()` (returns one snapshot for the latest replayed state) yield objects of this shape:

```typescript
type Snapshot<TState> = {
  state: TState;       // current state after this event
  version: number;     // 0-indexed stream version
  event?: Committed;   // the event that produced this state (undefined on init)
  patch?: Partial<TState>; // the diff applied by this event's reducer
  patches: number;     // events since last __snapshot__
  snaps: number;       // total __snapshot__ events seen on this stream
  cache_hit: boolean;  // true when load() served from cache without store I/O
  replayed: number;    // events processed past the cache point (0 on a warm hit)
};
```

`patches` and `snaps` drive the `.snap()` predicate; `cache_hit` and `replayed` show in the trace breadcrumbs and tell you whether the load round-tripped to the store.

## Utility Types

Extract inferred types from built State objects:

```typescript
import type { InferEvents, InferActions } from "@rotorsoft/act";

type Events = InferEvents<typeof Counter>;
type Actions = InferActions<typeof Counter>;
```
