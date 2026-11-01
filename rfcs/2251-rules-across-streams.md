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

One new idea: **an action can commit to several streams atomically, each guarded by its own version.** Everything else is what Act already has: states that own their events, streams, `load`, the cache, `expectedVersion`, preconditions, `ConcurrencyError` retried by `maxRetries`.

A rule that spans streams lives in the aggregate that owns it. The action that must respect it **also** runs that aggregate's action, in the same commit:

```ts
// Seats is an ordinary state, one stream per course, owning its events.
const Seats = state({ Seats: z.object({ taken: z.number(), capacity: z.number() }) })
  .init(() => ({ taken: 0, capacity: 30 }))
  .emits({ SeatTaken, SeatReleased })
  .patch({ ... })
  .on({ takeSeat: z.object({ student: z.string() }) })
  .requires([{ description: "the course has a free seat", holds: (_p, s) => s.taken < s.capacity }])
  .emit((p) => ["SeatTaken", p])
  .build();

const Enrollment = state({ Enrollment })
  // ...
  .on({ enroll: z.object({ course: z.string(), student: z.string() }) })
  .also(Seats, "takeSeat", (p) => ({ stream: `course-${p.course}`, payload: { student: p.student } }))
  .emit((p) => ["Enrolled", p])
  .build();
```

`app.do("enroll", ...)` loads the enrollment stream and `course-c1`, runs both actions' preconditions, folds both, and commits `Enrolled` and `SeatTaken` in one step, guarded by both streams' versions. If anyone took a seat meanwhile, the commit fails with `ConcurrencyError` and the action's `maxRetries` reloads and re-checks. A full course refuses with `PreconditionError` from `takeSeat`'s rule.

A rule that only needs to look reads the other stream and guards its version without writing to it:

```ts
.on({ reserveItem: z.object({ product: z.string(), qty: z.number() }) })
.reads(Product, (p) => p.product)
.requires([{ description: "enough stock", holds: (p, _s, _a, { Product }) => Product.stock >= p.qty }])
```

The two rules apps state most often need no hand-written state at all:

```ts
const User = state({ User: z.object({ email: z.string(), active: z.boolean() }) })
  // ...
  .unique("email", { while: (s) => s.active, normalize: (e) => e.toLowerCase() })

const Enrollment = state({ Enrollment })
  // ...
  .limits("course", 30)
  .limits("student", 5)
```

Each value gets a small stream that records which streams hold it (`ann@x.io` → `user-42`). The framework writes it, through `.also` steps on every action that sets the field, changes it, or changes the `while` result: take the new value, release the old. Apps never see these streams; they see `.unique` and `.limits`.

## What one `app.do` does

1. **Load** the action's own stream (state and version), then each `.also` and `.reads` target in declaration order; each target function sees the streams loaded before it.
2. **Check every rule before anything is written.** The action's own preconditions see its state and every stream it loaded (`reads`, keyed by state name). Each `.also` action's preconditions see only its own state and payload, as if it were called directly: the rule stays in the aggregate that owns it.
3. **Fold** each action's events onto its state, and check each folded state against its schema.
4. **Commit once,** `commit(writes)`, with each stream's expected version set to the version it had **when it was loaded**. A `.reads` stream is an empty write: a version check only.
5. **The store checks every version in one atomic step.** If any stream moved since its load, nothing is written and the commit throws `ConcurrencyError`; `maxRetries` reruns the sequence from step 1 with fresh loads. An explicit `expectedVersion` from the caller applies to the action's own stream and is never retried.

No rule decides on stale context: every fact a rule read is unchanged at commit time, or nothing commits. A load served from the cache is safe for the same reason; a cached version that's behind fails the check, and the retry reloads.

## Public surface

### `Store` port (breaking for adapters; 2.0)

- `commit(writes, meta)` replaces `commit(stream, msgs, meta, expectedVersion?)`. `writes` is `readonly { stream: string; msgs: Message[]; expectedVersion?: number }[]`, each stream at most once. All writes land or none do; each `expectedVersion` is checked against its own stream, and a stale one throws `ConcurrencyError` naming that stream. A write with no messages is a version check only (`.reads`). It returns the committed events of every write, in order.
- Adapters do the inserts for several streams inside the transaction they already open; the existing unique `(stream, version)` index catches a race on any of them. No new table, column or index.
- The TCK: all-or-nothing on a failure in any write; each stream's version checked; an empty write guards without writing; a stream named twice is refused; two connections racing on one shared stream, of which exactly one wins.

### Builders (additive)

