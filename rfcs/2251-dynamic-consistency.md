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

Dynamic Consistency Boundaries ([DCB](https://dcb.events/specification/), Pellegrini and Savic, 2024) solve this in the store. Events carry tags. A decision reads the events matching a query of types and tags, remembers the last position it saw, and appends with a condition: refuse if any event matching that query landed after that position. Axon Framework 5 and Axon Server implement it ([AxonIQ](https://www.axoniq.io/blog/dcb-in-af-5)), and Marten supports it.

What Act adds is the part those frameworks leave to the developer. In Act an app's rules read as plain terms in its builders (`.requires`, `.defer`, `.autocloses`). So DCB comes in three layers, the way `.defer(when)` is declarative sugar over `DeferSignal`:

1. **The store primitive.** Tags on events, and the conditional append, on the `Store` port.
2. **One general clause.** `.reads(...)` on an action: a view folded over the events whose tags match, given to the preconditions and the handler, and guarding the commit.
3. **Declarative terms built on `.reads`.** `.unique("email")` and `.limits("course", 30)` on a state: the rules apps actually state, in their own words.

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

A second `register` with a taken email is refused with `PreconditionError` ("User.email is unique"). Two racing registrations of the same email can't both commit: the second one's append fails its condition, and the action's `maxRetries` loop re-reads and refuses it.

## Vocabulary

One term per thing, the same in the builder, the types, the store, the tools and the docs:

| Thing | Name |
|---|---|
| a label on a committed event | **tag**, a `key` and a `value` (`course: "c1"`) |
| the event-field marker that makes a tag | `tag(zodType)`, like `sensitive(zodType)` |
| an action's cross-stream view | **view**, declared with `.reads({ ... })` |
| the store's refusal rule | **condition**: a tag query and an `after` position |
| a stream holding a value under `.unique`/`.limits` | **claim**; moving off it is a **release** |
| a lost race on a condition | `ConcurrencyError`, as for a stream version |
| a value already claimed / a full limit | `PreconditionError`, as for any failed rule |
| never used for this | "boundary" in the API (it stays in the docs as the DCB term), "lock", "reservation" |

## Public surface added

### `Store` port (breaking for adapters; 2.0)

- `Message` gains `tags?: Readonly<Record<string, string>>`; `Committed` gains `tags`, always present (`{}` when none).
- `Query` gains `tags?: Readonly<Record<string, string>>`: match events that carry every given tag. It combines with `names`, so a query is "these event names, with all these tags", one DCB query item. Several items (DCB's OR) are an array: `Query.any?: readonly TagQuery[]`. Open question 3.
- `commit(stream, msgs, meta, expectedVersion?, condition?)` gains `condition?: { query: TagQuery | TagQuery[]; after: number }`. The commit fails with `ConcurrencyError` if any stored event matching `query` has an id greater than `after`. The stream's own `expectedVersion` check is unchanged and runs too. Both checks and the append are one atomic step.
- Every adapter stores tags and indexes them for this query. The TCK gets a `condition` block: refusal on a match after `after`, no refusal at or before it, AND within an item, OR across items, a conditional append racing another in a second connection (exactly one wins), and tags round-tripping on `query`.

### Builders (additive)

- **`tag(zodType)`** (export, beside `sensitive`): marks an event field as a tag. A committed event's tags are its marked fields' values: `Enrolled: z.object({ course: tag(z.string()), student: tag(z.string()) })`. Only string, number and enum fields can be tagged; anything else throws at build.
- **`.reads(views)`** on the action chain, between `.on(...)` and `.requires(...)`:
  ```ts
  .on({ enroll: z.object({ course: z.string() }) })
  .reads({
    seats: {
      where: (p) => ({ course: p.course }),   // the tags to match
      events: ["Enrolled", "Left"],            // the names to match
      init: () => 0,
      patch: { Enrolled: (n) => n + 1, Left: (n) => n - 1 },
    },
  })
  .requires([{ description: "the course has a free seat", holds: (_p, _s, _a, { seats }) => seats < 30 }])
  .emit((p) => ["Enrolled", p])
  ```
  Each view folds the matching events across all streams. Preconditions get the views as a fourth argument and the `.emit` handler gets them on its second argument (`{ state, views }`). The commit carries the views' condition with `after` set to the last event id read. A lost race throws `ConcurrencyError`, which the action's existing `maxRetries` loop retries with fresh views. The action still commits to its own stream.
- **`.unique(field)`** on `state(...)`: no two streams of this state hold the same value in `field`. It compiles to: a hidden tag on each event whose fold sets the field (a claim of the new value) or moves it off a value (a release of the old one); a view on every action of the state; and a precondition `"<State>.<field> is unique"`.
- **`.limits(field, max)`** on `state(...)`: at most `max` streams of this state hold the same value in `field`. `max` is a number or `(value) => number`. `.unique(f)` is `.limits(f, 1)` with its own name and message.

### Lifecycle events, `IAct`

None. Refusals use `PreconditionError` and `ConcurrencyError`; act-http already maps both (409, 412).

## How it meets every other feature

The simplify runs keep finding bugs where two features meet by special case. Each meeting is decided here, before any code:

- **The decider rule (one fold before the commit).** Views are folded with the stream's own fold, before the store assigns ids. Claims and releases come from that fold's old and new values of the field, so they never read store-assigned values.
- **Cache and snapshots.** A view is not cached in the first release; it's re-read for each action. An index makes that a small read, and a bench on act-pg and act-sqlite must show it. A stream's own snapshot is unchanged.
- **Close-the-books, windowed close and archives.** Claims are derived from state, so any event that stores state carries the state's claim tags: a `.snap()` snapshot, a restart's seed and a close tombstone. A windowed prune or an archive that deletes the claiming event therefore keeps the claim. Closing a stream without `restart` releases its claims.
- **`forget` and sensitive fields.** `tag(sensitive(...))` and `.unique` on a sensitive field would put the plaintext into a tag index that `forget` can't reach. The first release refuses both at build. They ship with the keyed hash in open question 1.
- **Reactions, lanes, priority, defer.** Tags don't change routing, leases or lanes. A reaction's `app.do` runs the same check, and a lost race reaches the reaction's retry and backoff as it does today (interaction register: "action retry, reaction retry").
- **Partial states.** `.unique` and `.limits` declared in any partial survive the merge, as other state policies do (contract row 269). Two partials declaring different limits on one field throw at build.
- **Scoped Acts and split stores.** A condition is checked inside one store, so uniqueness holds per store. The split-stores recipe says so.
- **Time travel.** `load(..., { asOf })` doesn't read views; an action never runs as of the past.
- **Tooling.** The CLI, the diagram and the flow player show `unique email`, `limits course to 30`, and each view, as they show preconditions.

## Alternatives considered

- **Reservation streams on today's port.** `.unique("email")` claims a stream `User.email:<value>` with `expectedVersion: -1`, then commits the user's event. No port change. Rejected: the two commits aren't atomic, so a crash between them leaves a claim with no owner and needs a sweeper; a release is a third write; and it can't express `.limits` or a general view.
- **Multi-stream atomic commit** (commit to several streams in one transaction, a version per stream). A simpler port change, but it only guards streams the action names up front. A capacity rule needs a count over streams nobody names in advance, which is what DCB's query does.
- **A unique index on a projection table.** Eventual and outside the store, so it races the commit, and nothing in the builder states the rule.
- **`.unique` as a precondition helper** (`requires([unique("email")])`). It reads well, but a precondition is per action, and uniqueness must hold for every action that changes the field, including ones added later. A state-level declaration can't be forgotten on a new action.
- **Do nothing; document the reservation pattern.** Keeps the most common rule out of the builders, which is the thing Act is for.

## Stability / charter impact

- **Breaking, for adapters:** `commit` gains `condition`, and every adapter must store, index and query tags. Third-party adapters fail the TCK until they do, so this ships in 2.0, with a migration note and a `BREAKING CHANGE:` footer. The in-tree adapters (InMemory, act-pg, act-sqlite) and the TCK change in the same milestone. act-pg and act-sqlite add the tag storage through `seed()`; there is no migration framework (#1140).
- **Additive, for apps:** `tag`, `.reads`, `.unique`, `.limits`, and the new optional fields on `Message`, `Committed` and `Query`. An app that uses none of them behaves exactly as today.
- **Lines and concepts:** three builder terms and one schema marker; no new error, event or `IAct` method.

## Open questions

1. **Sensitive tags.** A keyed hash (HMAC with a key the operator provides, like act-crypto's keys) makes an email unique without storing it. What does `forget` do to the hash: keep it (the value stays claimed), or drop it (the value is free again)?
2. **Names.** `.limits(field, max)` or `.capacity(field, max)`; `.reads(...)` or `.sees(...)`; `tag(...)` or `tagged(...)`.
3. **Several query items.** Does a view ever need DCB's OR of items, or is one `where` plus `events` per view enough, with several views on one action?
4. **Caching views.** Is a view cache worth its invalidation rules once the benches are in?
5. **Release on close.** Should a stream closed without `restart` keep its claims, so a closed account's email can't be reused?
