---
id: writing-a-store
title: Writing a custom Store adapter
---

# Writing a custom Store adapter

`Store` is the persistence port of the framework — every event log, lease table, projection watermark, and stream subscription lives behind it. The shipped adapters are `InMemoryStore`, `@rotorsoft/act-pg` (Postgres), and `@rotorsoft/act-sqlite` (libSQL). If you need another backend (MySQL, MongoDB, DynamoDB, EventStoreDB-as-Act-store, etc.), this guide walks through scaffolding one against the executable contract defined by `@rotorsoft/act-tck`.

## The contract

The interface lives in [`libs/act/src/types/ports.ts`](https://github.com/Rotorsoft/act-root/blob/master/libs/act/src/types/ports.ts):

- `seed()` / `drop()` — initialization and teardown
- `commit(stream, msgs, meta, expectedVersion?)` — append events atomically with optimistic concurrency. Map a `(stream, version)` unique-constraint violation to `ConcurrencyError` (Postgres keys off SQLSTATE `23505`, SQLite off its unique-constraint message) and wrap every other driver error in `StoreError('commit')` — never rethrow a raw dialect error, or callers can't tell a losable concurrency race from a real fault ([#1202](https://github.com/Rotorsoft/act-root/issues/1202))
- `query(callback, query?)` — stream events to a callback with filter, range, regex, and `with_snaps` support. Respecting the `after` / `limit` pair is what gives `scan` bounded-memory restore: the framework paginates by re-issuing `query` per batch, so any adapter that already honors those filters gets memory-safe scans for free. Stream/source filters must honor the portable regex grammar (`^` / `$` anchors, `.`, `.*`, literal characters — literal `_` / `%` included) and match **case-sensitively** on every adapter: Postgres uses POSIX `~`, InMemory a `RegExp`, and SQLite `GLOB` (case-sensitive, where `.*` → `*` and `.` → `?`) rather than `LIKE`, whose ASCII case-insensitivity would let `^order-` overmatch `Order-x` ([#1197](https://github.com/Rotorsoft/act-root/issues/1197)). If your backend can't express a richer pattern exactly, **throw `ValidationError`** instead of approximating — the TCK's "stream filter grammar" suite enforces both halves ([#1114](https://github.com/Rotorsoft/act-root/issues/1114)). Two edge inputs are contractual: an empty `names: []` is an explicit empty allow-list that matches **no** events (an omitted `names` matches all), and `before` / `after` are honored at their falsy-zero values — a `before: 0` or `after: 0` is a real id bound (`id < before` / `id > after`), not a dropped filter ([#1199](https://github.com/Rotorsoft/act-root/issues/1199)). A `Date` in an event's `data` **or `pii`** round-trips as a `Date`: adapters that store JSON revive ISO-8601-shaped strings on read (Postgres and SQLite both run the same reviver, on the pii read path as well as `data`/`meta` — [#1365](https://github.com/Rotorsoft/act-root/issues/1365)), with the documented caveat that any plain string shaped like an ISO-8601 timestamp is revived to a `Date`, and a timezone-less ISO string parses in local time ([#1198](https://github.com/Rotorsoft/act-root/issues/1198))
- `claim(lagging, leading, by, millis, lane?)` — atomically discover and lease streams for reaction processing (the workhorse of `drain`); optional `lane` filter for ACT-1103 drain lanes
- `subscribe(streams, correlated_at?)` — register streams so they become claimable; each row carries optional `lane` that the adapter writes when the row's priority merge allows it — at or above the stored priority, so the highest-priority registrant owns the lane and restart-driven re-laning still works at equal priority and an optional `correlated_at` **work mark** that decides claim eligibility — both covered below. It also carries the **correlate checkpoint**, read from the return and written by the optional second argument

  Registering a stream does **not** make it claimable on its own. `claim` follows work: a subscription with no matching event past its watermark is not returned, and that includes a fresh one sitting at `at = -1` ([#1446](https://github.com/Rotorsoft/act-root/issues/1446)). Do not special-case the fresh watermark into "claimable" — an `id > at` comparison already answers correctly at `-1`, since the first event's id is greater than it. Handing out an empty lease costs a cycle, and its no-op ack can advance the watermark past an event committed mid-cycle.
- `ack(leases)` / `block(leases)` — release a lease normally or after persistent failure. `ack` doubles as the drain's atomic finalize: every entry advances the watermark to `at`, and a lease carrying `due` (ms since epoch) *also* defers the remainder — schedule set, entry's `retry` persisted — in the same transaction as the batch's acks; deferred entries are excluded from the return value
- `defer(input, deferred_at)` — park streams until a future wall-clock time without advancing their watermark (the deferred-reaction outcome, [#1090](https://github.com/Rotorsoft/act-root/issues/1090)); covered below
- `reset(streams)` / `prioritize(filter, n)` / `truncate(targets)` — operator-facing primitives; the `StreamFilter` shape carries an optional `lane` exact-match. `truncate` targets come in two shapes — full (delete everything, seed a snapshot or tombstone) and windowed (`before` boundary, prefix delete behind a snapshot) — covered below
- `query_streams(callback, query?)` — read-only introspection (operational dashboards); positions carry their `lane`, an optional `deferred_at` (ms since epoch) when the stream is parked on an active future defer, and the optional `correlated_at` **work mark** so a reader can tell "behind the head" from "has work". The query gained an optional `source_matches` filter — covered below
- `notify(handler)` — *optional* cross-process commit notifications
- `restore(driver)` — *optional* atomic wipe-and-rebuild from an event source (see below)

Reading the JSDoc on each method is the first step. The TCK is the second.

## The store schema is the framework's job

Act has **no migration framework, and never will**. Operators never write
store migrations: `seed()` at boot is the entire schema-maintenance story —
additive, idempotent, lossless on any prior released shape, safe to run from
every worker on every boot. Event stores make this possible because they are
stable by nature: events are immutable, so schema changes are additive
nullable columns and index swaps, never destructive rewrites. Users manage
migrations only for their **own projections outside Act's store** (Drizzle et
al. — see projections-to-database.md).

The adapter-author rule that keeps this true: **every schema change ships
inside `seed()` as an additive `IF NOT EXISTS` step, plus an old-shape
upgrade test** (see `seed-upgrade.spec.ts` in act-pg/act-sqlite for the
canonical fixture: oldest supported shape + legacy rows → `seed()` → full
current shape, rows intact, second seed a no-op). That is the conformance
bar. On Postgres, `seed()` opens with a transaction-scoped advisory lock so
N workers cold-booting an empty schema serialize instead of tripping
`IF NOT EXISTS` catalog races.

A widening type change is additive too, and rides the same ladder — an
idempotent `ALTER COLUMN ... TYPE` that is a no-op once the column already
has the wider type and preserves every existing value. The precedent is the
`streams.retry` widening from `smallint` to `int`
([#1190](https://github.com/Rotorsoft/act-root/issues/1190)): `claim()`
increments `retry` on every acquisition and never resets it for a
zero-progress `blockOnError: false` stream, so a poison stream marches the
counter up without bound and the old `smallint` overflowed at 32768,
throwing "smallint out of range" and killing every claim in the lane. Just
editing the `CREATE TABLE` would only fix fresh databases — the fix has to
be a ladder step so existing deployments migrate on their next boot. The
widening also aligns Postgres with the unbounded `retry` of the
SQLite/InMemory adapters, closing a silent cross-adapter divergence.

Adoption is **import, not adapt**: `seed()` assumes Act owns its tables. To
bring existing events in from another system or shape, seed a fresh store
and import via `scan`/`restore` (see § Implementing `Store.restore` below
and the inspector's transfer pipeline) — never point Act at a foreign table
and try to reshape it in place.

## The work set

`claim` has to answer "which subscribed streams have unconsumed work?". The
obvious implementation asks the event log — `EXISTS (SELECT 1 FROM events
WHERE id > at ...)` per eligible subscription — and that is what every adapter
did until [#1488](https://github.com/Rotorsoft/act-root/issues/1488). It costs
O(**subscribed** streams) per claim per worker, which is the wrong axis: a
per-aggregate reaction (`.to(e => ({ target: e.stream }))`) subscribes one
stream per aggregate, so the cost grew with the domain rather than with the
backlog. **Your adapter must not do this.** `claim` reads no events at all.

`SubscribeInput.correlated_at` ([#1485](https://github.com/Rotorsoft/act-root/issues/1485))
lets the subscription row answer instead. It is the highest event id observed
to resolve to that target, and a stream is claimable exactly while
`at < correlated_at`.

Four rules, all pinned by the TCK's `work_set` suite:

- **It never regresses.** `GREATEST` / `MAX` in the same statement that
  UPSERTs the row, applied for every value including zero and negatives — a
  lower or equal mark is ignored, not written. (An earlier version of the
  `priority` column gated its merge on `> 0` and made a stored negative
  unraisable; that is the bug this rule exists to not repeat.)
- **Omitted leaves it untouched**, and an unmarked `subscribe` should not
  write the column at all — keep it out of the INSERT column list so a table
  that predates the column still accepts an unmarked subscribe.
- **A row with no mark is not claimable.** `NULL` means correlate has not
  spoken for that row, and `claim` has nothing else to consult — it does not
  read the event log at all ([#1488](https://github.com/Rotorsoft/act-root/issues/1488)).
  Rows that predate the column are given one in `seed()`, set to the log's
  head: deliberately an over-estimate meaning "worth one look", which the
  first drain replaces with an honest position after one fetch and ack. Do
  that as a single statement over the NULL rows rather than probing each one
  — the cost is one extra cycle per pre-existing subscription, once.
- **The operator surfaces leave the mark alone.** `reset` rewinds `at` to
  `-1` and must not clear `correlated_at`, or a rebuild would be unclaimable.
  `unblock`, `defer`, and `prioritize` don't touch it either.
- **`query_streams` returns it.** `claim` is not the only reader that needs to
  tell "behind the head" from "has unconsumed work" — the close-cycle safety
  probe asks the same question of every subscription consuming from a stream
  it is about to truncate ([#1487](https://github.com/Rotorsoft/act-root/issues/1487)).
  Surface the column on `StreamPosition.correlated_at`, and surface it as
  `undefined` when unset: `0` would read as a real mark.

The payoff is an index, not a loop. `at < correlated_at` is a legal partial-index
predicate — immutable, single-row, no cross-row reference — so the correlated
set *is* an index:

```sql
CREATE INDEX <table>_streams_correlated_at_ix
  ON <schema>.<table>_streams (lane, priority DESC, at)
  WHERE blocked = false AND at < correlated_at;
```

It holds only streams with work. A stream leaves when `ack` advances `at` to
`correlated_at` and re-enters when correlate raises the mark. One caveat if you
build the equivalent: keep the eligibility predicate on the **base table**. If
your claim query routes it through a CTE that other arms also reference, the
planner materializes that CTE and the partial index becomes unreachable.

Measured at 20,000 subscriptions with 3 holding work: 18.1 ms → 8.7 ms per
claim on Postgres, and 221.5 ms → 2.2 ms on SQLite, with identical leases per
round. The `PERFORMANCE.md` in each adapter carries the method.

## The correlate checkpoint

Your adapter owns one more piece of state besides events and subscriptions: **how far `correlate` has read the event log** ([#1484](https://github.com/Rotorsoft/act-root/issues/1484)). It is a single scalar per store, and it rides `subscribe` in both directions under one name — the optional `correlated_at` argument advances it, and `correlated_at` comes back in the result.

It rides `subscribe` because `correlate` is its only writer and already calls that method with the targets each scan discovers, so maintaining it costs no round trip of its own.

Three rules the TCK pins:

- **It persists only when greater than the stored value.** A lower or equal `correlated_at` is ignored rather than written, so a worker whose cursor lags cannot rewind it and re-sending the same value is a no-op. `GREATEST` / `MAX` in one statement is the whole implementation.
- **It is not a subscription.** Keep it in its own single-row relation — a scope owns three relations: events, subscriptions, and this one. Parking it as a reserved subscription row seems cheaper but every stream-scoped surface then counts it: `prioritize`, `reset`, `unblock`, `query_streams`, and `blocked_streams` all start reporting one extra stream.
- **It starts at `-1`** and is created by `seed()` like every other relation.

Do **not** try to derive it from anything else. It is distinct from a subscription's `at` (how far a *target* has been processed): once a target is subscribed the drain reads the log directly, so processing runs *ahead* of the read cursor, and a checkpoint derived from acked watermarks would skip the events in between for discovery — dynamic targets those events should have created would never exist. Only `correlate` knows how far `correlate` has read.

## What the framework does not validate for you

The framework validates payloads against their Zod schemas and nothing else.
It does **not** screen them for values your backing store happens to reject —
that would mean walking every payload on the framework's hottest path to
enforce one adapter's storage limits on all of them, and the walk costs
multiples of the Zod parse it would ride along with.

The known case is a **NUL byte** (`\u0000`). It is legal JSON and a legal JS
string, so it passes Zod; InMemory and SQLite (TEXT) round-trip it; Postgres
refuses it, from the jsonb parser for `data`/`meta`/`pii` (SQLSTATE `22P05`)
and from the UTF-8 decoder for the text columns (`22021`). An app that works
against SQLite in development can fail against Postgres in production on the
same input.

What an adapter owes its users here is a legible refusal, not silent
sanitizing. `PostgresStore` catches both SQLSTATEs in `commit` and rethrows a
`ValidationError` naming the stream and the events involved, keeping the
driver's own wording so the SQLSTATE stays searchable
([#1422](https://github.com/Rotorsoft/act-root/issues/1422)). Never strip or
substitute the offending bytes — an event store that quietly rewrites what it
was handed is worse than one that refuses it.

If your backing store has its own such limit (identifier length caps, encoding
restrictions, value-size ceilings), translate it the same way: catch at the
boundary, name the stream, keep the driver's message.

## The TCK is the spec

`@rotorsoft/act-tck` exports `runStoreTck`, a function you drop into your adapter's vitest suite:

```ts no-check
// libs/act-mysql/test/store-tck.spec.ts
import { runStoreTck } from "@rotorsoft/act-tck";
import { MysqlStore } from "../src/index.js";

runStoreTck({
  name: "MysqlStore",
  factory: () =>
    new MysqlStore({
      host: "localhost",
      database: "act_tck",
      // … adapter-specific config
    }),
  capabilities: {
    notify: false, // turn on once you implement Store.notify
  },
});
```

That single call runs 29+ contract cases against your adapter — every method on `Store`, every documented behavior, every error mode. If it passes, your adapter honors the contract every other piece of the framework relies on.

Adapter-specific tests (e.g., dialect-specific error paths, transaction edge cases, performance smoke tests) stay in their own files. The TCK only asserts what every Store must do.

## Capabilities flags

Some methods are optional. `Store.notify` is the only one today — it's a cross-process wakeup hook implemented by Postgres' `LISTEN`/`NOTIFY` and skipped by single-node adapters like SQLite.

```ts no-check
runStoreTck({
  name: "MysqlStore",
  factory: () => new MysqlStore({ /* … */ }),
  capabilities: { notify: true }, // your adapter implements notify
});
```

When `notify: true`, the TCK runs the cross-instance conformance cases: a listener receives commits from a *sibling* instance created by the same `factory`, never its own commits (the port's self-filtering MUST — "implementations must skip their own commits"), and exactly one notification per commit transaction carrying the full event batch. This requires your `factory` to produce instances that share one backing store (two adapters on the same schema/table is the standing pattern). True cross-*process* plumbing — reconnect discipline, payload caps — still belongs in your adapter's own tests.

`lease_correlation` is another opt-in. Skip it and every worker scans the log for itself, which is correct — the marks are idempotent — but costs one full pass and one set of mark-writes per worker. Implement it and one worker scans on behalf of the rest; see [Serializing correlation](#serializing-correlation-optional).

The `restore` capability is the other opt-in today. Skip it (`capabilities.restore: false` or just omit) and the TCK's restore cases stay parked. Flip it on once you've implemented `Store.restore` — see the next section for the contract.

## Deferring a stream (`defer` and the `claim` skip)

`defer` is the persistence behind the deferred-reaction outcome ([#1090](https://github.com/Rotorsoft/act-root/issues/1090)). A reaction handler can decide it has nothing useful to do until some future moment — a cooldown hasn't elapsed, a deadline is still hours out — and ask to be revisited then instead of acking (which would consume the event) or failing (which would burn a retry). The store is what makes that decision durable: an in-process timer alone would forget the deferral on restart and would not stop a *different* worker from re-claiming the same stream a millisecond later.

Two pieces implement it. First, a `deferred_at` column on the streams/subscriptions row, and a `defer(input, deferred_at)` method that bulk-sets it over the same `string[] | StreamFilter` selector `reset` and `unblock` already accept:

```sql no-check
-- defer(input, deferred_at): one bulk UPDATE, returns the affected count
UPDATE streams
   SET deferred_at = $deferred_at,
       retry_count = -1            -- a defer is not a failure; clear the retry counter
 WHERE stream = ANY($streams)      -- or the StreamFilter's compiled predicate
```

The array form counts **distinct** streams: `reset`/`defer` return "the count of streams actually affected", so a repeated name in the input array counts once. A set-based `WHERE stream = ANY(...)` gets this for free; an adapter that instead **loops** the array and sums per-name `rowsAffected` must de-duplicate the input first (e.g. iterate a `Set`), or a caller passing `["s","s"]` sees `2` where the SQL adapters return `1` ([#1360](https://github.com/Rotorsoft/act-root/issues/1360)). The store-TCK pins `reset(["s","s"]) === 1` and the same for `defer`.

Second, the `claim` query gains a guard that skips any stream still parked in the future:

```sql no-check
-- inside claim(...), alongside the blocked = false and lease-expiry predicates
AND (deferred_at IS NULL OR deferred_at <= $now)
```

The second write path for `deferred_at` is `ack` itself: the framework's drain finalizes every cycle with one `ack` call in which deferred leases ride the batch marked with `due`. Branch on it inside your ack transaction — **always advance the watermark to `at`**; then, with no `due`, clear the schedule and reset `retry`; with `due`, set the schedule and persist the entry's own `retry` — honoring the same `leased_by` ownership check either way. Advancing on a `due` entry is deliberate: a partial-progress drain hands you `at` at the last event it handled, so that prefix never re-runs, while the failing tail waits behind `deferred_at` (a hold passes `at` = the current watermark, a no-op advance). Atomicity here is load-bearing: a cycle's acks landing without its schedules (or vice versa) is exactly the partial state the contract forbids, and the TCK's `describe("ack finalize (due-marked leases)")` block pins it.

That guard is the whole correctness story. Because the skip lives in the shared store and not in worker memory, every competing consumer honors the same deferral — this is durable shared state, not the in-process pacing that reaction backoff does. When the due-time passes, the next `claim` from any worker picks the stream up again at the persisted watermark, so the pending tail is re-delivered and the handler gets another chance to decide.

`deferred_at` is transient: it must clear the moment the stream makes progress or is recovered. `ack` (the watermark advanced), `block` (the stream is quarantined), `reset` (rewind to replay), and `unblock` (operator recovery) all set it back to `NULL`. Re-deferring simply overwrites it. Keep these clears in lockstep with how you already clear `retry_count` and `error` on those verbs — the same rows, the same statements.

There is one more read path to wire: **`query_streams` must surface a stream's active future `deferred_at`** on the position it emits (ms since epoch; `StreamPosition.deferred_at`, [#1221](https://github.com/Rotorsoft/act-root/issues/1221)). The defer timer lives in worker memory, so a process restart forgets every scheduled re-visit — an idle terminal aggregate that deferred its own autoclose would then never re-arm, because nothing re-seeds the timer and no commit lands to wake the stream. On cold start the orchestrator closes that gap by walking `query_streams`, finding streams whose `deferred_at` is still in the future, and re-seeding the owning lane's timer so the drain re-arms at the due-time. Your only job is to return the column when it's set and in the future; leave it absent otherwise.

The TCK pins all of this. `store-tck.ts` has a `describe("defer")` block that asserts a deferred stream is hidden from `claim` until its `deferred_at` passes, becomes claimable once the time is in the past, never bumps `retry` while deferred, gets its defer cleared by `reset`, counts the streams a filter matched, and surfaces a still-future `deferred_at` on `query_streams` for the cold-start re-seed. If your adapter passes that block, the deferred-reaction outcome works on your backend with no further wiring — durable across a restart, not just within one process's lifetime.

## Paginating `query_stats` and the `source_matches` hint

Two query options carry semantics that are easy to get subtly wrong, so the contract spells them out and the TCK enforces them.

`query_stats` keyset-paginates by stream name. Order your result by stream name ascending; when `after` is set, return only streams sorting strictly after it (it's exclusive, never inclusive); when `limit` is set, stop after that many streams. The trap is the default: an **omitted** `limit` means unbounded — return every matching stream. That preserves the pre-pagination behavior every caller already relied on, and it's deliberately unlike `query_streams`, whose `limit` defaults to 100. Callers walk pages by feeding the last key they saw back as the next `after`, so your only job is consistent ordering and an honest exclusive cursor.

The subtle part is that the **sort comparator and the cursor comparator must be the same**. If you order the page with one collation and apply `after` with another, the cursor can skip streams the sort placed after it — a paginated walk then silently drops rows and terminates early. SQL adapters get this for free (both `ORDER BY stream` and `stream > $cursor` run under the column's binary collation); a hand-rolled reference must not, say, sort with `localeCompare` while cursoring with `<` (they disagree on mixed-case names — [#1357](https://github.com/Rotorsoft/act-root/issues/1357)). The differential TCK pins this with a mixed-case pagination workload.

`query_streams.source_matches` is the inverse of the existing `source` filter and, unlike everything else in the query, it's a *hint*. The `source` filter narrows to subscriptions whose pattern is matched by a value (`source ~ pattern`); `source_matches` narrows to subscriptions whose stored `source` pattern matches one of the supplied stream names (`name ~ source`). A subscription whose `source` is absent or empty has no source constraint and reacts to every stream, so it must always be included no matter what names are passed. If your backend can run regex in that direction, implement it for real — Postgres does it with `EXISTS(SELECT 1 FROM unnest($names) n WHERE n ~ source)` plus the null/empty-source always-match clause. If it can't, **not implementing it is a conformant choice**: ignore the field and return a superset. The framework's only caller (the close-cycle safety probe) re-checks source and target in process, so correctness holds whether you narrow precisely or hand back extra rows. Gate the narrowing tests behind the `source_matches` capability — declare it `true` only when your adapter actually filters, and the TCK leaves the narrowing assertions parked otherwise.

## Truncating streams — full targets and the windowed boundary

`truncate` is the delete verb behind close-the-books, and it carries two contracts in one method, switched per target by the presence of `before`.

A **full** target (`{ stream, snapshot?, meta? }`) is the classic close: in a single transaction, delete every event for the stream and insert exactly one seed event — a `__snapshot__` when `snapshot` is provided (the restart case), a `__tombstone__` otherwise. After the transaction the stream holds exactly one event.

**Do not touch the subscriptions table**, for retired and restarted targets alike ([#1527](https://github.com/Rotorsoft/act-root/issues/1527)). `truncate` is event-log work, and keeping it that way is what lets a store hold its event log and its subscriptions on different systems — every method then belongs cleanly to one half, and a hybrid routes instead of reimplementing. Removing the subscription row was the one exception, and it forced such a store into a distributed transaction it had no way to get.

Leaving the row costs nothing. A retired stream's subscription is **inert**: the framework refuses commits on a tombstoned stream, so nothing can raise its work mark, `at < correlated_at` never becomes true again, and `claim` never returns it. What the row keeps is the consumer's final watermark — a record of how far each reaction got before the stream was retired, which outlives the events themselves. Operators who want the space back delete those rows on their own schedule; the [production checklist](./production-checklist) carries the statement.

A **windowed** target (`{ stream, before, max_id? }`, [#1011](https://github.com/Rotorsoft/act-root/issues/1011)) is a pure prefix delete on a stream that stays live. The adapter's job is to find the **closest safe boundary** — the latest `__snapshot__` event with `created < before` and, when `max_id` is supplied, `id <= max_id` — and delete every event with an id below it. The snapshot itself and everything after it survive. The SQL shape on Postgres:

```sql no-check
-- find the boundary: the latest safe snapshot for this stream
SELECT id FROM events
 WHERE stream = $stream
   AND name = '__snapshot__'
   AND created < $before
   AND ($max_id IS NULL OR id <= $max_id)
 ORDER BY id DESC LIMIT 1;

-- prune the prefix below it (inside the same transaction as any sibling targets)
DELETE FROM events WHERE stream = $stream AND id < $boundary_id;
```

The contract points adapter authors get wrong first:

- **No seed, no tombstone, no streams-table touch.** Unlike a full truncate, the subscriptions row survives untouched — the stream must remain claimable and writable after the prune. The framework relies on this to keep the stream live.
- **No qualifying snapshot is a no-op, not an error.** If the boundary query returns nothing (the stream never snapshotted, or every snapshot is too young or above the `max_id` cap), delete nothing and leave the stream **absent from the result map**. The orchestrator translates absence into `CloseResult.skipped`.
- **Echo `before` in the result entry**, and set `committed` to the surviving boundary snapshot — an event that already exists, not something you write. Callers use the `before` field to distinguish windowed entries from full-close seeds.
- **`snapshot`/`meta` must be omitted on windowed targets**; when both appear, `before` takes precedence.
- **Mixed batches are legal.** One `truncate` call can carry full and windowed targets side by side; each target gets its own contract.

Why the boundary anchors on a real snapshot: the framework's `load()` resets state at each `__snapshot__` on replay, so events below the latest snapshot contribute nothing to any load result — deleting them cannot change what `load()` returns. The `max_id` cap is the consumer-safety half: the orchestrator probes the minimum subscription watermark before calling you, so the boundary never rises past what the laggiest reaction has read.

The TCK pins all of this in the `describe("windowed (before boundary)")` block of `store-tck.ts`: prefix deleted behind the closest safe snapshot, `max_id` cap honored, no-snapshot no-op, subscriptions preserved (explicitly contrasted with the full truncate), mixed full + windowed batches, and the stream staying writable and readable after a prune. Pass that block and windowed closes work on your backend with no further wiring.

## Splitting retirement across two systems

A full `truncate` target does three things atomically: delete the stream's events, seed a final marker, and remove its subscription row. If your event log and your subscriptions live in the **same** database, that is one transaction and there is nothing more to think about.

If they live apart — the shape the [hybrid-store recipe](https://github.com/Rotorsoft/act-root/tree/master/recipes/scaling/hybrid-store) uses — no transaction spans both, and you have to sequence two calls. Two things to get right.

**Use `truncate` on both halves.** `truncate` is already the verb that retires a subscription, so pointing it at the subscription store retires the row there. There is no separate "remove this subscription" method, and you do not need one:

```ts no-check
truncate: async (targets) => {
  const result = await log.truncate(targets);
  const retired = targets
    .filter(
      (t) =>
        t.before === undefined &&   // windowed targets keep subscriptions
        t.snapshot === undefined && // restart targets keep subscriptions (#1398)
        result.has(t.stream)        // absent means skipped, never truncated
    )
    .map((t) => ({ stream: t.stream }));
  if (retired.length) await subs.truncate(retired);
  return result;
},
```

Forward a **bare** `{ stream }` rather than the original target. Passing the original would seed a restart snapshot's state into the subscription store, copying domain data — possibly sensitive — into a database that should only ever hold watermarks.

**Do not use `reset` for this.** It reads like the subscription-side verb and does the opposite of what you want: `reset` rewinds the watermark to -1 and deliberately leaves the work mark untouched, so `at < correlated_at` becomes true and the stream you meant to retire becomes **claimable again**. That is correct behaviour — it is what makes `app.reset(...)` replay a projection — but it is not retirement.

**Truncate the log first.** Its truncate commits the tombstone that stops new events landing on the stream, so a crash between the two calls leaves an orphaned subscription row: it points at a stream whose events are gone, claims nothing, and is reaped by the next close of that stream. The reverse order leaves a live stream with **no** subscription, which silently stops delivery and never heals. `Act.close` is already resumable after an interrupted truncate ([#1389](https://github.com/Rotorsoft/act-root/issues/1389)), which is what makes the window recoverable rather than merely rare.

The store TCK already pins every fact this relies on — restart keeps the row while retire drops it, windowed leaves subscriptions untouched, and `reset` re-arms a caught-up subscription — so a composition built from them inherits those guarantees.

## Serializing correlation (optional)

Correlation is how Act discovers which subscriptions have work: it reads the event log forward from a checkpoint and marks every subscription an event resolves to. Every worker does this independently — each keeps its own scan position in memory, seeded from the durable checkpoint once at start-up — so N workers wake on the same commit and each reads the whole range and writes the same marks. Measured on real worker processes, that is exactly N reads and N mark-writes per committed event ([#1532](https://github.com/Rotorsoft/act-root/issues/1532)).

Honouring `subscribe`'s optional `correlator` argument lets one worker do it for all of them. There is no separate method: correlate already calls `subscribe` every pass, so the lease is a property of the checkpoint write that already happens.

```ts no-check
async subscribe(streams, correlated_at?, correlator?) {
  let correlating: boolean | undefined;
  if (correlator) {
    const { rowCount } = await this.client.query(
      `INSERT INTO ${this.checkpoints} (key, at, leased_by, leased_until)
       SELECT $1,
              GREATEST(COALESCE($2::int, -1),
                       COALESCE((SELECT at FROM ${this.checkpoints} WHERE key = ''), -1)),
              $3,
              now() + ($4::int * interval '1 millisecond')
       ON CONFLICT (key) DO UPDATE
          SET at = GREATEST(${this.checkpoints}.at, COALESCE($2::int, -1)),
              leased_by = EXCLUDED.leased_by,
              leased_until = EXCLUDED.leased_until
        WHERE ${this.checkpoints}.leased_until < now()
           OR ${this.checkpoints}.leased_by = EXCLUDED.leased_by;`,
      [correlator.key, correlated_at ?? null, correlator.by, correlator.millis]
    );
    correlating = (rowCount ?? 0) > 0;
  }
  // ...the usual subscription upserts...
  return { subscribed, watermark, correlated_at: at, ...(correlating === undefined ? {} : { correlating }) };
}
```

Five rules:

- **Acquire atomically.** One conditional upsert, never a read then a write — two workers that both read an expired lease before either wrote would both believe they hold it.
- **Renewal is the same call.** The same `by` extends rather than fails, so a holder keeps its lease while it works.
- **A non-positive `millis` releases.** Setting an expiry a hair in the future instead would still refuse a successor asking in the same instant, which reads as the handback never happening.
- **Expiry is the only other release.** A crash and a clean stop then take the identical path, so the recovery path is the common one.
- **Treat `key` as opaque, and key both the lease and the checkpoint on it.** It scopes the lease to workers that look for the same things — a deployment running some workers with a subset of the reactions is the case that matters, since those are not interchangeable and sharing a lease would leave one set of targets never marked. Keep an empty-key row as the shared floor: a brand-new key seeds from it, so an upgrade does not re-read history, and callers passing no correlator still read it.

**What you are trading.** Without the lease, correlation is fault-tolerant by redundancy: any worker can do it, so losing one costs nothing. With it, discovery stalls for up to the lease duration after a holder dies. Nothing is lost — the marks are durable and the next holder resumes — but reaction latency spikes by up to that window, which is why the duration is seconds rather than minutes.

Opt in with `capabilities: { lease_correlation: true }` and the TCK runs the suite: granted, refused to a second holder, renewed by the same holder, re-acquirable after expiry, keyed independently, the checkpoint still advancing for a caller that loses the race, and a new key seeding from the shared floor before diverging.

## Implementing `Store.restore` (optional)

`Store.restore` is the offline wipe-and-rebuild primitive. Capability-gated, because not every backend can atomically wipe and reinsert in one transaction (Kafka-fronted stores, partitioned multi-shard adapters, append-only object-storage logs). If your adapter can hold the operation under a single transaction or equivalent, implementing it earns the inspector's transfer dialog, the framework's cross-adapter migration story, and the compaction path.

### The HOF driver pattern

The signature is intentionally inverted — your adapter is handed a driver function and called with a per-event insert callback that the orchestrator owns:

```ts no-check
async restore(
  driver: (
    callback: (event: Committed<Schemas, keyof Schemas>) => Promise<number>
  ) => Promise<void>
): Promise<void> {
  await this._transaction(async (tx) => {
    // 1. Wipe atomically: events + streams + subscriptions
    await tx.exec("TRUNCATE events RESTART IDENTITY CASCADE");
    await tx.exec("DELETE FROM streams");
    await tx.exec("DELETE FROM subscriptions");

    // 2. Hand the orchestrator a per-event insert callback. The orchestrator
    //    validates, rewrites causation refs, and calls back into your callback
    //    once per kept event. Your callback returns the new id.
    await driver(async (event) => {
      const result = await tx.exec(
        "INSERT INTO events (name, data, stream, version, created, meta) " +
        "VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
        [event.name, event.data, event.stream, event.version, event.created, event.meta]
      );
      return result.rows[0].id;
    });

    // 3. tx commits on return, rolls back on throw
  });
}
```

The inversion exists for a reason: validation, dry-run, `drop_snapshots`, `on_progress`, and the causation-rewrite map all live in the orchestrator's `scan` loop, not in the adapter. Your adapter doesn't need to know what an `EventSource` is, what `ScanOptions` are, or how to rewrite `meta.causation.event.id` — the driver function handles all of that, and just calls your callback per event.

### Atomicity is the invariant

The single non-negotiable rule: on any throw from inside `driver(callback)`, the entire restore must roll back. The store reverts byte-for-byte to its pre-call state. The TCK's `atomic rollback on mid-iteration throw` case fault-injects an exception in the middle of the restore and asserts every event is unchanged afterwards.

Per-dialect notes:

- **Postgres** — `BEGIN` / `COMMIT` around the whole sequence. `TRUNCATE … RESTART IDENTITY CASCADE` for the wipe.
- **SQLite (libSQL)** — `BEGIN IMMEDIATE` to grab the writer lock up front (avoids a busy retry mid-restore). `DELETE FROM events; DELETE FROM sqlite_sequence WHERE name = 'events'` for identity reset.
- **InMemory** — snapshot the internal arrays at the start; swap them in only on successful completion; revert to the snapshot on throw.
- **Other backends** — if your transaction model doesn't span the operation, the capability is genuinely incompatible. Don't ship a "best-effort" restore that can land half the events; leave the capability off and let the TCK skip the cases. Downstream tools that need restore know to check.

### Identity reset

Original `id` values are dropped on insert. Your adapter's SERIAL / AUTOINCREMENT sequence assigns fresh ids dense from 1 (or `0..N-1` in InMemory). The orchestrator's `old → new` causation map handles the rewrite for `meta.causation.event.id` before your callback ever sees the event, so you don't write the old id; you just write what the callback hands you and let the dialect assign the new id naturally.

Why this matters: causation references in `meta` point at events by `id`. If your adapter renumbered without coordinating, every chain would silently break. The framework owns the rewrite so adapters can stay narrow.

### `created` is preserved verbatim

Unlike `commit` (which stamps `now()` on every event), restore writes the source's `created` timestamp directly. This is what makes cross-adapter migration lossless — a PG store restored into a SQLite file keeps every event's original commit time.

### Scan-time options your adapter is implicitly party to

The compaction (`drop_snapshots`, `drop_closed_streams`) and migration (`event_migrations`, `stream_rename`) options on `ScanOptions` are interpreted entirely on the orchestrator side — your `restore` driver never sees them. But the source path of a transfer (where your adapter implements `Store.query`) does see one related concern: `drop_closed_streams` works by walking the source once upfront with a `{ names: ["__tombstone__"] }` filter to collect closed-stream names cheaply. Adapters that honor the `names` filter in `query` (PG, SQLite, InMemory) make the pre-pass O(K) where K is the number of closed streams. Adapters that ignore the filter (CsvFile streams every event for any filter) still work correctly — the orchestrator falls back to checking each event's name in the callback — but pay an O(N) full source scan for the pre-pass. Honoring `names` is a meaningful performance win for any adapter that can support it via an index lookup.

### TCK opt-in

Once you've implemented the method, flip the capability flag:

```ts no-check
runStoreTck({
  name: "MysqlStore",
  factory: () => new MysqlStore({ /* … */ }),
  capabilities: {
    notify: true,
    restore: true,
  },
});
```

The TCK then runs ten cases: empty source, single stream, multi-stream, ISO `created`, pre-existing wipe, subscription clearing, snapshot preservation, causation remap, orphan-ref pass-through, and atomic rollback on mid-iteration throw. They cover the contract end-to-end; passing them means your adapter participates in every transfer flow the framework supports.

### Fault-injection adjacent to the TCK

Some failure modes are dialect-specific and live in your adapter's own error-spec file rather than the TCK — see `libs/act-pg/test/store.error.spec.ts` and `libs/act-sqlite/test/store.error.spec.ts` for the pattern. Typical cases to cover for restore:

- Mid-driver connection drop (the wipe succeeded but the insert loop fails on a network blip)
- Per-event constraint violation (a malformed JSON `meta` value that your dialect's JSON validator rejects)
- Sequence-reset failure (PG `RESTART IDENTITY` on a partitioned table, SQLite `sqlite_sequence` write on a read-only attach)

Each lands as a separate spec; the assertion is always the same — `kept === 0`, no events in the store afterwards, no partial state observable.

### Differential testing against the reference adapter

`runStoreTck` proves your adapter honors the contract in isolation. `runStoreDifferentialTck` proves it honors the contract _identically to the in-memory reference_ — the failure mode (ordering, `with_snaps` floor, `query_stats` / `query_streams` shape drift) that a single-adapter suite can't see. It replays a **family of randomized, seeded workloads** against every store you pass and compares their normalized outputs for each one:

```ts no-check
import { runStoreDifferentialTck } from "@rotorsoft/act-tck";
import { InMemoryStore } from "@rotorsoft/act";
import { MysqlStore } from "../src/index.js";

runStoreDifferentialTck({
  name: "InMemory vs Mysql",
  // First entry is the reference; every other store must match it.
  runs: 6, // durable adapter: fewer workloads keep the suite fast
  stores: [
    { name: "InMemoryStore", factory: () => new InMemoryStore() },
    { name: "MysqlStore", factory: () => new MysqlStore({ /* … */ }) },
  ],
});
```

Each workload is its own seeded plan (`seed`, `seed + 1`, …): the operation sequence — and even its length — varies by seed, so divergence is hunted across a slice of the input space rather than one fixed script. The seeds are deterministic, so a failing workload (named with its seed in the describe block) is always replayable. Normalization drops only the fields that legitimately differ between stores (absolute event ids, `created` timestamps, correlation/causation uuids); everything that defines correctness — stream, version, name, data, emission order — must be byte-for-byte equal. The in-tree adapters wire it as `store-differential-tck.spec.ts` alongside `store-tck.spec.ts`.

## Scaffolding `@rotorsoft/act-mysql` (worked example)

```
libs/act-mysql/
├── package.json              # peerDeps: @rotorsoft/act, zod; devDeps: @rotorsoft/act-tck
├── tsconfig.json
├── tsconfig.build.json
├── tsup.config.ts
├── src/
│   ├── index.ts              # export { MysqlStore }
│   └── mysql-store.ts        # implements Store
├── test/
│   ├── store-tck.spec.ts             # runStoreTck({ factory: () => new MysqlStore(…) })
│   ├── store-differential-tck.spec.ts # runStoreDifferentialTck({ stores: [InMemory, Mysql] })
│   └── store.error.spec.ts           # MySQL-specific error paths
└── README.md
```

The `package.json` mirrors `@rotorsoft/act-pg`:

```jsonc
{
  "name": "@rotorsoft/act-mysql",
  "type": "module",
  "peerDependencies": {
    "@rotorsoft/act": ">=0.39.0",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@rotorsoft/act-tck": "workspace:^"
    // mysql client lib of your choice
  }
}
```

The README's testing section shows the TCK invocation so users can verify the adapter still passes the contract after upgrading:

````md
## Testing

The Postgres store is validated against `@rotorsoft/act-tck`:

```ts no-check
import { runStoreTck } from "@rotorsoft/act-tck";
import { MysqlStore } from "@rotorsoft/act-mysql";

runStoreTck({
  name: "MysqlStore",
  factory: () => new MysqlStore({ host: "localhost", database: "act_tck" }),
});
```
````

## When the Store port changes

The TCK and the interface evolve together. When the framework adds, removes, or changes a method on `Store` (e.g., the `Store.query_stats(input, options)` primitive added in [#639](https://github.com/Rotorsoft/act-root/issues/639) / [#752](https://github.com/Rotorsoft/act-root/pull/752)):

1. The matching cases land in `libs/act-tck/src/store-tck.ts`.
2. New optional methods are gated behind a `Capabilities` flag so existing adapters keep passing until they opt in.
3. Each shipped adapter updates its own implementation; this guide is updated alongside.

Watching the TCK changelog for breaking changes is the simplest way to keep a third-party adapter in lockstep with the framework.

## Cross-references

- The contract itself: [`libs/act/src/types/ports.ts`](https://github.com/Rotorsoft/act-root/blob/master/libs/act/src/types/ports.ts)
- Existing adapters as reference implementations:
  - [`InMemoryStore`](https://github.com/Rotorsoft/act-root/blob/master/libs/act/src/adapters/in-memory-store.ts)
  - [`@rotorsoft/act-pg`](https://github.com/Rotorsoft/act-root/tree/master/libs/act-pg)
  - [`@rotorsoft/act-sqlite`](https://github.com/Rotorsoft/act-root/tree/master/libs/act-sqlite)
- TCK source: [`libs/act-tck/src/store-tck.ts`](https://github.com/Rotorsoft/act-root/blob/master/libs/act-tck/src/store-tck.ts)
- Bootstrapping a new `/libs` package end-to-end: [contributing-new-package.md](contributing-new-package.md)
