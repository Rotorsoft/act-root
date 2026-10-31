# RFC 2251: Consistency across streams, with `unique` and `limits` as builder terms

- **Issue:** #2251
- **Author:** Claude, for rotorsoft
- **Created:** 2026-10-31
- **Ships in:** 2.0 (the `Store` port change is breaking for adapters)

## Motivation

An Act action decides inside one stream. It loads one state, checks its preconditions, folds the events it emits, and commits with a version guard on that stream. Nothing can see another stream at decision time, so a rule that spans streams can't be written as a rule:

- **uniqueness:** one account per email, one plate per vehicle;
- **capacity:** at most 30 students in a course, three sessions per user, five open tickets per agent;
- **rules over many streams:** no two bookings of a room overlap; payments never exceed the invoice;
- **another aggregate's state:** an order reserves only what the product has in stock.

Apps get these today only eventually. A reaction notices the violation and emits a compensating event (the pattern in [design decisions § Compensation](../docs/docs/architecture/design-decisions.md)), or a unique index lives outside the event store and races the commit. Both put the rule out of sight: the builder that should state it says nothing, and the CLI, the diagram and the flow animations can't show it.

Dynamic Consistency Boundaries ([DCB](https://dcb.events/specification/), Pellegrini and Savic, 2024) solve this in the store. A decision reads the events a query matches, folds them into a small decision model, remembers the last position it saw, and appends with a condition: refuse if any event matching that query landed after that position. Axon Framework 5 and Axon Server implement it ([AxonIQ](https://www.axoniq.io/blog/dcb-in-af-5)), and Marten supports it, building the decision model as a small guard aggregate from the query.

## The design: no new concepts

Act already has every concept DCB needs. A decision model is a **state**: an `init` and a fold (`patch`). A gate is a **precondition**. A race is a **`ConcurrencyError`**, retried by the action's `maxRetries`. What's new is that an action can load, besides its own stream, more states from other **sources**, and that its commit is guarded by all of them:

1. **The store primitive.** A query can match events by fields of their `data`, and a commit can carry a condition built from such queries.
2. **`.reads(State, source)`** on an action. The source is a stream id (another aggregate, read as is) or a `where` (a decision model folded from every event whose data matches). The loaded states go to the preconditions and the handler, and each one guards the commit.
3. **`.unique("email")` and `.limits("course", 30)`** on a state: a hidden decision model plus a named precondition each, the way `.defer(when)` is declarative sugar over `DeferSignal`.

```ts
// A decision model is a plain state with no actions of its own: it only folds.
const Seats = state({ Seats: z.object({ taken: z.number() }) })
  .init(() => ({ taken: 0 }))
  .emits({ Enrolled, Left }) // the same schema instances the Enrollment uses
  .patch({
    Enrolled: (_, s) => ({ taken: s.taken + 1 }),
    Left: (_, s) => ({ taken: s.taken - 1 }),
  })
  .build();

const Enrollment = state({ Enrollment: EnrollmentSchema })
  .init(() => ({ course: "", active: false }))
  .emits({ Enrolled, Left })
  .patch({ ... })
  .on({ enroll: z.object({ course: z.string(), capacity: z.number() }) })
  .reads(Seats, (p) => ({ course: p.course })) // from every event whose data.course matches
  .requires([{
    description: "the course has a free seat",
    holds: (p, _s, _a, { Seats }) => Seats.taken < p.capacity,
  }])
  .emit((p) => ["Enrolled", { course: p.course }])
  .build();
```

The common rules need no hand-written decision model:

```ts
const User = state({ User: z.object({ email: z.string(), active: z.boolean() }) })
  .init(() => ({ email: "", active: false }))
  .emits({ Registered, EmailChanged, Deactivated })
  .patch({ ... })
  .unique("email", { while: (s) => s.active }) // no two active Users share an email
  .on({ register: Registered })
  .emit((p) => ["Registered", p])
  .on({ changeEmail: EmailChanged })
  .emit((p) => ["EmailChanged", p])
  .build();
```

A second `register` with a taken email is refused with `PreconditionError` ("User.email is unique"). Two racing registrations of the same email can't both commit: the second append fails its condition, and the action's `maxRetries` loop reloads and refuses it.

### One fold, two sources

Loading a state is already almost source-agnostic: `load` folds events onto `init`, caches the result with the id of the last event folded, and on a warm load reads only the events after it. So the fold is generalized, not copied:

| | Stream source (today, and `.reads(State, id)`) | Query source (`.reads(State, where)`) |
|---|---|---|
| Reads | the events of one stream | the events whose `data` matches `where`, across streams |
| Cache key | the stream id | a reserved key, `__reads__:<State>:<where>` |
| Catch-up | after the cached last id | the same |
| Guards the commit with | the stream's version | a condition: no matching event after the last id |
| Snapshots, tombstones, close, archive | yes | no (see below) |
| Owns its events | yes | no: it folds events other states own |

The action's own stream keeps `expectedVersion`. A `.reads` by stream id is guarded by that stream's position, and a `.reads` by `where` by its query. At the store, a version check and a condition are separate checks in one atomic step: a version check is an index hit, a condition is a query, and the hot path for plain actions stays as fast as today.

### A decision model has no stream

A decision model is always its own state. It folds events other aggregates own, for one rule: in every scenario below, the state that expands the boundary is semantically different from the aggregates whose events it reads. So everything in Act that assumes a state has a stream is decided here:

- **Ownership.** An event belongs to one state; registering a second state that declares it throws `Duplicate event`. A decision model is passed only to `.reads`, never to `withState`. The build checks that every event it folds exists in the app with the same schema instance (the cross-slice rule).
- **Loading.** `app.load` loads registered states by stream. A decision model isn't registered, so nothing loads it by a stream id; only `.reads` loads it, by its `where`.
- **Snapshots.** `.snap()` writes a snapshot into the state's stream, and a decision model has none: `.snap()` on a state used in a `where` read throws at build. The cache is its only shortcut.
- **Version.** A decision model has no version. Its position is the last id folded, which is the condition's `after`.
- **Deleted events.** Close, a windowed prune, an archive and a restart delete events, and a decision model that folded them can't be rebuilt from what's left:
  - an explicit close of a stream removes its events from every decision model that folds them (they read as released), and drops those models' cache entries;
  - a windowed prune or `.archives` on a state whose events a `where` read folds throws at build;
  - `.unique` and `.limits` are exempt, because the framework writes their claims onto every event that stores state (below).

### Why the loaded states feed the preconditions

Every DCB implementation reads, folds into a decision model, decides, and appends with the condition. Marten builds the model as a small guard aggregate from a tag query (`FetchForWritingByTags`) and the handler checks it; Axon Framework 5 hands the handler an entity loaded by tag criteria. In both, the check is code inside the handler. Act keeps the same decision model and applies its own convention (RFC 2086): a rule that refuses an action is a named precondition, so the CLI, the diagram and the flow player can show it. The `.emit` handler gets the loaded states too, for code that only needs the data.

### Matching by data, not tags

The DCB spec matches on tags stored beside each event. Act matches on the event's own `data` fields instead (`{ course: "c1" }`):

- **Nothing to declare on events.** No tag marker, no tag list, no tag column.
- **A decision model added later sees old events.** With tags, events committed before a tag existed are invisible to it until backfilled.
- **The cost is in the adapters:** they index data fields (a jsonb containment index in Postgres; in SQLite an index expression or a scan), and #2254's benches decide which.
- **Sensitive fields can't be matched.** They live in `pii`, not `data`, so a `where` on one throws at build. `.unique` on a sensitive field uses a keyed hash the framework stores where it controls it (#2258).

## Public surface added

### `Store` port (breaking for adapters; 2.0)

- `Query` gains `where?: Readonly<Record<string, string | number | boolean>>`: match events whose `data` has every given field equal to the given value. It combines with `names`, so a query is "these event names, with these data values": one DCB query item.
- `commit(stream, msgs, meta, expectedVersion?, condition?)` gains `condition?: { queries: readonly ConditionQuery[]; after: number }`. A `ConditionQuery` is `{ stream: string }` (a `.reads` by stream id) or `{ names: readonly string[]; where: Readonly<Record<...>> }` (a `.reads` by `where`). The commit fails with `ConcurrencyError` if any stored event matching any query has an id greater than `after`. The stream's own `expectedVersion` check is unchanged and runs too. Both checks and the append are one atomic step.
- The TCK gets a `condition` block: refusal on a match after `after`, none at or before it, every `where` field must match, any query of a condition refuses, a stream query guards that stream, `query({ names, where })` returns exactly the events the condition checks, sensitive fields never match, and two racing conditional appends from two connections, of which exactly one wins.

### Builders (additive)

- **`.reads(State, source)`** on the action chain of `state` and `slice`, between `.on(...)` and `.requires(...)`; it can repeat. `source(payload)` returns a stream id (a registered aggregate, read as is) or a `where` object (a decision model, never registered). The loaded states reach preconditions as a fourth argument and the `.emit` handler on its second (`{ state, reads }`), keyed by state name and typed from each state.
- **`.unique(field, options?)`** on `state(...)`: no two streams of this state hold the same value in `field`.
- **`.limits(field, max, options?)`** on `state(...)`: at most `max` streams of this state hold the same value in `field`. `max` is a number or `(value) => number`. `.unique(f)` is `.limits(f, 1)` with its own name and message.
- **`ClaimOptions`** for both terms. A stream holding a value has a **claim** on it; moving off the value, or leaving the `while` condition, is a **release**.
  - `while?: (state) => boolean`: the claim is held only while this is true (an open ticket, an active user). Without it, a stream holds a claim on any value the field has.
  - `onClose?: "release" | "keep"`: closing a stream without `restart` frees its claims (`"release"`, the default) or keeps them, so a scrapped vehicle's plate is never reissued.
  - `onForget?: "release" | "keep"`: `forget(stream)` frees the stream's claims (`"release"`, the default) or keeps them as a keyed hash, never as plaintext, for fraud and audit rules.

`.unique` and `.limits` compile to a hidden decision model over the state's own events, counting the streams that hold each value while `while` holds, a `where` read on every action of the state that can change the field or the `while` result, and a precondition (`"<State>.<field> is unique"`, `"<State>.<field> is limited to <max>"`). Because the framework writes the claims, it also writes them onto every event that stores state: a `.snap()` snapshot, a close `restart` seed and a close tombstone. A windowed prune or an archive below the claiming event keeps the claim.

### Lifecycle events, `IAct`, errors

None new. Refusals are `PreconditionError` and `ConcurrencyError`; act-http already maps both (409, 412).

## Scenarios

Every term ships proven by these, each as a test; the starred ones also as a recipe or in an example app.

| Term | Scenario | Proves |
|---|---|---|
| `.unique` | ★ **User email:** register, change email (releases the old), deactivate (`while`), erase (`onForget: "release"`) | the claim, release on change and on `while`, erasure |
| `.unique` | **Vehicle plate:** a scrapped vehicle's plate is never reissued (`onClose: "keep"`) | keep on close |
| `.limits` | ★ **Course capacity:** `Enrollment` per student and course, `.limits("course", 30)` and `.limits("student", 5)` | two limits on one state, the race for the last seat |
| `.limits` | **Concurrent sessions:** `Session.limits("user", 3)`, logout closes the stream (`onClose: "release"`) | release on close |
| `.limits` | ★ **Wolfdesk:** an agent holds at most 5 open tickets, `Ticket.limits("agent", 5, { while: (t) => t.open })`, added to the app | an in-repo app; a field that changes over the stream's life |
| `.reads` by `where` | ★ **Room booking:** `Bookings` folds a room's intervals; "no overlap" | a rule that isn't a count |
| `.reads` by `where` | **Invoice payments:** `Paid` sums payments `where invoice = i`; "doesn't exceed the amount" | a sum |
| `.reads` by stream | ★ **Inventory:** `Order.reserveItem` reads `Product` by stream for its stock, plus a `Reserved` decision model | an aggregate as input; two reads on one action |
| `.reads` by `where` | **Money transfer:** a balance from debits `where from = a` and credits `where to = a` | two reads for one rule |

## How it meets every other feature

The simplify runs keep finding bugs where two features meet by special case. Each meeting is decided here, before any code:

- **The decider rule (one fold before the commit).** Every `.reads` loads before the action folds its own events. Claims and releases come from that fold's old and new values of the field and the `while` result, so they never read store-assigned ids or times.
- **Cache.** A loaded decision model is cached like any state, under its reserved key, with the last id folded; the next action catches up from it. That id is also the condition's `after`, so a stale entry can only lose a race, which `maxRetries` reloads. Entries are bounded by the cache's own `maxSize`.
- **Close-the-books, windowed close and archives.** Decided in "A decision model has no stream" and in the claims paragraph above.
- **`forget` and sensitive fields.** A `where` on a sensitive field throws at build. `.unique` on one ships with the keyed hash in #2258, and `forget` releases or keeps as `onForget` says.
- **Reactions, lanes, priority, defer.** `.reads` doesn't change routing, leases or lanes. A reaction's `app.do` runs the same checks, and a lost race reaches the reaction's retry and backoff as it does today (interaction register: "action retry, reaction retry").
- **Partial states.** `.unique` and `.limits` declared in any partial survive the merge, as other state policies do (contract row 269). Two partials declaring different limits on one field throw at build.
- **Scoped Acts and split stores.** A condition is checked inside one store, so uniqueness holds per store, and a `.reads` by stream must name a stream in the same store. The split-stores recipe says so.
- **Time travel.** `load(..., { asOf })` doesn't run `.reads`; an action never runs as of the past.
- **Tooling.** The CLI, the diagram and the flow player show `unique email`, `limits course to 30` and each `.reads`, as they show preconditions.

## Alternatives considered

- **Tags on events (the spec's shape)**, with a `tag()` marker like `sensitive()`. Rejected for the reasons in "Matching by data": a new concept on every event, and a decision model added later misses older events.
- **A new "view" builder** for decision models. Rejected: a state already is an `init` and a fold, and a second builder for the same thing is a second concept.
- **One state as both aggregate and decision model.** No scenario needs it: the state that expands a boundary always folds events other aggregates own, and event ownership forbids it anyway. An aggregate needed as is reads by stream id.
- **Several query items per read (DCB's OR).** The money transfer is the case for it. Two reads express it; revisit if that reads badly in the docs.
- **Reservation streams on today's port.** `.unique("email")` claims a stream `User.email:<value>` with `expectedVersion: -1`, then commits the user's event. No port change. Rejected: the two commits aren't atomic, so a crash between them leaves a claim with no owner and needs a sweeper; a release is a third write; and it can't express `.limits` or a general decision model.
- **Multi-stream atomic commit** (commit to several streams in one transaction, a version per stream). A simpler port change, but it only guards streams the action names up front. A capacity rule needs a count over streams nobody names in advance.
- **A unique index on a projection table.** Eventual and outside the store, so it races the commit, and nothing in the builder states the rule.
- **`.unique` as a precondition helper** (`requires([unique("email")])`). A precondition is per action, and uniqueness must hold for every action that changes the field, including ones added later. A state-level declaration can't be forgotten on a new action.
- **Do nothing; document the reservation pattern.** Keeps the most common rule out of the builders, which is the thing Act is for.

## Stability / charter impact

- **Breaking, for adapters:** `commit` gains `condition`, and `query` gains `where`; every adapter must match and index data fields. Third-party adapters fail the TCK until they do, so this ships in 2.0, with a migration note and a `BREAKING CHANGE:` footer. The in-tree adapters (InMemory, act-pg, act-sqlite) and the TCK change in the same milestone. act-pg and act-sqlite add their indexes through `seed()`; there is no migration framework (#1140).
- **Additive, for apps:** `.reads`, `.unique`, `.limits`, `ClaimOptions`, and the new optional field on `Query`. An app that uses none of them behaves exactly as today, and plain stream actions keep today's speed (a real-adapter bench proves it).
- **Concepts:** none new for app authors beyond the three builder terms. No new export besides the `ClaimOptions` type, and no new error, event or `IAct` method.
- **File budget:** generalizing `load` and `action()` grows `event-sourcing.ts`, already past 300 lines; the PR that does it justifies the size or moves the source handling into its own internal module.

## Decided

- Decision models are states, loaded across streams by their data; there are no tags. A decision model is never registered and never loaded by stream.
- `.reads` takes a stream id or a `where`; both share one fold, and the source picks the guard.
- Decision models are cached through the existing cache, with catch-up from the last id folded.
- Claims are held `while` a predicate is true; close and forget each release or keep, per declaration (`onClose`, `onForget`, `"release"` by default).
- Names: `.reads`, `.unique`, `.limits`.
- One query item per query: a rule that needs two is two `.reads` on one action.

## Open questions

1. **The key for sensitive claims.** A keyed hash (HMAC) makes a sensitive email unique without storing it. Where does the key come from (an `ActOptions` field, or act-crypto's key provider), and how is it rotated without freeing every claim? Settled in #2258.
2. **SQLite's index.** An index expression per matched field needs to know the fields at `seed()` time; a scan by event name may be fast enough at SQLite's scale. Settled by #2254's benches.