- **`.also(State, action, target)`** on the action chain of `state` and `slice`, between `.on(...)` and `.requires(...)`; it can repeat. `target(payload, state, reads)` returns `{ stream, payload }` for that state's action. The other action's preconditions run, its events commit in the same step, and its stream is guarded by its version.
- **`.reads(State, target)`**: `target(payload, state, reads)` returns a stream id, guarded by its version without a write.
- **`reads`**: every stream the action loaded, through `.reads` or `.also`, keyed by state name and typed from each state, reaches the action's own preconditions as a fourth argument and `.emit` on its second (`{ state, reads }`).
- Targets resolve in declaration order, and each sees the states loaded before it, so a rule can follow a reference (a loan's copy, then the copy's borrower).
- **`.unique(field, options?)`** and **`.limits(field, max, options?)`** on `state(...)`. `max` is a number or `(value) => number`. `.unique(f)` is `.limits(f, 1)` with its own message (`"<State>.<field> is unique"`, `"<State>.<field> is limited to <max>"`).
- **`UniqueOptions`**, for both: `while?: (state) => boolean` (a stream holds its value only while true), `normalize?: (value) => string` (case, whitespace), `onClose?: "release" | "keep"` and `onForget?: "release" | "keep"` (whether closing or forgetting a stream frees its value or keeps it taken; `"release"` by default).

### `app.do`, lifecycle events, errors

`app.do` returns the snapshots of every stream it wrote, its own first. `committed` carries them all; a state-scoped `committed` listener hears its state's. No new error or event name: refusals are `PreconditionError` (naming the action whose rule failed) and races are `ConcurrencyError`.

## Scenarios

Each ships as a test; the starred ones also as a recipe or in an example app.

| Scenario | The action also… |
|---|---|
| ★ User email: register, change (release old, take new), deactivate (`while`), erase (`onForget`) | takes the new value and frees the old (`.unique`) |
| Vehicle plate never reissued | keeps the value taken after close (`onClose: "keep"`) |
| ★ Course capacity, student max courses | `takeSeat` on `course-c1`; at most 5 courses per student (`.limits`) |
| Sessions per user, released on timeout | at most 3 per user (`.limits`); a deferred reaction frees one on timeout |
| ★ Wolfdesk: 5 open tickets per agent | at most 5 per agent with `while: open`; a reassign frees one agent's slot and takes another's in one commit |
| ★ Room booking, no overlap | `reserve` on `room-r1`, whose precondition is "no overlap" |
| Invoice payments | `applyPayment` on `invoice-i`, whose precondition is "not over the amount" |
| ★ Inventory | `reserveStock` on the product's stream; a deferred reaction releases expired holds |
| Money transfer | `debit` on `account-a` and `credit` on `account-b`, three streams in one commit |
| Gapless invoice numbers | `next` on an `invoices` counter stream |
| Idempotency or opt-in token; one review per customer per product | `.unique` on the token, or on the customer and product together |
| Library loans | the borrower's stream comes from the copy's loaded state |
| Bike rental, displayed price | `.reads` only |

## Trade-offs

- **Two events for one fact.** `Enrolled` and `SeatTaken` record one enrollment twice, and a projection must count one of them. It keeps the store to plain version checks, and every state an aggregate that owns its events. `.unique` and `.limits` keep their own events out of sight.
- **Hot streams serialize.** Every enrollment in one course goes through `course-c1`; every invoice through the counter. Any design that enforces "at most 30" or "no gaps" strongly pays this. A rule with no natural key ("total spend across all departments") needs one global stream. Splitting a hot resource across several streams is a recipe, not 2.0 surface.
- **A rule added to existing data** needs its value streams filled from current state once. An operator recipe ships with `.unique`.
- **Explicit coupling.** `Enrollment` names `Seats`' action and payload. The build checks it, and the diagram and CLI show it as an edge.
- **One store.** A commit is atomic only inside one store: `.also` and `.reads` to a state of another scoped Act throw at build. Hash partitions of one Postgres database are one store.
- **Not for the outside world.** A step that waits on an external confirmation (a payment gateway) stays a reaction-driven process.

## Objections considered

