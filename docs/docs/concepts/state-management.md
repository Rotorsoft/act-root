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
- **`.emit((action, snapshot, target) => [name, data])`** for computed event data

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
      await app.do("AssignTicket", target, payload, event);
    })
    .to((event) => ({ target: event.stream }))
  .build();
```

Slice handlers receive `(event, stream, app)` where `app` is a typed `Dispatcher`.

## Act Orchestrator

The orchestrator composes everything:

```typescript
const app = act()
  .withState(Counter)
  .withSlice(TicketSlice)
  .withProjection(AuditProjection)
  .build();

await app.do("increment", { stream: "counter1", actor }, { by: 5 });
const snapshot = await app.load(Counter, "counter1");
```

## Utility Types

Extract inferred types from built State objects:

```typescript
import type { InferEvents, InferActions } from "@rotorsoft/act";

type Events = InferEvents<typeof Counter>;
type Actions = InferActions<typeof Counter>;
```
