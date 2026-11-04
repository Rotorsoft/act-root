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

`state({})` → `.init()` → `.emits({})` → optional `.patch({})` → `.on({}, options?)` → optional `.requires([])` → `.emit()` → `.build()`

- **`.emits()`** declares events with passthrough reducers by default (`({ data }) => data`)
- **`.patch()`** overrides only events that need custom reducers. A reducer reads the event's `data` (and `version`, if it must): an action folds before the store assigns `id` and `created`, so during an action those are `-1` and the commit time. Keep a business timestamp in the event data, or read `created` in a projection, which sees the stored row.
- **`.on(entry, options?)`** registers an action; the optional second argument is an [`ActionOptions`](./error-handling.md#retry-pattern--per-action-policy) for per-action retry policy (`maxRetries`, optional `backoff`). Omit for the current single-attempt behavior.
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

**State schema merge:** each partial's state schema is extended into the others, so every partial must declare its state as a plain `z.object({...})`. A key both partials declare must have the same base type, or the build throws. A wrapped schema such as `.readonly()`, `.transform()`, `.default()`, or a union or intersection has no shape to extend. Merging one with any other partial throws at build time, naming the state and the partial at fault. Keeping just one side would silently drop the other partial's fields. Re-registering the same partial through a second slice is fine, because both sides are the same schema instance.

**Actions belong to one partial:** two partials that declare the same action throw at build (`Duplicate action`), even when they share its schema. Each partial brings its own handler and rules, and merging them would pair one partial's rules with the other's handler. Re-registering the same partial through a second slice is fine.

**Patch merge priority:** When partials are merged and both declare the same event:
- One custom, one passthrough → keep the custom one (order doesn't matter)
- Same function reference → re-registration from another slice, allowed
- Two different custom patches → throw error at build time

This means a partial can redeclare an event in `.emits()` (to react to it via `.on()`) without overwriting the custom reducer from the partial that owns the event.

**State-level policies:** `.discloses()`, `.autocloses()`, `.archives()`, and the per-action options passed to `.on(entry, options)` survive the merge no matter which partial declared them — a retention policy on the third slice of a state behaves exactly like one on the first. Per-action options combine, since they are keyed by action name. The single-valued policies follow the same rule as `.snap()`: one declaration wins, and two *different* declarations throw at build time instead of silently keeping the first. `.autocloses()` carries its `after` / `keep` windows along with it, so the predicate and its windows always come from the same partial.

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

## What an action checks, in order

An action runs only when its **preconditions** hold, and the state it leaves behind must keep the state's **invariants**. In design by contract the two mean different things, and Act keeps them apart:

- **A precondition** must be true for one action to run *now*, and can be false at other times: "the ticket is open", "it's your turn". It belongs to the action.
- **An invariant** must be true of the state *after every action*: "every territory keeps at least one army", "a closed ticket has a closer". It belongs to the state, so it lives in the state's Zod schema.

`app.do(...)` refuses at the first check that fails, and nothing is stored:

1. **The payload** against the action's schema (`ValidationError`).
2. **The state loads,** then every stream its [`.loads`](#rules-across-streams-loads) name, at once.
3. **The preconditions** (`.requires`): rules the state, the actor, the payload and the loaded states must meet (`PreconditionError`).
4. The handler decides the events; each is checked against its schema (`ValidationError`). A handler that returns no events ends the action here: it returns the loaded snapshot, and nothing commits, no `committed` event fires and no reaction wakes.
5. **One fold, before the commit:** each event folds into its stream's state, and every state that got an event is checked once against its schema, its invariants (`ValidationError`).
6. The events commit in one step, with optimistic concurrency on every stream they append to, and the returned snapshots carry the stored rows.

## Preconditions

A precondition is declared with `.requires([...])`: a `description` and a `holds(payload, state, actor, loaded)` predicate (`loaded` holds the states the action [loads](#rules-across-streams-loads); a rule that doesn't read them leaves the last parameters out). One that reads only the state and the actor ignores the payload and is typed over `unknown`, so every action can use it:

```typescript no-check
import { type Precondition } from "@rotorsoft/act";

const mustBeOpen: Precondition<{ status: string }, unknown> = {
  description: "Ticket must be open",
  holds: (_, state) => state.status === "open",
};

.on({ CloseTicket: z.object({ reason: z.string() }) })
  .requires([mustBeOpen])
  .emit("TicketClosed")
```

One that also reads the payload ("you must own *this* territory") is typed over the part of the payload it reads, so any action with those fields can use it:

```typescript no-check
// Any action with a `from` field can use it.
const ownsFrom: Precondition<Board, { from: string }> = {
  description: "You must own the attacking territory",
  holds: ({ from }, state, actor) => state.owner[from] === actor?.id,
};

.on({ Attack })
  .requires([mustBeInAttack, mustBeCurrentPlayer, ownsFrom, adjacent, enoughArmies])
  .emit((data, { state }) => { /* the dice and the outcome only */ })
```

They run in the order they're declared and stop at the first that fails. A failed one throws `PreconditionError`, with the message `"<action> failed precondition: <description>"`, and nothing commits. The `act` CLI, the domain diagram and the flow animations list them as the action's preconditions.

Rules that don't fit a predicate stay as a `throw` in `.emit`: a rule that branches on the state, one that needs a value the handler computes anyway, or one that needs an app-specific error type.

## Invariants

Put what must always hold in the state's Zod schema, with refinements where a type can't say it:

```typescript no-check
const Ticket = z
  .object({
    status: z.enum(["open", "closed"]),
    closedBy: z.string().optional(),
  })
  .refine((t) => t.status !== "closed" || !!t.closedBy, "A closed ticket has a closer");
```

Every action checks the state it leaves against that schema before it commits (step 5), so a state the schema rejects is refused with a `ValidationError` whose `target` is `"<state>.<action>"`: nothing is stored and no reaction runs. The check runs once per action, on the final state, because an invariant must hold between actions, not between the events of one action. It only reads the state: a schema with defaults or transforms never rewrites it. Loads, replays and projection folds don't check, so a stream that already holds a bad event still loads. A reducer reads the event's `data` and `version`; during an action `id` and `created` are placeholders, as the builder chain notes above. A refinement that throws refuses the action with `ValidationError`, as a payload's does. On a state with sensitive events the check ignores the `[REDACTED]` and `[SHREDDED]` values the actor's view puts in its fields: see [the state check on PII-aware states](../guides/sensitive-data.md#the-state-check-on-pii-aware-states).

A field a reducer clears with `null` must be `.optional()` or `.nullish()` in the state schema. A `null` in a patch deletes the key, and `.nullable()` requires it, so the cleared state breaks the schema and every later action on the stream is refused:

```typescript no-check
const Board = z.object({
  turn: z.number(),
  // cleared with `{ lastAttack: null }` when a turn starts
  lastAttack: z.object({ from: z.string(), to: z.string() }).nullish(),
});
```

## Rules across streams: `.loads`

Some rules span streams: at most 30 students in a course, one account per email, a transfer that debits one account and credits another. An action states them with `.loads`, between `.on(...)` and `.requires(...)`: it loads another state the decision needs, exactly as `app.load` would, and lists the events of that state the action may emit to its stream.

```ts
import { act, state } from "@rotorsoft/act";
import { z } from "zod";

const SeatTaken = z.object({ student: z.string() });

// An ordinary state, one stream per course. Its invariant is its schema.
const Seats = state({
  Seats: z
    .object({ taken: z.number(), capacity: z.number() })
    .refine((s) => s.taken <= s.capacity, "the course is full"),
})
  .init(() => ({ taken: 0, capacity: 30 }))
  .emits({ SeatTaken })
  .patch({ SeatTaken: (_, s) => ({ taken: s.taken + 1 }) })
  .build();

const Enroll = z.object({ course: z.string(), student: z.string() });

const Enrollment = state({ Enrollment: Enroll })
  .init(() => ({ course: "", student: "" }))
  .emits({ Enrolled: Enroll })
  .on({ Enroll }, { maxRetries: 1 })
  .loads(Seats, (data) => `course-${data.course}`, ["SeatTaken"])
  .requires([
    {
      description: "the course has a free seat",
      holds: (_, __, ___, { Seats }) => Seats.taken < Seats.capacity,
    },
  ])
  .emit((data) => [
    ["Enrolled", data], // Enrollment's own event: its own stream
    ["SeatTaken", { student: data.student }], // listed on the load: course-<id>
  ])
  .build();

export const app = act().withState(Seats).withState(Enrollment).build();
```

`app.do("Enroll", ...)` loads the enrollment stream and `course-c1`, checks the precondition with both states, folds `Enrolled` onto the enrollment and `SeatTaken` onto the seats, checks both folded states against their schemas, and appends both events in one commit, each stream guarded by the version it had when loaded. If a seat was taken in between, the commit fails with `ConcurrencyError`, and `maxRetries` reruns the action with fresh loads, so the precondition sees the new count.

- **`target(payload, state)`** returns the stream to load, from the payload and the action's own state. A target naming a stream with no events loads the initial state. A target that names no stream, a load of the action's own stream, two loads of one stream, and a load of a closed stream (`StreamClosedError`) refuse the action.
- **Routing.** An event listed on a load goes to that load's stream; the state's own events go to its own stream. Each event is listed on at most one load of an action, so `.emit` never says where an event goes. An event no load lists, or one that isn't the loaded state's, fails to compile and throws.
- **`loaded`,** the fourth argument of `holds` and of `.emit`, holds each loaded state, keyed by the state's name, or by the load's name when it has one. Loading one state twice needs a name for each load: `.loads(Account, (d) => d.from, ["Debited"], "from").loads(Account, (d) => d.to, ["Credited"], "to")`.
- **A pinned `expectedVersion`** guards the action's own stream, even when the action appends only to loaded streams: a stale pin refuses with `ConcurrencyError`, and is never retried.
- **A load without events is a read.** The decision sees the state, but nothing is appended to its stream, so it isn't guarded: the commit lands even if that stream moved. A decision that must be refused when a stream moves appends to it.
- **The loaded state's schema guards every fold,** whichever action emits into it, and each event's `meta.causation.action` names the action that emitted it, so an owner's own `SeatTaken` and one from `Enroll` are told apart.
- **What `app.do` returns** is its own stream's snapshots, typed as without loads. `committed` fires once for each stream the action appended to, its own first, so a listener always gets one stream's snapshots; a state-scoped listener (`app.on("committed", Seats, ...)`) hears its own state's streams, and the reactions of every stream appended to wake.
- **One store.** A loaded state must be registered in the same Act (`act().build()` throws otherwise), so every stream of the commit lives in one store. A loaded stream loads with the caller's actor, so its sensitive fields are gated as the caller's would be.

Uniqueness and limits are ordinary states: an `Email` state, one stream per value, that a registration loads and appends `EmailTaken` to; a `Seats` state with a count. The scenarios behind this design (room booking, payments, inventory, transfers, invoice numbers, loans, rentals) run as tests in `libs/act/test/rules-across-streams.spec.ts`, and [RFC 2251](https://github.com/Rotorsoft/act-root/blob/master/rfcs/2251-rules-across-streams.md) explains the trade-offs.

## Upgrading from `.given` (removed in 2.0)

Act 1.x called the rules in `.given([...])` invariants, typed `Invariant` and refused with `InvariantError`. That was the wrong word: every one of them guards one action and is false at some point in a normal lifecycle, so each was a precondition, and the real invariants of a domain were written nowhere. 1.35 deprecated them, and 2.0 removes them:

- Write `.given([rule])` as `.requires([rule])`, with `valid: (state, actor) => ...` becoming `holds: (_, state, actor) => ...`, and type a shared rule `Precondition<S, unknown>` instead of `Invariant<S>`.
- Catch `PreconditionError` instead of `InvariantError`; `Errors.InvariantError` (`ERR_INVARIANT`) is gone, and act-http no longer has the `INVARIANT` code.
- Remove `validateFoldedState` from `act().build(...)`: invariants are the state's schema, checked before every commit, and the option was already ignored.
- A state field cleared with `null` in a patch must be `.optional()` or `.nullish()`. `null` deletes the key, so a `.nullable()` field, which requires the key, refuses every action after the one that cleared it (since 1.35).

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
    .do(async function openTicket({ stream, data }) {
      await db.insert(tickets).values({ id: stream, ...data });
    })
  .build();
```

Projection handlers receive `(event, stream)` — no dispatcher, no state mutations.

Handlers are named functions (`async function openTicket(...)`): the name is the reaction's identity, so an arrow function throws when the projection is built, and two handlers for one event can't share a name. The same holds for slice and `act()` reactions.

## Slices

Slices group partial states with scoped reactions into vertical feature modules:

```typescript no-check
import { slice } from "@rotorsoft/act";

const TicketSlice = slice()
  .withState(TicketCreation)
  .withState(TicketOperations)
  .withProjection(TicketProjection)
  .on("TicketOpened")
    .do(async function assignTicket(event, stream, app) {
      // reactingTo is auto-injected — no need to pass `event` explicitly
      await app.do("AssignTicket", { stream: event.stream, actor }, payload);
    })
    .to((event) => ({ target: event.stream }))
  .build();
```

Slice handlers receive `(event, stream, app)` where `app` implements `IAct` (`do`, `load`, `query`, `query_array`).

### Auto-injected `reactingTo`

When a slice handler calls `app.do(action, target, payload)` without a `reactingTo` in its options, the framework automatically threads the triggering event in as `reactingTo`, propagating the correlation chain (`correlation` and `causation.event`) through the new commit. Pass `{ reactingTo: someOtherEvent }` explicitly only if you want to override that default — e.g., to attribute a side-effect commit to a different upstream event.

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

Sharing a target has a second effect worth knowing. Reactions on the same event and the same target stream are delivered as one group, and the stream is never acknowledged past an event until every reaction in its group has run. So when one reaction in the group defers, the event stays pending, and when the due-time arrives **the whole group is delivered again**, including siblings that already succeeded on the first delivery. A `welcome` reaction that runs before a deferred `archive` on the same stream runs twice. No failure is involved, and it happens on every defer (an imperative `DeferSignal` that re-defers several times re-runs the siblings on each pass). Either make those siblings idempotent, as at-least-once delivery already asks, or isolate the defer with `.to(...)` as above, so it has its own stream and group ([#1745](https://github.com/Rotorsoft/act-root/issues/1745)).

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