- **"Modify one aggregate per transaction"** ([Vernon](https://www.dddcommunity.org/wp-content/uploads/files/pdf_articles/Vernon_2011_2.pdf)): its reasons are distributed transactions when aggregates live in different stores, contention, and coupling. An Act app's streams share one store (the cross-store case is refused), the contention is the rule's own, and the coupling is declared. Vernon calls it a rule of thumb, and the `eventsourcing` library argues DDD always permitted a wider transaction ([docs](https://eventsourcing.readthedocs.io/en/latest/_sources/topics/examples/dcb-enrolment-introduction.rst.txt)). Reactions remain the tool where the business accepts compensation.
- **Tag-based DCB is more general.** It is, and it pushes domain semantics into the store's queries; the multi-stream optimistic-concurrency approach keeps the store to version checks ([Zenodo](https://zenodo.org/records/21157057)). Every scenario above is expressible with streams.
- **Deadlocks and lock time.** Loads hold no locks, so a conflict is a retry, never a deadlock. act-pg already serializes commits under one advisory lock; a multi-stream commit does a few more inserts inside it, and a real-adapter bench must show plain actions don't slow down.
- **"It removes the need for sagas"** (vendor material): only for decisions inside one store.

## How it meets every other feature

- **The decider rule.** Every stream loads before the fold; each action's preconditions run on its own loaded state; all folds happen before the store assigns ids. One commit.
- **Cache and snapshots.** Each stream is cached and snapshotted as today. The framework's value streams don't snapshot.
- **Close, windowed close, archives.** Each stream's lifecycle is its own; closing a stream frees or keeps its values as `onClose` says, by adding the release to each value's stream in the same close. The framework's value streams are never autoclosed.
- **`forget` and sensitive fields.** A value stream's id carries the value, so `.unique` on a sensitive field uses a keyed hash of it in the id (#2258), and `forget` frees or keeps it as `onForget` says.
- **Reactions, lanes, defer.** Every committed event is correlated as today; a reaction's `app.do` can `.also` too.
- **Partial states.** `.also` and `.reads` belong to their action; `.unique` and `.limits` survive the merge like other state policies (contract row 269).
- **Time travel.** `load(..., { asOf })` never runs `.also` or `.reads`.
- **Tooling.** The CLI, the diagram and the flow player show each `.also` and `.reads` as an edge between states, and `.unique`/`.limits` beside the preconditions.

## Teaching it

The feature is only as good as the scenarios people can find and run. Every scenario in the table ships in four places:

- **The guide:** `docs/docs/guides/rules-across-streams.md`, a catalog: one short section per scenario with the rule in plain words, the builder code, what a race does, and which trade-off it pays. It links the alternatives (reactions with compensation, sagas) for when strong consistency isn't worth it.
- **Flow animations** (`animate-act-flows`, `docs/flows/*.flow.json`): one map of the scenarios, with flows that play a commit landing in two streams at once, a refusal from the other state's rule, and a lost race being retried. Published with the docs.
- **An example app:** a new `packages/rules` (beside the existing examples, which stay as they are), with every scenario as a state and its tests. Wolfdesk gains the open-tickets-per-agent limit, added, not rewritten.
- **Recipes:** filling the value streams for a rule added to existing data, and splitting a hot resource across several streams.

The scaffold skill generates `.unique`, `.limits` and `.also` when a spec states uniqueness, capacity or a rule across entities, and the behavior-contract page gets a row for every runtime guarantee here.

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

**Core (`.also`, `.reads`):**
- a target that is the action's own stream, or two targets naming one stream, throws (at build when static, at the call when not);
- a target function that throws commits nothing;
- the other action's rule refuses with `PreconditionError` naming it, and the action's own stream is untouched;
- the other action emits nothing; the action itself emits nothing; both emit nothing (nothing commits, no `committed`);
- a race on any stream is a `ConcurrencyError` retried by the outer action's `maxRetries`, reloading every stream; an explicit `expectedVersion` on the outer target is never retried;
- chained targets see earlier loads, including a stream that doesn't exist yet;
- a target into a closed stream refuses the whole commit;
- each folded state passes its schema check, or the commit is refused;
- the other stream loads with the same actor, so its sensitive fields are gated as the caller's would be, and the state check's marker rule applies to it;
- every written stream's cache entry is updated; a lost race drops the stale ones;
- `app.do` returns every stream's snapshots, own first; `committed` carries them all; a state-scoped listener hears only its own; every written stream's reactions wake;
- a reaction's `app.do` with `.also` carries `reactingTo`, correlation and causation onto every event;
- a target in another scoped Act's store throws at build;
- partial states and slices keep `.also`/`.reads` on the action that declared them.

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

- **Tag-based DCB** (tags on events, a commit condition over a tag query). Merged first in this RFC (#2252) and replaced: it adds tags or data indexes to every adapter, conditions the store must evaluate, and "decision models" that fold events other states own, with special rules for their cache, snapshots and deleted events.
- **Links** (one event filed in several streams through a link table). A new table, and deletion rules for events that live in more than one stream.
- **Reservation streams on today's port.** The same value streams, written in a second commit: a crash between the two leaves a value taken by no one.
- **Sagas and process managers.** Eventually consistent; they stay the answer for steps outside the store.
- **A larger aggregate** (Course holds every enrollment). Serializes everything about the course, not only the seat count.
- **A unique index on a projection table.** Eventual and outside the store.
- **Do nothing.**

## Stability / charter impact

- **Breaking, for adapters and direct `Store` callers:** `commit(writes, meta)`. A migration note shows the one-write form; the TCK shows what an adapter adds. Ships in 2.0 with a `BREAKING CHANGE:` footer.
- **Additive, for apps:** `.also`, `.reads`, `.unique`, `.limits`, `UniqueOptions`. An app that uses none of them behaves as today.

## Open questions

0. **Names.** Every new name here is a placeholder until it reads intuitively in a chain:
   - running another state's action in the same commit: `.also` ("on enroll, also take a seat"), `.with`, `.and`, `.together`;
   - guarding a stream without writing: `.reads`, `.checks`, `.sees`, `.consults`;
   - at most N holders per value: `.limits`, `.atMost` (it pairs with `.unique`), `.capacity`.

   The tickets use the placeholders.

1. **The hash key for sensitive values** (#2258): an `ActOptions` field or act-crypto's key provider, and how it rotates without freeing every value.
2. **Hot-resource splitting**: a recipe in 2.0; does `.limits` ever need a sharded form?
