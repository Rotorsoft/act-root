# ACT-1128 — Unifying backup, restore, and cross-adapter transfer

ACT-1128 promised a UI for the offline restore primitive that ACT-1124 had landed. By the time the PR closed it had quietly subsumed two other features — backup (already shipping) and cross-adapter migration (#788, originally scoped as a separate ticket) — into one endpoint, one dialog, and one mental model. The diff is bigger than the original scope; the conceptual surface area is smaller. This essay is about how that compression happened, and the wrong turns along the way that named the shape it finally took.

---

**The pain that started it.**

The inspector had three separate destructive-or-near-destructive paths:

1. `backup` — query the events table, stream rows as CSV bytes, hand to the browser. Read-only against the store, but with no preview, no count cap, no escape audit.
2. `restore` — accept a CSV blob, parse it into `RestoreRow[]`, call `Store.restore`. Destructive, gated by a confirmation modal, but no dry-run, no progress, no compaction toggles. The original ACT-1124 ticket called out the UI as the follow-up, and the follow-up was this ticket.
3. Cross-adapter migration (#788) — the only paper design at the time. Move events from a PG store to a SQLite file (or vice versa) without round-tripping through CSV. Originally drafted as a third procedure with its own dialog.

Three procedures, three dialogs, three confirmation flows, three sets of error states. Each of them was, on closer reading, the same operation with different endpoint slots filled in: read from somewhere, optionally validate, optionally write somewhere else. The "somewhere"s differed (connected store, browser file, server-side file, per-call DB credentials) but the verb was identical.

---

**The first wrong turn: extending `Store.restore` with a generic source `T`.**

The first sketch tried to make `Store.restore` cover the transfer case directly: parameterize the source over whatever shape the adapter happened to want, and let the adapter handle parsing.

```ts
restore?<T>(source: T, parse: (row: T) => Committed): Promise<void>
```

That collapsed under the same test ACT-1124 had failed earlier in its life. Different sinks want different sources: a CSV writer wants strings, a PG sink wants typed Committed rows, a SQLite sink wants the same. The generic `T` would either land on the lowest common denominator (strings, with every adapter writing the same CSV parser inline) or force adapters to ship N parsers for N input formats. The parsing concern belongs *outside* the sink. The sink only needs typed events.

The shape that survived: a `EventSource` interface that exposes a `query` method returning a stream of typed events. The Store already had this (its existing `query` method). The CSV format gets its own implementation. The sink (`Store.restore`) consumes typed events regardless of where they came from.

---

**The second wrong turn: making `EventSource.query` return `AsyncIterable<Committed>`.**

The cleanest possible shape on paper. Every consumer can `for await` over the source. Backpressure is the iterator's problem. The framework's existing `query(callback)` would coexist as a separate API.

That has two costs that didn't survive contact with the adapters.

First, every adapter would need to ship an async-iterable variant of its query path in addition to the callback variant. PG would need either two separate cursor implementations or a shim that buffered the callback variant into an iterable (defeating the point). SQLite likewise. InMemory's `for (const ev of _events)` would need to become an `async function*` shape, slowing down test loops.

Second, the existing `query(callback)` is already on the public charter, called from `IAct.query`, `IAct.query_array`, the orchestrator's drain path, the inspector's `query`, and most adapters' internal projection paths. Adding a second method that does almost the same thing would either fragment the call sites or force a migration. Neither was worth the price.

The shape that won: keep the callback. Widen the *contract* on the callback without changing its declared type. TypeScript's "any return value is ignored when the type says `void`" rule means a callback declared `(event) => void` can return a `Promise<void>` at runtime and TypeScript won't complain at the call site. Adapters now wrap each callback invocation in `await Promise.resolve(callback(event))`. Sync callbacks resolve immediately (zero overhead in the benchmark — a `Promise.resolve` micro-task is cheaper than any of the work a sync `arr.push` would do). Async callbacks block the read loop until the consumer is ready. Backpressure for free, no type changes, no new method.

The consumer side of that contract — turning the now-async callback shape into an `AsyncIterable` for places that want one — became the `iterate` utility (`libs/act/src/internal/event-sourcing.ts`). One-slot mailbox: producer fills the slot, consumer drains it, the producer's callback returns a promise that the consumer resolves when it's ready to pull again. The test for `iterate` asserts the invariant directly — with a producer that emits five events and a consumer that records what's in the mailbox at each pull, the recorded sequence is `[2, 3, 4, 5, 5]` (not `[1, 2, 3, 4, 5]`) because the producer's microtask runs once before the consumer's body. The off-by-one isn't a bug; it's the proof that the mailbox is exactly one slot deep.

`iterate` is internal because it's a transport detail. `EventSource` is public because it's the contract.

---

**The third wrong turn: making `iterate` public.**

For about a day, `iterate` was exported from `@rotorsoft/act`. The reasoning: if anyone has a `Store` and wants to walk it as an async-iterable, why not? `iterate(store)` is a one-line convenience.

The reason not to: it's the only piece of the transfer pipeline that ever needs to construct an async iterable from an `EventSource`. The thing it feeds is `scan` (also internal), which is the only consumer. Promoting it to the public charter would charter-cover a transport detail that has no second caller, and would foreclose moving it inside the source-side iteration loop later if a cursor-based path (the eventual #814 / ACT-1132) makes the mailbox unnecessary. Demotion was the right call before any downstream call sites could pin it.

The user-driven version of this turn was crisper: "should iterate/transfer be inside event sourcing?" — yes, and the demotion followed naturally.

---

**The fourth wrong turn: a six-kind discriminated union per slot.**

The cross-adapter migration spec wanted: source = `current | csv | pg | sqlite`, target = `current | csv | pg | sqlite`. Add the browser-only kinds (`upload` for the source, `download` for the target), and each slot ends up with five legal kinds and one illegal cross-product. Sixteen combinations to enumerate as discriminated unions; six kinds × two slots = twelve TypeScript types in the inspector's tRPC schema; the dialog would need a 5-way radio, a 5-way radio, and a server-side guard against illegal pairs.

That's too many degrees of freedom for what the operator is actually trying to do. The user landed on a simpler mental model after a round of pushback on "kind" framing: there's the connected store (`current`), and there's everything else (a secondary endpoint that the operator describes via the same connection form they already know). The pair is always one of "current → secondary" (back up), "secondary → current" (restore), or "secondary → secondary" (transfer between two non-current endpoints, including CSV-to-CSV). The dialog reads as "pick a source, pick a target" — the destructive-or-not gradient falls out automatically: any target that isn't `current` leaves the connected store alone.

The asymmetry on browser-only kinds is real but small: `upload` only makes sense on the source side (the operator's browser is delivering bytes to the server), and `download` only makes sense on the target side (the server is producing bytes for the browser). The picker filters those out of the off-slot's radio. The server's Zod schema narrows further, but the picker already prevents the invalid selection at the source.

The single dialog also dissolved the question of confirmation modals — the dialog itself *is* the confirmation, with a dry-run button that runs the same code path against the same source and target as the destructive button without ever touching the sink. Operators see counts before committing. The old `restore` modal's "type CONFIRM to proceed" pattern was a workaround for the absence of a preview; with the preview, the friction has somewhere better to go.

---

**The fifth wrong turn: "ephemeral" as the word for per-call adapters.**

Both PG and SQLite endpoints in the transfer dialog let the operator enter credentials for a database that isn't the connected store. The first draft called these "ephemeral PG" / "ephemeral SQLite" — the adapter object lives for the duration of the call, then gets disposed. The user pushed back: PG and SQLite *are* persistent stores. Calling them ephemeral was confusing — what's ephemeral is the adapter *object*, not the data.

The fix is one of naming, not of design. The dialog calls them "PostgreSQL" and "SQLite" with the description "Connect to a different PostgreSQL database for this transfer only" / "Open a different SQLite file for this transfer only." The "for this transfer only" carries the per-call-adapter meaning without inventing a word for it.

The teachable thing: when a piece of the design surfaces in the UI, the word the user reads is part of the design. Internal terminology that leaks into operator-facing text without a translation step is its own kind of bug.

---

**The thing that shipped.**

Three public types in `libs/act/src/types/action.ts`:

```ts
interface EventSource extends Disposable {
  query<E>(callback: (event: Committed<E>) => void, query?: Query): Promise<number>;
}
interface EventSink extends Disposable {
  restore(driver: (callback: (event: Committed) => Promise<number>) => Promise<void>): Promise<void>;
}
```

A new shape on `IAct.restore`:

```ts
restore(source: EventSource, opts?: ScanOptions, sink?: EventSink): Promise<ScanResult>
```

A new utility class in `libs/act/src/csv.ts` — `CsvFile` — that implements both `EventSource` and `EventSink` so a CSV file can sit in either slot. Path mode (`new CsvFile({ path })`) and blob mode (`new CsvFile({ blob })`) cover the on-disk and in-memory cases respectively.

A demotion of `iterate` and `scan` to `libs/act/src/internal/event-sourcing.ts`, alongside `load`, `action`, `snap`, and `tombstone` — the orchestrator's primitives all live in one place.

A single tRPC mutation on the inspector — `transfer` — with a discriminated `source` and `target` schema covering five legal kinds per slot. The unified dialog handles every flow: backup (`current → download`), restore (`upload → current`), cross-adapter migration (`sqlite → pg`, `pg → csv`, etc.), CSV-to-CSV, and the diagonal case where source and target are both `current` (rejected with a self-transfer error). Dry-run is `{ dry_run: true }` against any source/target pair. A reactive progress bar reads `scan`'s `on_progress` callback via a tRPC SSE subscription — no polling. Smart radio disabling greys out `current` on either side when the opposite slot is `current` or when no store is connected, with tooltips that explain why.

Five test cases for the transfer endpoint cover the cross-product: same-store rejection, SQLite → CSV, CSV → SQLite round trip, dry-run, source-side errors. The framework tests for `iterate` and `CsvFile` live in `libs/act/test/csv.spec.ts`, including the `[2, 3, 4, 5, 5]` backpressure invariant.

---

**Parked directions.**

- **Cursor-based PG fetch** ([#814 / ACT-1132](https://github.com/Rotorsoft/act-root/issues/814)): the current PG `query` materializes the result set before invoking the callback, so the 1-slot mailbox saves the *consumer* memory but not the *producer's*. A cursor (PG `DECLARE … CURSOR`, fetch in batches) would make the producer streamable too. Filed as a perf follow-up; the mailbox already keeps a multi-million-event transfer's consumer cost flat, so the impact is on producer-side RSS, not on correctness.
- **`drop_closed_streams` / `drop_empty_streams`** (ACT-1125 placeholders): the `ScanResult.dropped` shape already carries the counters, so the additions are purely additive.
- **Lifecycle event for `restored`** (deferred from ACT-1124): still deferred. The unified transfer endpoint logs to the inspector's audit ring on the `current`-target path; cross-process observability isn't an ask yet.

---

**The mental model to leave behind.**

Three features that look different in the UI can be the same operation under the hood, and finding the verb they share is more valuable than building three sets of guardrails. Backup, restore, and cross-adapter migration are all `EventSource → EventSink` with one slot or both bound to specific kinds. The cost of unification was not type complexity (the discriminated unions for source and target are five lines each) but UI discovery — landing on a dialog shape that the operator could read without a manual. The "source / target" framing, with `current` as the connected-store endpoint and everything else as a secondary endpoint described by its connection fields, is the part that took the most iteration and the part the diff says nothing about.
