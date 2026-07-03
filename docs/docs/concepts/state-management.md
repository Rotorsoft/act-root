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

`state({})` → `.init()` → `.emits({})` → optional `.patch({})` → `.on({}, options?)` → optional `.given([])` → `.emit()` → `.build()`

- **`.emits()`** declares events with passthrough reducers by default (`({ data }) => data`)
- **`.patch()`** overrides only events that need custom reducers
- **`.on(entry, options?)`** registers an action; the optional second argument is an [`ActionOptions`](./error-handling#retry-pattern--per-action-policy) for per-action retry policy (`maxRetries`, optional `backoff`). Omit for the current single-attempt behavior.
- **`.emit("EventName")`** passes the action payload through directly as event data
- **`.emit((action, snapshot, target) => [name, data])`** for computed event data. The handler receives:
  - `action` — the validated action payload
  - `snapshot` — the current state snapshot (`{ state, version, event, ... }`)
  - `target` — the dispatch target (`{ stream, actor }`), useful when the actor or stream id needs to flow into the event

### Partial States

Multiple states sharing the same name merge automatically when composed in slices or the act orchestrator:

```typescript
import { state } from "@rotorsoft/act";
import { z } from "zod";

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

### Cross-slice event schemas — reference identity

When a partial redeclares an event so it can `.on()` it (or for a slice that reacts to events owned by another slice), the **Zod schema in both partials must be the same JS reference**. The merge throws at build time if two partials declare the same event with different schema instances — silent contract drift is the failure mode this rule prevents.

```typescript no-check
// events/ticket.ts — single source of truth for the shared schema
import { z } from "zod";

export const TicketOpened = z.object({ title: z.string() });

// slice A — owns the event
import { TicketOpened } from "./events/ticket.js";

const TicketCreation = state({ Ticket: TicketState })
  .init(() => ({ title: "" }))
  .emits({ TicketOpened })  // ← shorthand: { TicketOpened: TicketOpened }
  .patch({ TicketOpened: (e, s) => ({ ...s, title: e.data.title }) })
  // ...
  .build();

// slice B — reacts to the event; same reference, no schema redeclaration
import { TicketOpened } from "./events/ticket.js";

const TicketAudit = state({ Ticket: AuditState })
  .init(() => ({ auditedAt: 0 }))
  .emits({ TicketOpened })  // ← same reference, no drift possible
  // ...
  .build();
```

Inlining the schema in each partial — `.emits({ TicketOpened: z.object({...}) })` in slice A and a separate `z.object({...})` in slice B — produces two different references with potentially-different shapes, refinements, or enum constraints that TypeScript can't detect. The merge throws with a message that names the event, the state, and the fix:

> Event "TicketOpened" in state "Ticket" is declared with different Zod schemas across slices. Cross-slice event schemas must reference the same instance — extract a shared schema (e.g. `export const TicketOpened = z.object({ ... })` in a shared module) and import it in every slice that declares it.

Cross-state collisions (two slices declaring the same event name in *different* state names) still throw `Duplicate event` regardless of reference, because the same event name can only be owned by one state.

## Invariants

Business rules enforced before actions execute:

```typescript no-check
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

```typescript no-check
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

```typescript no-check
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

```typescript no-check
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

When a slice handler calls `app.do(action, target, payload)` without the fourth `options` argument, the framework automatically threads the triggering event in as `reactingTo`, propagating the correlation chain (`correlation` and `causation.event`) through the new commit. Pass `{ reactingTo: someOtherEvent }` explicitly only if you want to override that default — e.g., to attribute a side-effect commit to a different upstream event.

## Deferred reactions

Every reaction so far runs the instant its triggering event arrives. Some workflows want the opposite. Something should happen *because time passed* and no event showed up: hold an order for thirty minutes and expire it if it is still unpaid, ping a customer a day after a ticket goes quiet, wait out a cooldown before the follow-up. A reaction can defer itself to a future time. The drain holds the triggering event pending, advances nothing, and delivers it again once the due-time arrives, at which point the handler runs.

The common way to say this is the declarative `.defer(when)` step. It sits between `.on(event)` and `.do(handler)` on both the `act()` and the `slice()` builders, and it turns the reaction into a one-shot delay-then-run: the schedule holds the reaction until it is due, then the handler fires once.

```typescript
import { act, state } from "@rotorsoft/act";
import { z } from "zod";

const job = state({ Job: z.object({ status: z.string() }) })
  .init(() => ({ status: "" }))
  .emits({ queued: z.object({ delayMs: z.number() }) })
  .patch({ queued: () => ({ status: "queued" }) })
  .on({ enqueue: z.object({ delayMs: z.number() }) })
    .emit((a) => ["queued", a])
  .build();

const app = act()
  .withState(job)
  .on("queued")
    .defer((event) => ({
      at: new Date(event.created.getTime() + event.data.delayMs),
    }))
    .do(async function start() {
      // runs once, after the payload-derived delay has elapsed
    })
  .build();
```

`when` is either a literal schedule or a function of the triggering event, so the handler above reads `event.data.delayMs` off the payload to decide how long to wait. A literal schedule (`.defer({ after: { minutes: 30 } })`) is validated at build time, so a malformed one throws a `ZodError` the moment you call `.build()` rather than silently misbehaving on the first drain. The function form can only be checked when it runs, since its shape depends on the event.

### The `when` vocabulary

A schedule takes exactly one of two shapes:

```typescript no-check
type DeferWhen =
  | { after: { days?: number; hours?: number; minutes?: number } }
  | { at: Date };
```

`{ after }` is a span measured from the triggering event's `created` time, so `{ hours: 1, minutes: 30 }` means ninety minutes past that event. The drain anchors the wait to the event, not to when the handler happened to run. `{ at }` is an absolute `Date`.

There is deliberately no function form of `at`. Wherever you choose a schedule the triggering event is already in hand: as the `(event) =>` argument in the declarative form, and in the handler's own scope in the imperative form below. A deadline computed from the payload or from loaded state is therefore just `{ at: computedDate }`, with no callback needed.

That shape enforces the one load-bearing rule of the whole feature, **derivability**: a due-time must derive from event data and never from `Date.now()`. Because watermarks and leases last only seconds while a defer can last days, a competing worker will re-claim the stream long before the wait is over. When it re-resolves the schedule against the same triggering event it must land on the same due-time as the worker that first deferred, otherwise the deferral fires early or drifts. Anchoring `{ after }` to `event.created` and deriving every `{ at }` from event data is what keeps a defer correct across restarts and across competing consumers.

### The `DeferSignal` escape hatch

When a static schedule is not expressive enough, throw `DeferSignal` from inside the handler. It is exported from `@rotorsoft/act` and carries an unresolved `when`; the drain resolves it against the triggering event it is already dispatching.

```typescript
import { act, state, DeferSignal, ZodEmpty } from "@rotorsoft/act";
import { z } from "zod";

const counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ ticked: ZodEmpty })
  .patch({ ticked: () => ({}) })
  .on({ tick: ZodEmpty })
    .emit(() => ["ticked", {}])
  .build();

