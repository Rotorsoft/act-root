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
- **another aggregate's state:** an order reserves only what the product has in stock.

Apps get these today only eventually: a reaction notices the violation and emits a compensating event, or a unique index outside the event store races the commit. Both put the rule out of sight: the builder that should state it says nothing, and the CLI, the diagram and the flow animations can't show it.

The problem has several known solutions. Sagas and reservations keep each write to one aggregate and accept eventual consistency. Dynamic Consistency Boundaries ([DCB](https://dcb.events/)) tag events and refuse an append when a tagged query changed. KurrentDB 25.1 appends to several streams atomically, each with its own expected version ([release](https://kurrent.io/releases/kurrentdb/25-1)). This RFC takes the last one, because it adds the fewest concepts to Act and none to the store's semantics.

## The design

One action makes one decision and **commits its events to several streams atomically, each guarded by its own version.** Everything else is what Act already has: states that own their events, streams, `load`, the cache, `expectedVersion`, preconditions, the state schema checked before every commit, and `ConcurrencyError` retried by `maxRetries`.

The one new builder step is **`.loads`**: the action loads another stream it needs for its decision, exactly as `app.load` would. Its preconditions see that state, and when the action emits an event owned by that state, the event commits to that stream.

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
  .loads(Seats, (data) => `course-${data.course}`)
  .requires([{
    description: "the course has a free seat",
    holds: (_, __, ___, { Seats }) => Seats.taken < Seats.capacity,
  }])
  .emit((data) => [
    ["Enrolled", data],                       // Enrollment's event: the enrollment stream
    ["SeatTaken", { student: data.student }], // Seats' event: course-c1
  ])
  .build();
```

`app.do("Enroll", ...)` loads the enrollment stream and `course-c1`, checks the precondition with both states, folds `Enrolled` onto the enrollment and `SeatTaken` onto the seats, checks both folded states against their schemas, and commits both events in one step, guarded by both streams' versions. If anyone took a seat meanwhile, the commit fails with `ConcurrencyError` and `maxRetries` reloads and re-checks. The precondition gives a full course a clear `PreconditionError`; the `Seats` schema is what guarantees no action can ever overfill a course, whichever action emits `SeatTaken`.

A rule that only needs to look loads the other stream and emits nothing into it; the load still guards that stream's version:

```ts
const ReserveItem = z.object({ product: z.string(), qty: z.number() });

  .on({ ReserveItem })
  .loads(Product, (data) => data.product)
  .requires([{
    description: "enough stock",
    holds: (data, _, __, { Product }) => Product.stock >= data.qty,
  }])
  .emit("ItemReserved")
```

When an action loads the same state twice, each load is named, and an event names the load it goes to:

```ts
  .on({ Transfer })
  .loads("from", Account, (data) => data.from)
  .loads("to", Account, (data) => data.to)
  .requires([{ description: "enough funds", holds: (data, _, __, { from }) => from.balance >= data.amount }])
  .emit((data) => [
    ["Transferred", data],
    ["Debited", { amount: data.amount }, "from"],
    ["Credited", { amount: data.amount }, "to"],
  ])
```

The two rules apps state most often need no hand-written state at all. They sit beside the state's other policies, like `.discloses` or `.autocloses`:

```ts
const User = state({ User: z.object({ email: z.string(), active: z.boolean() }) })
  .init(() => ({ email: "", active: false }))
  .emits({ Registered, EmailChanged, Deactivated })
  .patch({ ... })
  .unique("email", { while: (s) => s.active, normalize: (e) => e.toLowerCase() })

  .on({ Register })
  .emit("Registered")
  // ...

const Enrollment = state({ Enrollment: ... })
  // ...
  .limits("student", 5)
```

Each value gets a small stream that records which streams hold it (`ann@x.io` → `user-42`), and its schema says how many may. The framework adds, to every action that sets the field, changes it, or changes the `while` result, a load of the value's stream and the events that take the new value and free the old. Apps never see these streams; they see `.unique` and `.limits`.

## What one `app.do` does

1. **Load** the action's own stream (state and version), then each `.loads` target in declaration order; each target function sees the states loaded before it.
2. **Check the preconditions** with the action's state and every state it loaded (the fourth argument, `loaded`, keyed by state name, or by the load's name when named).
3. **Run `.emit` and route each event:** an event owned by the action's state goes to the action's stream; an event owned by a loaded state goes to that load's stream (named, when the state is loaded twice). Fold each event onto its stream's state, and check every folded state against its schema.
4. **Commit once,** `commit(writes)`, with each stream's expected version set to the version it had **when it was loaded**. A loaded stream that receives no event is an empty write: a version check only.
5. **The store checks every version in one atomic step.** If any stream moved since its load, nothing is written and the commit throws `ConcurrencyError`; `maxRetries` reruns the sequence from step 1 with fresh loads. An explicit `expectedVersion` from the caller applies to the action's own stream and is never retried.

No decision rests on stale context: every fact the preconditions and schemas saw is unchanged at commit time, or nothing commits. A load served from the cache is safe for the same reason; a cached version that's behind fails the check, and the retry reloads.

## Public surface

### `Store` port (breaking for adapters; 2.0)

- `commit(writes, meta)` replaces `commit(stream, msgs, meta, expectedVersion?)`. `writes` is `readonly { stream: string; msgs: Message[]; expectedVersion?: number }[]`, each stream at most once. All writes land or none do; each `expectedVersion` is checked against its own stream, and a stale one throws `ConcurrencyError` naming that stream. A write with no messages is a version check only. It returns the committed events of every write, in order.
- Adapters do the inserts for several streams inside the transaction they already open; the existing unique `(stream, version)` index catches a race on any of them. No new table, column or index.

### Builders (additive)

- **`.loads(State, target)`** and **`.loads(name, State, target)`** on the action chain of `state` and `slice`, between `.on(...)` and `.requires(...)`; it can repeat. `target(payload, state, loaded)` returns a stream id. The loaded states reach preconditions and `.emit` as a new fourth argument, `loaded`, keyed by state name or by `name`, and typed from each state.
- **`.emit`** may return events owned by any state the action loads. An emitted tuple takes an optional third element, the load's name, when that state is loaded more than once. An event owned by a state the action doesn't load throws at build when the emit is static, and at the call when it isn't.
- **`.unique(field, options?)`** and **`.limits(field, max, options?)`** on `state(...)`. `max` is a number or `(value) => number`. `.unique(f)` is `.limits(f, 1)` with its own message (`"<State>.<field> is unique"`, `"<State>.<field> is limited to <max>"`).
- **`UniqueOptions`**, for both: `while?: (state) => boolean` (a stream holds its value only while true), `normalize?: (value) => string` (case, whitespace), `onClose?: "release" | "keep"` and `onForget?: "release" | "keep"` (whether closing or forgetting a stream frees its value or keeps it taken; `"release"` by default).

### `app.do`, lifecycle events, errors

`app.do` returns its own stream's snapshots, typed exactly as today. The other streams' commits reach `committed`, and a state-scoped listener (`app.on("committed", Seats, …)`) hears them typed as that state. No new error or event name: a failed rule is `PreconditionError`, a folded state its schema refuses is `ValidationError`, and a race is `ConcurrencyError`.

## Type safety

Every new step is typed from the states it names, end to end, and a type-level test fails to compile when any of these widens:

- **`.loads`:** a `State` carries its name as a literal type, so each load adds `{ [name]: thatState }` to the action's `loaded` type, in declaration order; a target function sees only the loads declared before it. A load name is a literal too, so a duplicate fails to compile.
- **Preconditions:** `holds(payload, state, actor, loaded)`, the fourth parameter optional, so a shared `Precondition<S, unknown>` still fits every action.
- **`.emit`:** `(payload, snapshot, target, loaded)`, and its return type is the state's own events plus every loaded state's events. A tuple's third element is typed as the names of the loads whose state owns that event, so a wrong or missing load name fails to compile. An event name belongs to one state per app (the build already refuses a duplicate), so routing by name is never ambiguous except for a state loaded twice, which is exactly when the name is required.
- **`.unique` and `.limits`:** `field` accepts only state keys whose type is a string, number or enum; `while` gets the typed state; `normalize` and a `max` function get the field's type.
- **`app.do` and act-http:** unchanged return types. A generated tRPC or Hono mutation still returns its action's snapshots, typed; the other streams' commits reach typed state-scoped `committed` listeners.

## Scenarios

Each ships as a test; the starred ones also as a recipe or in an example app.

| Scenario | The action loads… and emits… |
|---|---|
| ★ User email: register, change, deactivate (`while`), erase (`onForget`) | `.unique("email")`: the framework loads the value's stream and takes or frees it |
| Vehicle plate never reissued | `.unique` with `onClose: "keep"` |
| ★ Course capacity, student max courses | `Seats` on `course-c1`, emitting `SeatTaken`; `.limits("student", 5)` |
| Sessions per user, released on timeout | `.limits("user", 3)`; a deferred reaction ends the session |
| ★ Wolfdesk: 5 open tickets per agent | `.limits("agent", 5, { while: open })`; a reassign frees one agent's slot and takes another's in one commit |
| ★ Room booking, no overlap | `Room` on `room-r1`, emitting `RoomReserved`; `Room`'s schema forbids overlapping intervals |
| Invoice payments | `Invoice` on `invoice-i`, emitting `PaymentApplied`; the schema keeps paid ≤ amount |
| ★ Inventory | `Product` by its stream, emitting `StockReserved`; the schema keeps stock ≥ 0; a deferred reaction frees expired holds |
| Money transfer | `Account` twice (`from`, `to`), emitting `Debited` and `Credited`: three streams in one commit |
| Gapless invoice numbers | an `InvoiceCounter` stream, emitting `NumberIssued` |
| Idempotency or opt-in token; one review per customer per product | `.unique` on the token, or on the customer and product together |
| Library loans | `Copy` by its stream, then `Member` by the copy's borrower |
| Bike rental, displayed price | a load only: nothing emitted into it |

## Trade-offs

- **Two events for one fact.** `Enrolled` and `SeatTaken` record one enrollment in two streams, and a projection must count one of them. It keeps the store to plain version checks, and every state an aggregate that owns its events. `.unique` and `.limits` keep their own events out of sight.
- **Hot streams serialize.** Every enrollment in one course goes through `course-c1`; every invoice through the counter. Any design that enforces "at most 30" or "no gaps" strongly pays this. A rule with no natural key ("total spend across all departments") needs one global stream. Splitting a hot resource across several streams is a recipe, not 2.0 surface.
- **A rule added to existing data** needs its value streams filled from current state once. An operator recipe ships with `.unique`.
- **Explicit coupling.** `Enrollment` emits `Seats`' event. The build checks the event exists and the state is loaded, and the diagram and CLI show the edge.
- **One store.** A commit is atomic only inside one store: a `.loads` of a state in another scoped Act throws at build. Hash partitions of one Postgres database are one store.
- **Not for the outside world.** A step that waits on an external confirmation (a payment gateway) stays a reaction-driven process.

## Objections considered

- **"Modify one aggregate per transaction"** ([Vernon](https://www.dddcommunity.org/wp-content/uploads/files/pdf_articles/Vernon_2011_2.pdf)): its reasons are distributed transactions when aggregates live in different stores, contention, and coupling. An Act app's streams share one store (the cross-store case is refused), the contention is the rule's own, and the coupling is declared. Vernon calls it a rule of thumb, and the `eventsourcing` library argues DDD always permitted a wider transaction ([docs](https://eventsourcing.readthedocs.io/en/latest/_sources/topics/examples/dcb-enrolment-introduction.rst.txt)). Each state's invariants still live in its own schema and hold on every commit. Reactions remain the tool where the business accepts compensation.
- **Tag-based DCB is more general.** It is, and it pushes domain semantics into the store's queries; the multi-stream optimistic-concurrency approach keeps the store to version checks ([Zenodo](https://zenodo.org/records/21157057)). Every scenario above is expressible with streams.
- **Deadlocks and lock time.** Loads hold no locks, so a conflict is a retry, never a deadlock. act-pg already serializes commits under one advisory lock; a multi-stream commit does a few more inserts inside it, and a real-adapter bench must show plain actions don't slow down.
- **"It removes the need for sagas"** (vendor material): only for decisions inside one store.

## How it meets every other feature

- **The decider rule.** Every stream loads before the fold; all folds happen before the store assigns ids; every folded state is checked against its schema. One commit.
- **Event ownership.** Each event still belongs to one state and folds only onto that state's streams. An action may emit another state's events only into a stream it loaded.
- **Cache and snapshots.** Each stream is cached and snapshotted as today. The framework's value streams don't snapshot.
- **Close, windowed close, archives.** Each stream's lifecycle is its own. Closing a stream frees or keeps its unique values as `onClose` says, by emitting the release into each value's stream in the same close. The framework's value streams are never autoclosed.
- **`forget` and sensitive fields.** A value stream's id carries the value, so `.unique` on a sensitive field uses a keyed hash of it in the id (#2258), and `forget` frees or keeps it as `onForget` says. A loaded stream loads with the caller's actor, so its sensitive fields are gated as the caller's would be.
- **Reactions, lanes, defer.** Every committed event is correlated as today, so `SeatTaken` reaches `Seats`' reactions; a reaction's `app.do` can load and emit across streams too.
- **Partial states.** `.loads` belongs to its action; `.unique` and `.limits` survive the merge like other state policies (contract row 269).
- **Time travel.** `load(..., { asOf })` never runs `.loads`.
- **Tooling.** The CLI, the diagram and the flow player show each `.loads` as an edge between states, the events an action emits into another stream, and `.unique`/`.limits` beside the preconditions.

## Teaching it

The feature is only as good as the scenarios people can find and run. Every scenario in the table ships in four places:

- **The guide:** `docs/docs/guides/rules-across-streams.md`, a catalog: one short section per scenario with the rule in plain words, the builder code, what a race does, and which trade-off it pays. It links the alternatives (reactions with compensation, sagas) for when strong consistency isn't worth it.
- **Flow animations** (`animate-act-flows`, `docs/flows/*.flow.json`): one map of the scenarios, with flows that play a commit landing in two streams at once, a refusal from a precondition and from a schema, and a lost race being retried. Published with the docs.
- **An example app:** a new `packages/rules` (beside the existing examples, which stay as they are), with every scenario as states and tests. Wolfdesk gains the open-tickets-per-agent limit, added, not rewritten.
- **Recipes:** filling the value streams for a rule added to existing data, and splitting a hot resource across several streams.

The scaffold skill generates `.loads`, `.unique` and `.limits` when a spec states a rule across entities, uniqueness or capacity, and the behavior-contract page gets a row for every runtime guarantee here.

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
- a state loaded twice without names throws at build; an event of that state without a load name throws;
- an event owned by a state the action doesn't load throws;
- a target function that throws commits nothing;
- a precondition over a loaded state refuses with `PreconditionError`; a loaded state's schema refuses its folded state with `ValidationError`; either way nothing commits;
- the action emits only its own events, only events into loaded streams, or nothing (nothing commits, no `committed`); the action's own stream is guarded even when it receives no event;
- a race on any stream is a `ConcurrencyError` retried by `maxRetries`, reloading every stream; an explicit `expectedVersion` on the action's stream is never retried;
- chained targets see earlier loads, including a stream that doesn't exist yet;
- a load of a closed stream refuses the whole commit;
- a loaded stream loads with the caller's actor, so its sensitive fields are gated, and the state check's marker rule applies to it;
- every written stream's cache entry is updated; a lost race drops the stale ones;
- `app.do` returns only its own stream's snapshots, typed as today; `committed` carries every written stream; a state-scoped listener hears only its own state's, typed; every written stream's reactions wake;
- a reaction's `app.do` that loads and emits across streams carries `reactingTo`, correlation and causation onto every event;
- a load of a state in another scoped Act's store throws at build;
- partial states and slices keep `.loads` on the action that declared it.

**`.unique`, `.limits`:**
- set, change (free the old and take the new in one commit), unset, and set to the same value (nothing changes);
- `while` turning false frees the value and turning true takes it;
- `normalize` makes two spellings collide;
- an `undefined`, `null` or empty value takes nothing;
- the race for the last slot: one wins, the retry is refused;
- a `max` function, and a smaller limit than the current holders (existing holders keep, new takes refuse);
- a holding stream closed with `onClose` `"release"` and `"keep"`; forgotten with `onForget` `"release"` and `"keep"`;
- a holding stream pruned or archived: its value stays taken;
- the fill recipe on existing data, run twice (idempotent);
- the framework's value events never reach the app's reactions or projections;
- `.unique` on a sensitive field throws at build until #2258.

## Alternatives considered

- **Running another state's action** (`.also(Seats, "TakeSeat", …)`). Considered in this revision and dropped: it's two actions with two decisions, not one, and it needs a second new builder step. Loading the other stream and emitting its event keeps one decision, one emit, and the other state's invariant in its schema.
- **Tag-based DCB** (tags on events, a commit condition over a tag query). Merged first in this RFC (#2252) and replaced: it adds tags or data indexes to every adapter, conditions the store must evaluate, and "decision models" that fold events other states own, with special rules for their cache, snapshots and deleted events.
- **Links** (one event filed in several streams through a link table). A new table, and deletion rules for events that live in more than one stream.
- **Reservation streams on today's port.** The same value streams, written in a second commit: a crash between the two leaves a value taken by no one.
- **Sagas and process managers.** Eventually consistent; they stay the answer for steps outside the store.
- **A larger aggregate** (Course holds every enrollment). Serializes everything about the course, not only the seat count.
- **A unique index on a projection table.** Eventual and outside the store.
- **Do nothing.**

## Stability / charter impact

- **Breaking, for adapters and direct `Store` callers:** `commit(writes, meta)`. A migration note shows the one-write form; the TCK shows what an adapter adds. Ships in 2.0 with a `BREAKING CHANGE:` footer.
- **Additive, for apps:** `.loads`, events emitted into loaded streams, `.unique`, `.limits`, `UniqueOptions`. An app that uses none of them behaves as today.

## Open questions

0. **Names.** Every new name here is a placeholder until it reads intuitively in a chain:
   - loading another stream for the decision: `.loads` (Act's word for reading a stream folded, as in `app.load`), `.reads`, `.checks`;
   - at most N holders per value: `.limits`, `.atMost` (it pairs with `.unique`), `.capacity`;
   - naming a load when a state is loaded twice, and the event tuple's third element.

   The tickets use the placeholders.
1. **The hash key for sensitive values** (#2258): an `ActOptions` field or act-crypto's key provider, and how it rotates without freeing every value.
2. **Hot-resource splitting**: a recipe in 2.0; does `.limits` ever need a sharded form?
