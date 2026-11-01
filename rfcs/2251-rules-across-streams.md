# RFC 2251: Rules that span streams — one action commits to several streams atomically

- **Issue:** #2251
- **Author:** Claude, for rotorsoft
- **Created:** 2026-10-31
- **Revised:** 2026-11-01 (replaces the first design, merged in #2252)
- **Ships in:** 2.0 (the `Store.commit` signature changes)

## Motivation

An Act action decides inside one stream: it loads one state, checks its preconditions, and commits with a version guard on that stream. Many business rules span more than one stream:

- **uniqueness:** one account per email, one plate per vehicle, one review per customer per product;
- **capacity:** at most 30 students in a course, three sessions per user, five open tickets per agent;
- **rules over related streams:** no two bookings of a room overlap; payments never exceed the invoice; a transfer debits one account and credits another;
- **another aggregate's state:** an order reserves only what the product has in stock; a bike is rented only when it's free.

Apps get these today only eventually: a reaction notices the violation and emits a compensating event, or a unique index outside the event store races the commit. Both put the rule out of sight: the builder that should state it says nothing, and the CLI, the diagram and the flow animations can't show it.

The problem has several known solutions. Sagas and reservations keep each write to one aggregate and accept eventual consistency. Dynamic Consistency Boundaries ([DCB](https://dcb.events/)) tag events and refuse an append when a tagged query changed. KurrentDB 25.1 appends to several streams atomically, each with its own expected version ([release](https://kurrent.io/releases/kurrentdb/25-1)). This RFC takes the last one, because it adds the fewest concepts to Act and none to the store's semantics.

## The design

One action makes one decision and **commits its events to several streams atomically, each guarded by its own version.** Everything else is what Act already has: states that own their events, streams, `load`, the cache, `expectedVersion`, preconditions, the state schema checked before every commit, and `ConcurrencyError` retried by `maxRetries`.

The one new builder step is **`.loads`**, on an action: it loads another stream the decision needs, exactly as `app.load` would, and optionally lists the events the action may emit to it.

```ts
const Enroll = z.object({ course: z.string(), student: z.string() });
const Enrolled = Enroll;
const SeatTaken = z.object({ student: z.string() });

// Seats is an ordinary state, one stream per course. Its invariant is its schema.
const Seats = state({
  Seats: z
    .object({ taken: z.number(), capacity: z.number() })
    .refine((s) => s.taken <= s.capacity, "the course is full"),
})
  .init(() => ({ taken: 0, capacity: 30 }))
  .emits({ SeatTaken })
  .patch({ SeatTaken: (_, s) => ({ taken: s.taken + 1 }) })
  .build();

const Enrollment = state({ Enrollment: z.object({ course: z.string(), student: z.string() }) })
  .init(() => ({ course: "", student: "" }))
  .emits({ Enrolled })
  .patch({ Enrolled: ({ data }) => data })

  .on({ Enroll })
  .loads(Seats, (data) => `course-${data.course}`, ["SeatTaken"])
  .requires([{
    description: "the course has a free seat",
    holds: (_, __, ___, { Seats }) => Seats.taken < Seats.capacity,
  }])
  .emit((data) => [
    ["Enrolled", data],                       // Enrollment's event: the enrollment stream
    ["SeatTaken", { student: data.student }], // listed on the load: course-c1
  ])
  .build();
```

Read aloud: *on Enroll, load the Seats at `course-<id>`, which it may emit SeatTaken to; require a free seat; emit Enrolled and SeatTaken.*

`app.do("Enroll", ...)` loads the enrollment stream and `course-c1`, checks the precondition with both states, folds `Enrolled` onto the enrollment and `SeatTaken` onto the seats, checks both folded states against their schemas, and commits both events in one step, guarded by both streams' versions. If anyone took a seat meanwhile, the commit fails with `ConcurrencyError` and `maxRetries` reloads and re-checks.

Responsibilities stay where Act already puts them:

- **The decision belongs to the emitter.** `Enroll`'s `.requires` holds the rule, with every loaded state in hand.
- **The invariant belongs to the owner.** `Seats`' schema is checked on every fold, so no action can overfill a course, whichever action emits `SeatTaken`.
- **The audit trail is in every event.** `meta.causation.action` records the action, its stream and its actor, so a `SeatTaken` from `Enroll` is told apart from one emitted by any other action.

A load without events is a read-only guard: the decision depends on that stream, and the commit fails if it moved.

```ts
  .on({ ReserveBike })
  .loads(Bike, (data) => data.bike)
  .requires([{ description: "the bike is available", holds: (_, __, ___, { Bike }) => Bike.status === "free" }])
  .emit("BikeReserved")
```

When an action loads the same state twice, each load takes a name, and `.requires` sees the loads by those names:

```ts
  .on({ Transfer })
  .loads(Account, (data) => data.from, ["Debited"], "from")
  .loads(Account, (data) => data.to, ["Credited"], "to")
  .requires([{ description: "enough funds", holds: (data, _, __, { from }) => from.balance >= data.amount }])
  .emit((data) => [
    ["Transferred", data],
    ["Debited", { amount: data.amount }],  // listed on the "from" load
    ["Credited", { amount: data.amount }], // listed on the "to" load
  ])
```

Every event is listed on at most one load of an action, so routing needs nothing in the emit.

### Uniqueness and limits are ordinary states

No hidden machinery: a value that must be unique is a state of its own, one stream per value, visible in the builder, the diagram and the store.

```ts
const Email = state({ Email: z.object({ holder: z.string().optional() }) })
  .init(() => ({}))
  .emits({ EmailTaken, EmailReleased })
  .patch({
    EmailTaken: ({ data }) => ({ holder: data.user }),
    EmailReleased: () => ({ holder: undefined }),
  })
  .build();

const email = (value: string) => `email-${value.trim().toLowerCase()}`;

const User = state({ User: UserSchema })
  // ...
  .on({ Register })
  .loads(Email, (data) => email(data.email), ["EmailTaken"])
  .requires([{ description: "the email is free", holds: (_, __, ___, { Email }) => !Email.holder }])
  .emit((data, _, { stream }) => [["Registered", data], ["EmailTaken", { user: stream }]])

  .on({ ChangeEmail })
  .loads(Email, (_, state) => email(state.email), ["EmailReleased"], "old")
  .loads(Email, (data) => email(data.email), ["EmailTaken"], "new")
  .requires([{ description: "the new email is free", holds: (_, __, ___, { new: next }) => !next.holder }])
  .emit((data, _, { stream }) => [
    ["EmailChanged", data],
    ["EmailReleased", {}],
    ["EmailTaken", { user: stream }],
  ])
```

A limit is the same pattern with a count, like `Seats`. What a framework helper would have hidden is now one more state the app can read, test and show: whether a closed account frees its email is the closing action emitting `EmailReleased` or not.

## What one `app.do` does

1. **Load** the action's own stream (state and version), then each `.loads` target in declaration order; each target function sees the states loaded before it.
2. **Check the preconditions** with the action's state and every state it loaded (the fourth argument, `loaded`, keyed by state name, or by the load's name when it has one).
3. **Run `.emit` and route each event:** an event of the action's own state goes to its stream; an event listed on a load goes to that load's stream. Fold each event onto its stream's state, and check every folded state against its schema.
4. **Commit once,** `commit(writes)`, with each stream's expected version set to the version it had **when it was loaded**. A loaded stream that receives no event is an empty write: a version check only.
5. **The store checks every version in one atomic step.** If any stream moved since its load, nothing is written and the commit throws `ConcurrencyError`; `maxRetries` reruns the sequence from step 1 with fresh loads. An explicit `expectedVersion` from the caller applies to the action's own stream and is never retried.

No decision rests on stale context: every fact the preconditions and schemas saw is unchanged at commit time, or nothing commits. A load served from the cache is safe for the same reason; a cached version that's behind fails the check, and the retry reloads.

## Public surface

### `Store` port (breaking for adapters; 2.0)

- `commit(writes, meta)` replaces `commit(stream, msgs, meta, expectedVersion?)`. `writes` is `readonly { stream: string; msgs: Message[]; expectedVersion?: number }[]`, each stream at most once. All writes land or none do; each `expectedVersion` is checked against its own stream, and a stale one throws `ConcurrencyError` naming that stream. A write with no messages is a version check only. It returns the committed events of every write, in order.
- Adapters do the inserts for several streams inside the transaction they already open; the existing unique `(stream, version)` index catches a race on any of them. No new table, column or index.

### Builders (additive)

- **`.loads(State, target, events?, name?)`** on the action chain of `state` and `slice`, between `.on(...)` and `.requires(...)`; it can repeat.
  - `target(payload, state, loaded)` returns the stream id;
  - `events` lists the loaded state's events this action may emit to that stream (none: a read-only guard);
  - `name` keys the load when the action loads the same state twice.
- **Preconditions and `.emit`** get the loaded states as a new fourth argument, `loaded`: `holds(payload, state, actor, loaded)` and `emit(payload, snapshot, target, loaded)`.
- **`.emit`** may return the action's own events and the events listed on its loads.

### `app.do`, lifecycle events, errors

`app.do` returns its own stream's snapshots, typed exactly as today. The other streams' commits reach `committed`, and a state-scoped listener (`app.on("committed", Seats, …)`) hears them typed as that state. No new error or event name: a failed rule is `PreconditionError`, a folded state its schema refuses is `ValidationError`, and a race is `ConcurrencyError`.

## Type safety

Every new piece is typed from the states it names, end to end, and a type-level test fails to compile when any of these widens:

- **`.loads`:** a `State` carries its name as a literal type, so each load adds `{ [name]: thatState }` to the action's `loaded` type, in declaration order; a target function sees only the loads declared before it. `events` accepts only the loaded state's event names. A load name is a literal too, so a duplicate fails to compile.
- **Preconditions:** `holds(payload, state, actor, loaded)`, the fourth parameter optional, so a shared `Precondition<S, unknown>` still fits every action.
- **`.emit`:** `(payload, snapshot, target, loaded)`, and its return type is the state's own events plus every event listed on its loads, each with its own payload type. An event listed on no load fails to compile; an event listed on two loads of one action fails to compile.
- **`app.do` and act-http:** unchanged return types. A generated tRPC or Hono mutation still returns its action's snapshots, typed; the other streams' commits reach typed state-scoped `committed` listeners.

The build checks the same for plain JavaScript and dynamically built states: a load of the action's own stream, an event that doesn't belong to the loaded state, an event listed on two loads, a state loaded twice without names, and an emitted event no load lists all throw.

## Scenarios

Each ships as a test; the starred ones also as a recipe or in an example app.

| Scenario | The action loads… and may emit to it… |
|---|---|
| ★ User email: register, change (two loads of `Email`), deactivate, erase | `Email` at `email-<value>`: `EmailTaken`, `EmailReleased` |
| Vehicle plate never reissued | `Plate` at `plate-<value>`: `PlateTaken`; scrapping emits nothing to it |
| ★ Course capacity, student max courses | `Seats` at `course-<id>`: `SeatTaken`; `StudentLoad` at `student-<id>`: `CourseAdded` |
| Sessions per user, released on timeout | `UserSessions` at `sessions-<user>`: `SessionOpened`; a deferred reaction emits `SessionClosed` |
| ★ Wolfdesk: 5 open tickets per agent | `AgentLoad` at `agent-<id>`: `TicketTaken`, `TicketDropped`; a reassign loads two agents |
| ★ Room booking, no overlap | `Room` at `room-<id>`: `RoomReserved`; `Room`'s schema forbids overlapping intervals |
| Invoice payments | `Invoice` at `invoice-<id>`: `PaymentApplied`; the schema keeps paid ≤ amount |
| ★ Inventory | `Product` by its stream: `StockReserved`; the schema keeps stock ≥ 0; a deferred reaction frees expired holds |
| Money transfer | `Account` twice (`from`, `to`): `Debited`, `Credited`; three streams in one commit |
| Gapless invoice numbers | `InvoiceCounter` at `invoices`: `NumberIssued` |
| Idempotency or opt-in token; one review per customer per product | `Token` at `token-<id>`, or `Review` at `review-<customer>-<product>` |
| Library loans | `Copy` by its stream, then `Member` by the copy's borrower (chained targets) |
| Bike rental, displayed price | `Bike` or `Product`, no events: a read-only guard |

## Trade-offs

- **Two events for one fact.** `Enrolled` and `SeatTaken` record one enrollment in two streams, and a projection must count one of them. It keeps the store to plain version checks, and every state an aggregate that owns its events.
- **Hot streams serialize.** Every enrollment in one course goes through `course-c1`; every invoice through the counter. Any design that enforces "at most 30" or "no gaps" strongly pays this. A rule with no natural key ("total spend across all departments") needs one global stream. Splitting a hot resource across several streams is a recipe, not 2.0 surface.
- **A rule added to existing data** needs its new streams (an `Email` per existing user) filled from current state once. An operator recipe ships with the guide.
- **Who may write into a state.** Three ways were weighed, and this RFC takes the first:

  | | The owner's invariants | The owner's action rules | Who declares an outside write | Cost |
  |---|---|---|---|---|
  | **A. The emitter lists the events on `.loads`** | hold (schema) | not involved: the emitter's `.requires` owns the decision | the emitter, typed and validated | none beyond the load the decision needs anyway |
  | B. The owner lists what it accepts (`.accepts` / `.delegates` on the receiver) | hold (schema) | not involved | the owner | a second declaration; the emitter must still reference the owner for its types |
  | C. Run the owner's action (`.also`) | hold (schema) | run | the owner's actions | a second step, and two decisions in one commit |

  A costs the least ceremony. What it gives up is the owner's veto: any action may emit the owner's events to a stream it loads. The owner's schema still guards every fold, the CLI and diagram list every action that emits each event, and each event's causation names who emitted it.
- **The owner may emit the same events itself.** `Seats` can have its own action emitting `SeatTaken` beside `Enroll`. Ownership stays simple, the schema guards both paths, and causation tells them apart. The risk is that the two paths' preconditions drift; the guide's rule is that what must hold however the event arrives goes in the owner's schema, and two meanings deserve two events.
- **Explicit states for uniqueness and limits.** An `Email` state is more code than a framework helper, and every stream, event and rule is visible and tested like any other.
- **One store.** A commit is atomic only inside one store: a `.loads` of a state in another scoped Act throws at build. Hash partitions of one Postgres database are one store.
- **Not for the outside world.** A step that waits on an external confirmation (a payment gateway) stays a reaction-driven process.

## Objections considered

- **"Modify one aggregate per transaction"** ([Vernon](https://www.dddcommunity.org/wp-content/uploads/files/pdf_articles/Vernon_2011_2.pdf)): its reasons are distributed transactions when aggregates live in different stores, contention, and coupling. An Act app's streams share one store (the cross-store case is refused), the contention is the rule's own, and the coupling is declared. Vernon calls it a rule of thumb, and the `eventsourcing` library argues DDD always permitted a wider transaction ([docs](https://eventsourcing.readthedocs.io/en/latest/_sources/topics/examples/dcb-enrolment-introduction.rst.txt)). Reactions remain the tool where the business accepts compensation.
- **"One state writes into another without its rules."** The emitter's `.requires` is the rule of the decision, made with the owner's loaded state in hand; the owner's schema is checked on every fold, so whatever must always hold about a state holds whoever writes. This is the split Act already makes (RFC 2182: invariants are the state schema, preconditions are per decision). Tag-based DCB has the same exposure with less protection: any command can append an event with any tags, and a rule holds only where every command remembers to query it.
- **Tag-based DCB is more general.** It is, and it pushes domain semantics into the store's queries; the multi-stream optimistic-concurrency approach keeps the store to version checks ([Zenodo](https://zenodo.org/records/21157057)). Every scenario above is expressible with streams.
- **Deadlocks and lock time.** Loads hold no locks, so a conflict is a retry, never a deadlock. act-pg already serializes commits under one advisory lock; a multi-stream commit does a few more inserts inside it, and a real-adapter bench must show plain actions don't slow down.
- **"It removes the need for sagas"** (vendor material): only for decisions inside one store.

## How it meets every other feature

- **The decider rule.** Every stream loads before the fold; all folds happen before the store assigns ids; every folded state is checked against its schema. One commit.
- **Event ownership.** Each event still belongs to one state and folds only onto that state's streams. An action emits another state's events only to a stream it loaded and only those its load lists.
- **Cache and snapshots.** Each stream is cached and snapshotted as today.
- **Close, windowed close, archives.** Each stream's lifecycle is its own. Freeing a value on close is the closing action loading the value's stream and emitting the release.
- **`forget` and sensitive fields.** A stream id is not forgettable, so a stream keyed by a sensitive value (an email) must use a keyed hash of it (#2258). A loaded stream loads with the caller's actor, so its sensitive fields are gated as the caller's would be.
- **Reactions, lanes, defer.** Every committed event is correlated as today, so `SeatTaken` reaches `Seats`' reactions; a reaction's `app.do` can load and emit across streams too.
- **Partial states.** `.loads` belongs to its action.
- **Time travel.** `load(..., { asOf })` never runs `.loads`.
- **Tooling.** The CLI, the diagram and the flow player show each `.loads` as an edge between states, labeled with the events it may emit, and list every action that emits each event.

## Teaching it

The feature is only as good as the scenarios people can find and run. Every scenario in the table ships in four places:

- **The guide:** `docs/docs/guides/rules-across-streams.md`, a catalog: one short section per scenario with the rule in plain words, the builder code, what a race does, and which trade-off it pays. It links the alternatives (reactions with compensation, sagas) for when strong consistency isn't worth it.
- **Flow animations** (`animate-act-flows`, `docs/flows/*.flow.json`): one map of the scenarios, with flows that play a commit landing in two streams at once, a refusal from a precondition and from a schema, and a lost race being retried. Published with the docs.
- **An example app:** a new `packages/rules` (beside the existing examples, which stay as they are), with every scenario as states and tests. Wolfdesk gains the open-tickets-per-agent limit, added, not rewritten.
- **Recipes:** filling the new streams for a rule added to existing data, and splitting a hot resource across several streams.

The scaffold skill generates `.loads` and the uniqueness or capacity states when a spec states a rule across entities, and the behavior-contract page gets a row for every runtime guarantee here.

## Edge cases the tests must cover

**Store (the TCK, every adapter):**
- a stale version in the first, a middle, or the last write fails the whole commit, and nothing is stored;
- a failure while inserting any write (fault injection) stores nothing;
- a stream named twice is refused;
- an empty write with a matching version passes and stores nothing; with a stale one it refuses;
- a write with no `expectedVersion` beside guarded ones;
- creating streams (`-1`) and appending to existing ones in one commit;
- ids are assigned in order across the writes and become visible in that order;
- two connections racing on a shared stream: exactly one wins; on disjoint streams: both win.

**Core (`.loads` and routed events):**
- a load of the action's own stream, or two loads naming one stream, throws (at build when static, at the call when not);
- a state loaded twice without names throws at build; a duplicate load name fails to compile;
- an event listed on a load that doesn't belong to the loaded state, an event listed on two loads, and an emitted event of another state that no load lists all fail to compile and throw at build (or at the call, for a dynamic emit);
- a target function that throws commits nothing;
- a precondition over a loaded state refuses with `PreconditionError`; a loaded state's schema refuses its folded state with `ValidationError`; either way nothing commits;
- the action emits only its own events, only events to loaded streams, or nothing (nothing commits, no `committed`); every loaded stream is guarded, with or without events;
- a load without events (a read-only guard) refuses the commit when that stream moved;
- the owner emitting the same event from its own action, beside an outside emitter: both fold, the schema holds, causation tells them apart;
- a race on any stream is a `ConcurrencyError` retried by `maxRetries`, reloading every stream; an explicit `expectedVersion` on the action's stream is never retried;
- chained targets see earlier loads, including a stream that doesn't exist yet;
- a load of a closed stream refuses the whole commit;
- a loaded stream loads with the caller's actor, so its sensitive fields are gated, and the state check's marker rule applies to it;
- every written stream's cache entry is updated; a lost race drops the stale ones;
- `app.do` returns only its own stream's snapshots, typed as today; `committed` carries every written stream; a state-scoped listener hears only its own state's, typed; every written stream's reactions wake;
- a reaction's `app.do` that loads and emits across streams carries `reactingTo`, correlation and causation onto every event;
- a load of a state in another scoped Act's store throws at build;
- partial states and slices keep `.loads` on the action that declared it.

**The scenarios' own states** (uniqueness, limits): taking a free value, refusing a taken one, the race for the last slot (one wins, the retry is refused), changing a value (free the old and take the new in one commit), freeing on close, a lowered limit (existing holders keep, new takes refuse), and the fill recipe run twice (idempotent).

## Alternatives considered

- **Receiver-side declarations** (`.accepts`, `.delegates` on the owning state). The owner decides who may write, at the cost of a second declaration, and the emitter must still name the owner for its types. Dropped for ceremony; the owner's schema and the audit trail cover what it protected.
- **A separate step for emitting to another state** (`.emitsTo`). A second declaration for a stream the action must load anyway; folded into `.loads`.
- **Running another state's action** (`.also`). Two actions with two decisions in one commit.
- **Framework helpers for uniqueness and limits** (`.unique`, `.limits` over hidden framework streams). Less code per rule, but the streams, events and rules they create are invisible in the builder, the diagram and the audit trail.
- **Tag-based DCB** (tags on events, a commit condition over a tag query). Merged first in this RFC (#2252) and replaced: it adds tags or data indexes to every adapter, conditions the store must evaluate, and "decision models" that fold events other states own, with special rules for their cache, snapshots and deleted events.
- **Links** (one event filed in several streams through a link table). A new table, and deletion rules for events that live in more than one stream.
- **Reservation streams on today's port.** The same value streams, written in a second commit: a crash between the two leaves a value taken by no one.
- **Sagas and process managers.** Eventually consistent; they stay the answer for steps outside the store.
- **A larger aggregate** (Course holds every enrollment). Serializes everything about the course, not only the seat count.
- **A unique index on a projection table.** Eventual and outside the store.
- **Do nothing.**

## Stability / charter impact

- **Breaking, for adapters and direct `Store` callers:** `commit(writes, meta)`. A migration note shows the one-write form; the TCK shows what an adapter adds. Ships in 2.0 with a `BREAKING CHANGE:` footer.
- **Additive, for apps:** `.loads`, the fourth `loaded` argument, and events emitted to loaded streams. An app that uses none of them behaves as today.

## Open questions

1. **`.loads`' signature.** Positional (`State, target, events?, name?`) or an options object for the optional parts (`.loads(Account, (d) => d.from, { emits: ["Debited"], as: "from" })`).
2. **Stream ids that carry a sensitive value** (#2258): a keyed-hash helper (in act-crypto) and where its key comes from.
3. **Hot-resource splitting:** a recipe in 2.0; does it ever need surface?
