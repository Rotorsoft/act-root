# RFC 2251: Consistency across streams, with `unique` and `limits` as builder terms

- **Issue:** #2251
- **Author:** Claude, for rotorsoft
- **Created:** 2026-10-31
- **Ships in:** 2.0 (the `Store` port change is breaking for adapters)

## Motivation

An Act action decides inside one stream. It loads one state, checks its preconditions, folds the events it emits, and commits with a version guard on that stream. Nothing can see another stream at decision time, so a rule that spans streams can't be written as a rule:

- **uniqueness:** one account per email, one ticket per seat;
- **capacity:** at most 30 students in a course, at most three active sessions per user;
- **set rules:** a payment is accepted once per invoice, whichever stream records it.

Apps get these today only eventually. A reaction notices the duplicate and emits a compensating event (the pattern in [design decisions § Compensation](../docs/docs/architecture/design-decisions.md)), or a unique index lives outside the event store and races the commit. Both put the rule out of sight: the builder that should state it says nothing, and the CLI, the diagram and the flow animations can't show it.

Dynamic Consistency Boundaries ([DCB](https://dcb.events/specification/), Pellegrini and Savic, 2024) solve this in the store. A decision reads the events a query matches, folds them into a small decision model, remembers the last position it saw, and appends with a condition: refuse if any event matching that query landed after that position. Axon Framework 5 and Axon Server implement it ([AxonIQ](https://www.axoniq.io/blog/dcb-in-af-5)), and Marten supports it, building the decision model as a small guard aggregate from the query.

## The design: no new concepts

Act already has every concept DCB needs. A decision model is a **state**: an `init` and a fold (`patch`) over events. A gate is a **precondition**. A race is a **`ConcurrencyError`**, retried by the action's `maxRetries`. What's new is one thing: a state can be loaded from the events of many streams, matched by their data, instead of from one stream. On top of that come two declarative terms for the rules apps state most, the way `.defer(when)` is declarative sugar over `DeferSignal`.

1. **The store primitive.** A query can match events by fields of their `data`, and a commit can carry a condition built from such queries.
2. **`.reads(State, where)`** on an action: load that state from every event whose data matches `where`, give it to the preconditions and the handler, and guard the commit with it.
3. **`.unique("email")` and `.limits("course", 30)`** on a state: a hidden decision-model state plus a named precondition each.

```ts
// A decision model is a plain state with no actions of its own: it only folds.
const Seats = state({ Seats: z.object({ taken: z.number() }) })
  .init(() => ({ taken: 0 }))
  .emits({ Enrolled, Left }) // the same schema instances the Student uses
  .patch({
    Enrolled: (_, s) => ({ taken: s.taken + 1 }),
    Left: (_, s) => ({ taken: s.taken - 1 }),
  })
  .build();

const Student = state({ Student: StudentSchema })
  .init(() => ({ courses: [] }))
  .emits({ Enrolled, Left })
  .patch({ ... })
  .on({ enroll: z.object({ course: z.string() }) })
  .reads(Seats, (p) => ({ course: p.course })) // Seats, from every event whose data.course matches
  .requires([{
    description: "the course has a free seat",
    holds: (_p, _s, _a, { Seats }) => Seats.taken < 30,
  }])
  .emit((p) => ["Enrolled", p])
  .build();
```

The common rules don't need a hand-written decision model at all:

```ts
const User = state({ User: z.object({ email: z.string(), name: z.string() }) })
  .init(() => ({ email: "", name: "" }))
  .emits({ Registered, EmailChanged })
  .patch({
    Registered: ({ data }) => data,
    EmailChanged: ({ data }) => ({ email: data.email }),
  })
  .unique("email") // no two Users hold the same email
  .on({ register: Registered })
  .emit((p) => ["Registered", p])
  .on({ changeEmail: EmailChanged })
  .emit((p) => ["EmailChanged", p])
  .build();
```

A second `register` with a taken email is refused with `PreconditionError` ("User.email is unique"). Two racing registrations of the same email can't both commit: the second append fails its condition, and the action's `maxRetries` loop reloads the decision model and refuses it.

### Why a decision model feeds the preconditions

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
- `commit(stream, msgs, meta, expectedVersion?, condition?)` gains `condition?: { queries: readonly ConditionQuery[]; after: number }`, where `ConditionQuery` is `{ names: readonly string[]; where: Readonly<Record<...>> }`, one per decision model the action reads. The commit fails with `ConcurrencyError` if any stored event matching any query has an id greater than `after`. The stream's own `expectedVersion` check is unchanged and runs too. Both checks and the append are one atomic step.
- The TCK gets a `condition` block: refusal on a match after `after`, none at or before it, every `where` field must match, any query of a condition refuses, `where` on `query` returns the same events the condition checks, and two racing conditional appends from two connections, of which exactly one wins.

### Builders (additive)

- **`.reads(State, where)`** on the action chain of `state` and `slice`, between `.on(...)` and `.requires(...)`; it can repeat, one per decision model. `where(payload)` returns the data values to match. The loaded states reach preconditions as a fourth argument and the `.emit` handler on its second (`{ state, reads }`), keyed by state name and typed from each state.
- **`.unique(field, options?)`** on `state(...)`: no two streams of this state hold the same value in `field`.
- **`.limits(field, max, options?)`** on `state(...)`: at most `max` streams of this state hold the same value in `field`. `max` is a number or `(value) => number`. `.unique(f)` is `.limits(f, 1)` with its own name and message.
- **`ClaimOptions`** for both terms. A stream that holds a value under `.unique` or `.limits` has a **claim** on it; moving off the value is a **release**.
  - `onClose?: "release" | "keep"`: closing a stream without `restart` frees its claims (`"release"`, the default) or keeps them, so a closed account's email can't be reused.
  - `onForget?: "release" | "keep"`: `forget(stream)` frees the stream's claims (`"release"`, the default) or keeps them as a keyed hash, never as plaintext, for fraud and audit rules.

`.unique` and `.limits` compile to a hidden decision-model state over the state's own events, with a fold that counts the streams holding each value, a `.reads` on every action of the state that can change the field, and a precondition.

### Lifecycle events, `IAct`, errors

None new. Refusals are `PreconditionError` and `ConcurrencyError`; act-http already maps both (409, 412).

## How it meets every other feature

The simplify runs keep finding bugs where two features meet by special case. Each meeting is decided here, before any code:

- **The decider rule (one fold before the commit).** Decision models load before the action folds its own events; claims and releases come from that fold's old and new values of the field, so they never read store-assigned ids or times.
- **Cache.** A loaded decision model is cached like any state, under a key made of the state's name and its `where` values (`Seats|course=c1`), with the id of the last event it folded. The next action reads only the events after that id, which is the snapshot-plus-catch-up path a stream load already takes. That id is also the condition's `after`, so a stale entry can only lose a race, and `maxRetries` reloads it. One entry per value, bounded by the cache's own `maxSize`.
- **Close-the-books, windowed close and archives.** A claim lives in the events of the stream that holds it, and those events can be deleted. So any event that stores state carries the state's claims: a `.snap()` snapshot, a close `restart` seed and a close tombstone. A windowed prune or an archive below the claiming event keeps the claim. Closing without `restart` releases or keeps it as `onClose` says.
- **`forget` and sensitive fields.** A `where` on a sensitive field throws at build. `.unique` on one ships with the keyed hash in #2258, and `forget` releases or keeps as `onForget` says.
- **Reactions, lanes, priority, defer.** Decision models don't change routing, leases or lanes. A reaction's `app.do` runs the same check, and a lost race reaches the reaction's retry and backoff as it does today (interaction register: "action retry, reaction retry").
- **Partial states.** `.unique` and `.limits` declared in any partial survive the merge, as other state policies do (contract row 269). Two partials declaring different limits on one field throw at build.
- **Cross-slice event schemas.** A decision model folds events another state emits, so it must share their schema instances, as any two partials do today.
- **Scoped Acts and split stores.** A condition is checked inside one store, so uniqueness holds per store. The split-stores recipe says so.
- **Time travel.** `load(..., { asOf })` doesn't load decision models; an action never runs as of the past.
- **Tooling.** The CLI, the diagram and the flow player show `unique email`, `limits course to 30` and each `.reads`, as they show preconditions.

## Alternatives considered

- **Tags on events (the spec's shape)**, with a `tag()` marker like `sensitive()`. Rejected for the reasons in "Matching by data": a new concept on every event, and a decision model added later misses older events.
- **A new "view" builder** for decision models. Rejected: a state already is an `init` and a fold, and a second builder for the same thing is a second concept.
- **Reservation streams on today's port.** `.unique("email")` claims a stream `User.email:<value>` with `expectedVersion: -1`, then commits the user's event. No port change. Rejected: the two commits aren't atomic, so a crash between them leaves a claim with no owner and needs a sweeper; a release is a third write; and it can't express `.limits` or a general decision model.
- **Multi-stream atomic commit** (commit to several streams in one transaction, a version per stream). A simpler port change, but it only guards streams the action names up front. A capacity rule needs a count over streams nobody names in advance.
- **A unique index on a projection table.** Eventual and outside the store, so it races the commit, and nothing in the builder states the rule.
- **`.unique` as a precondition helper** (`requires([unique("email")])`). A precondition is per action, and uniqueness must hold for every action that changes the field, including ones added later. A state-level declaration can't be forgotten on a new action.
- **Do nothing; document the reservation pattern.** Keeps the most common rule out of the builders, which is the thing Act is for.

## Stability / charter impact

- **Breaking, for adapters:** `commit` gains `condition`, and `query` gains `where`; every adapter must match and index data fields. Third-party adapters fail the TCK until they do, so this ships in 2.0, with a migration note and a `BREAKING CHANGE:` footer. The in-tree adapters (InMemory, act-pg, act-sqlite) and the TCK change in the same milestone. act-pg and act-sqlite add their indexes through `seed()`; there is no migration framework (#1140).
- **Additive, for apps:** `.reads`, `.unique`, `.limits`, `ClaimOptions`, and the new optional fields on `Query`. An app that uses none of them behaves exactly as today.
- **Concepts:** none new for app authors beyond the three builder terms. No new export besides the `ClaimOptions` type, and no new error, event or `IAct` method.

## Decided

- Decision models are states, loaded from many streams by their data; there are no tags.
- Decision models are cached through the existing cache, with catch-up from the last id folded.
- `forget` and close each offer both behaviors, per declaration (`onForget`, `onClose`), defaulting to `"release"`.
- Names: `.reads`, `.unique`, `.limits`.
- One query item per query: a rule that needs two is two `.reads` on one action.

## Open questions

1. **The key for sensitive claims.** A keyed hash (HMAC) makes a sensitive email unique without storing it. Where does the key come from (an `ActOptions` field, or act-crypto's key provider), and how is it rotated without freeing every claim? Settled in #2258.
2. **SQLite's index.** An index expression per matched field needs to know the fields at `seed()` time; a scan by event name may be fast enough at SQLite's scale. Settled by #2254's benches.