const app = act()
  .withState(counter)
  .on("ticked")
    .do(async function deadline(event) {
      const due = event.created.getTime() + 100;
      if (Date.now() < due) throw new DeferSignal({ at: new Date(due) });
      // the deadline has passed — do the real work here
    })
  .build();
```

Reach for the signal when a fixed schedule cannot express the wait: the due-time depends on loaded state or a query, the defer is conditional, the cadence is computed per attempt, or the deadline hangs off another stream. The compiled autoclose reaction is the in-tree precedent, throwing `DeferSignal` anchored to the live stream head rather than to the event that triggered it.

The boundary between the two surfaces is worth stating plainly. If the due-time is a pure function of the triggering event and the wait is unconditional, use `.defer(when)`. The moment you need loaded state, a query, another stream, prior attempts, or a runtime branch to decide, throw `DeferSignal`.

### Isolating a defer with `.to`

A watermark is keyed by its target stream, so every reaction that shares a target shares a lease. A deferred reaction consequently holds its target stream for the whole wait, which parks the aggregate's other reactions on that stream right along with it. That is often fine, but when a slow deadline shouldn't stall everything else, route the defer onto a stream of its own with `.to(...)`. Isolation here is opt-in, not something the framework does behind your back.

```typescript no-check
.on("ticked")
  .defer({ after: { days: 90 } })
  .do(async function archive() {
    // holds "counter-deadlines", not the source stream
  })
  .to("counter-deadlines")
```

The mechanic underneath both surfaces (the pending hold, the persisted `deferred_at`, and the claim-skips-until-due behavior) is covered in [Correlation & drain](../architecture/correlation-and-drain.md) and the [close-cycle](../architecture/close-cycle.md) reference.

Both surfaces are one-shot on purpose. There is no `{ every }` recurrence form, because holding one event forever to re-fire it would pin the stream's watermark. When you need a timer that repeats on a cadence, build it as a reaction that one-shot-defers a tick and then emits the next tick, following the [recurring-timers recipe](https://github.com/Rotorsoft/act-root/tree/master/recipes/temporal/recurring-timers).

## Act Orchestrator

The orchestrator composes everything:

```typescript no-check
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

```typescript no-check
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
import { state, type InferEvents, type InferActions } from "@rotorsoft/act";
import { z } from "zod";

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ amount: z.number() }) })
  .on({ increment: z.object({ by: z.number() }) })
    .emit((action) => ["Incremented", { amount: action.by }])
  .build();

type Events = InferEvents<typeof Counter>;
type Actions = InferActions<typeof Counter>;
```
