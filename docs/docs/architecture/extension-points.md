---
id: extension-points
title: Extension points
---

# Extension points

Three pluggable contracts: `Store`, `Cache`, `Logger`. Each is exposed as a singleton port. A new adapter implements the contract; calling the port with the adapter installs it (first call wins).

This page covers each contract, its invariants, and the concrete adapters in this repo. Anyone writing a new adapter should be able to read this page plus the contract source and build something correct.

Writing a **third-party adapter** in its own repository? The [TCK conformance & the compatibility badge](../guides/tck-conformance.md) guide is the advertised path: how to depend on `@rotorsoft/act-tck` from a fresh repo, run `runStoreTck` / `runCacheTck` / `runLoggerTck` against your factory, guard your own surface with `runStabilityTck`, and display a conformance badge once green. The per-port deep dives — [writing-a-store](../guides/writing-a-store.md), [writing-a-cache](../guides/writing-a-cache.md), [writing-a-logger](../guides/writing-a-logger.md) — cover each contract method by method.

## The port pattern

Every infrastructure dependency in the framework is reached via a port — a singleton getter that lazily initializes a default the first time it's called:

```ts
import { store, cache, log, dispose } from "@rotorsoft/act";

// Defaults install on first call
store();   // → InMemoryStore
cache();   // → InMemoryCache
log();     // → ConsoleLogger

// Or inject before first read
import { PostgresStore } from "@rotorsoft/act-pg";
store(new PostgresStore({ /* ... */ }));   // sets the singleton
const s = store();                          // returns the PostgresStore
```

First call wins by design. Once an adapter is registered, subsequent calls with a different argument are ignored. This forces app initialization to be deterministic and prevents mid-run swaps that would corrupt state.

The `dispose()` port collects cleanup callbacks. Adapters' `dispose()` methods are wired into this so they release resources (DB pools, file handles) on shutdown. Order: registered disposers run in reverse, then port adapters in reverse registration order.

## Store contract

The `Store` interface in `libs/act/src/types/ports.ts`. The framework needs the store to do these things:

```ts no-check
interface Store extends Disposable, EventSource {
  // EventSource gives us:
  // query<E>(callback: (event: Committed<E>) => void, query?: Query): Promise<number>;

  seed(): Promise<void>;
  drop(): Promise<void>;
  commit(stream, msgs, meta, expectedVersion?): Promise<Committed[]>;
  claim(lagging, leading, by, millis, lane?): Promise<Lease[]>;
  subscribe(streams: SubscribeInput[], correlated_at?): Promise<{ subscribed; watermark; correlated_at }>;
  ack(leases): Promise<Lease[]>;
  block(leases): Promise<BlockedLease[]>;
  defer(input: string[] | StreamFilter, deferred_at): Promise<number>;
  reset(input: string[] | StreamFilter): Promise<number>;
  unblock(input: string[] | StreamFilter): Promise<number>;
  prioritize(filter: StreamFilter, priority): Promise<number>;
  truncate(targets): Promise<Map<stream, { deleted; committed; before? }>>;
  query_streams(callback, query?): Promise<QueryStreamsResult>;
  query_stats(input, options?): Promise<Map<stream, StreamStats>>;
  // Optional, capability-gated:
  notify?(handler): NotifyDisposer | Promise<NotifyDisposer>;
  restore?(driver: (callback: (event: Committed) => Promise<number>) => Promise<void>): Promise<void>;
  forget_pii?(stream: string): Promise<number>;
}
```

`ack` is the drain's atomic finalize: every entry advances the watermark to `at`, and a lease *with* `due` additionally defers (schedule set to `due`, `retry` set to the entry's own value) — advance and defer are independent legs, so a partial-progress backoff/defer keeps the events it handled (they never re-run) while the failing tail waits for `deferred_at`; a lease without `due` also clears the schedule and resets `retry`. All entries land in one transaction, so a cycle's acks can never land without its schedules or vice versa. Deferred entries are excluded from the return value. The standalone `defer` verb (which parks a stream *without* advancing its watermark) remains for operator-driven bulk scheduling.

`seed()` is the schema story — there is no migration framework, by design. The method is additive, idempotent, and lossless on any prior released shape: every schema change ships as an `IF NOT EXISTS` step that re-asserts on every boot, which is precisely what makes it self-healing (a version table would break that property — see the decision record in [#1140](https://github.com/Rotorsoft/act-root/issues/1140)). Adopting existing event data means importing into a fresh Act-owned store via `scan`/`restore`, never adapting a foreign table in place.

`reset`, `unblock`, and `prioritize` share the same `StreamFilter` shape (`stream` / `stream_exact` / `source` / `source_exact` / `blocked` / `lane`). `reset` and `unblock` also accept a plain `string[]` for targeted operations. `unblock` always restricts to blocked streams regardless of what the filter passes — there's no "unblock unblocked streams" use case. `reset` is for projection rebuilds (watermark → -1); `unblock` is for poison-message recovery (watermark preserved).

The `stream` / `source` fields (here and on `Query` / `QueryStreams`) are regex-shaped, but only a **portable grammar** is guaranteed to match identically on every adapter: `^` / `$` anchors, `.` (any single character), `.*` (any run), and literal characters — including literal `_` and `%`. Matching is **case-sensitive on every adapter**: Postgres uses POSIX `~`, InMemory a `RegExp`, and SQLite translates the grammar to `GLOB` (`.*` → `*`, `.` → `?`, with `_` / `%` staying ordinary literals — no escaping needed). SQLite moved off `LIKE` for exactly this reason: `LIKE` is ASCII case-*insensitive*, so a `^order-` filter overmatched `Order-x`, diverging from the case-sensitive `~` / `RegExp` adapters. `GLOB` (not `PRAGMA case_sensitive_like`, which is connection-scoped and unreliable under libsql's pooled connections) restores parity without touching the portable grammar itself ([#1197](https://github.com/Rotorsoft/act-root/issues/1197)). Adapters whose native engine compiles full regex (Postgres POSIX `~`, InMemory `RegExp`) may accept richer patterns; an adapter that cannot express a pattern exactly (SQLite's anchor-aware `GLOB` translation) must throw `ValidationError` instead of silently approximating — a silently-wrong match is the worst available failure mode when the filter drives a bulk `reset` or `unblock` ([#1114](https://github.com/Rotorsoft/act-root/issues/1114)). The TCK's "stream filter grammar" suite pins both halves of this contract.

Two `Query` edge inputs are contractual and identical on all three adapters. An empty `names: []` is an explicit empty allow-list that matches **no** events, and an omitted `names` matches all — the two must not collapse (Postgres previously dropped the empty filter and returned everything, the opposite of SQLite/InMemory). And `before` / `after` are honored at their falsy-zero values via `!== undefined` guards, not truthy guards: `before: 0` and `after: 0` are real id bounds (`id < before` / `id > after`), so an `after: 0` never leaks the id-0 event on the backward path ([#1199](https://github.com/Rotorsoft/act-root/issues/1199)).

A `Date` in an event's `data` round-trips as a `Date` — but the **schema** decides which fields those are, not the adapter.

JSON has no date type, so a `Date` is stored as its ISO form. An adapter reading it back has never seen the event's Zod schema, so it cannot know which strings were dates; it returns exactly what it stored. The framework resolves each event's `z.date()` paths once at `act().build()` and converts precisely those on read ([#1556](https://github.com/Rotorsoft/act-root/issues/1556)).

That removes a whole class of false positive: a field declared `z.string()` whose value happens to look like a timestamp — an upstream API's `created_at`, an RFC-3339 string you pass through — stays a string, because its declaration says so. Adapters previously guessed from string shape, which revived any ISO-8601-looking value and produced state that failed its own schema after a restart.

The typing is Zod's own: each event's declared schema is transformed once at build time — `z.date()` becomes coercing, objects become loose — and `parse` does the work, so nesting, arrays, records and unions are handled by the same engine that validates on write. Objects are loose deliberately: a strict Zod object strips keys it does not declare, and an event store can hold payloads written against an older schema, so dropping them on read would lose committed data.

One consequence worth knowing: a store read **directly** (`Store.query`, outside `IAct`) returns the stored string, since typing is the orchestrator's job — the store is a byte-level surface.

The `source` a reaction resolver hands to `subscribe` follows a **literal fast-path / pattern** contract — but it is the window a subscription's **fetch** reads, not something `claim` interprets. A **literal** source (no regex metacharacter — the common case, and every autoclose/dynamic-resolver source) is matched by string equality: index-friendly, and exact so a source `s1` never reads a sibling stream `s12`. A **pattern** source (one carrying `^ $ . * + ? ( ) [ ] { } | \`, e.g. a static reaction sourcing `^(A|B)$`) is compiled as a regex — this is what keeps the shipped calculator demo's regex-source Board projection working, after an earlier exact-only decision broke it ([#1220](https://github.com/Rotorsoft/act-root/issues/1220), regressing [#1182](https://github.com/Rotorsoft/act-root/issues/1182)/#1215). Adapters that cannot faithfully run an arbitrary regex (SQLite, whose libsql build has no `REGEXP` and whose portable `LIKE` grammar cannot express alternation/grouping) reject a non-portable source at `subscribe` time rather than accepting one they would silently mis-match.

Since [#1488](https://github.com/Rotorsoft/act-root/issues/1488) the matching that decides *eligibility* happens one layer up: `correlate` applies the source window when it decides which events may raise a target's mark, and `claim` then reads the mark alone. The store-side cases that used to pin source matching in `claim` live in `libs/act/test/correlate-work-mark.spec.ts`.

`defer` (added with the deferred-reaction outcome, [#1090](https://github.com/Rotorsoft/act-root/issues/1090)) rounds out the watermark verb family: **claim / ack / block / defer**. It stamps a `deferred_at` wall-clock time on each matching stream, and `claim` skips any stream whose `deferred_at` is still in the future. The defer therefore holds across every competing worker — it is durable shared state, not in-process pacing like reaction backoff. A defer is not a failure: it never bumps `retry`, and `defer` itself resets `retry` to `-1`. The schedule clears whenever the watermark moves or the stream is recovered, so `ack`, `block`, `reset`, and `unblock` all wipe `deferred_at`. An adapter implements it as one bulk `UPDATE … SET deferred_at = ?` over the same `string[] | StreamFilter` selector `reset`/`unblock` use, plus the `deferred_at IS NULL OR deferred_at <= now()` guard in the `claim` query.

`truncate` handles two target shapes in one call. A **full** target (`{ stream, snapshot?, meta? }`) deletes every event for the stream and seeds a single final event — `__snapshot__` when `snapshot` is provided, `__tombstone__` otherwise. A **windowed** target (`{ stream, before, max_id? }`, added in [#1011](https://github.com/Rotorsoft/act-root/issues/1011)) is a pure prefix delete behind a real snapshot the app wrote: the store finds the closest safe boundary — the latest `__snapshot__` with `created < before` and, when `max_id` is given, `id <= max_id` — and deletes events below it, keeping the snapshot and the tail. No seed, no tombstone, and the streams table is untouched, so the stream stays live and claimable. No qualifying snapshot means a no-op, with the stream absent from the result. `snapshot`/`meta` must be omitted on windowed targets. Windowed result entries echo `before`, and their `committed` is the surviving boundary snapshot rather than a new seed — that's how `closed`-event consumers tell prunes from full closes.

`claim` takes an optional `lane` filter (ACT-1103). When set, only streams in the named lane are eligible; when omitted, the claim spans every lane — preserving pre-1103 behavior. Adapters that haven't migrated yet can leave `lane` unread on the SQL side and still satisfy the contract until they opt in. `subscribe`'s row shape gained an optional `lane` field for the same release; adapters write it whenever the incoming priority is at or above the stored one, so a restarted Act with a new lane assignment moves streams without a manual migration (a restart re-subscribes at the same declared priority) while a lower-priority registrant cannot take a lane it lost ([#1599](https://github.com/Rotorsoft/act-root/issues/1599)).

`query_stats` is the per-stream-aggregate primitive (added in [ACT-639](https://github.com/Rotorsoft/act-root/issues/639)). Default returns the head event per stream via an indexed path; opt-in `count`/`tail`/`names` trigger a full scan but share it. Input is `string[]` for an enumerated set or `Pick<StreamFilter, "stream" | "stream_exact">` for pattern selection — subscription-level filters (`source`, `blocked`) live on `query_streams`; compose the two for "stats for blocked subscriptions" workflows. The returned `head`/`tail` **never carry `pii`**: `query_stats` has no actor context and no disclosure gate, so — like any un-gated read — your adapter must omit the pii sidecar here (route pii through the gated `load` path instead), matching InMemory/PG/SQLite ([#1294](https://github.com/Rotorsoft/act-root/issues/1294)).

`QueryStatsOptions` also carries the keyset-pagination pair `after`/`limit`. Results are ordered by stream name ascending; `after` is an exclusive cursor (streams sorting strictly after it), and the next cursor is the last key of the returned map (`[...result.keys()].at(-1)`). `limit` defaults to unbounded — omit it and `query_stats` returns every matching stream (unlike `query_streams.limit`, which defaults to 100).

`query_streams` carries `source_matches`, a best-effort reverse-match filter: return subscriptions whose stored `source` pattern matches at least one of the supplied names (`name ~ source`, the inverse of `source`'s `source ~ pattern`). A subscription with an absent or empty `source` always qualifies. It is a hint, not an exact filter — a store that can't express reverse-regex may return a superset, so callers re-verify in process. Capability-gated as `source_matches` in the TCK; `PostgresStore` and `InMemoryStore` honor it, `SqliteStore` returns a superset.

Each position `query_streams` emits also carries the optional `correlated_at` work mark (`StreamPosition.correlated_at`, [#1487](https://github.com/Rotorsoft/act-root/issues/1487)) — the same value `claim` reads eligibility from, `undefined` when the row has none. Any reader that has to distinguish "this subscription is behind the head" from "this subscription has unconsumed work" needs it, because correlate advances a watermark only over events that resolve to that target: the close-cycle safety probe is the first such reader, and without the mark it would report every reader of a subset of a state's events as permanently in-flight.

Each position also carries an optional `deferred_at` (ms since epoch; `StreamPosition.deferred_at`, [#1221](https://github.com/Rotorsoft/act-root/issues/1221)) — present only when the stream is parked on an active future defer. The orchestrator reads it exactly once, at cold start: the defer timer is in-memory, so a restart forgets every scheduled re-visit, and an idle deferred stream (e.g. a terminal aggregate awaiting its own autoclose) would never re-arm without a re-seed. `CorrelateCycle.init` walks `query_streams`, finds the still-future `deferred_at` values, and re-seeds the owning lane's timer so the drain re-arms at the due-time with no intervening commit; streams whose lane isn't active on this instance are skipped, since a peer owns that timer. Adapters just return the column when it's set and in the future.

`restore` is the offline wipe-and-rebuild primitive (added in [ACT-1124](https://github.com/Rotorsoft/act-root/issues/783), reshaped into the current HOF driver pattern by [ACT-1125](https://github.com/Rotorsoft/act-root/issues/784)). Capability-gated — adapters that can't atomically wipe and reinsert in one transaction don't have to implement it. The adapter's job is narrow: open a transaction (PG `BEGIN`, SQLite `BEGIN IMMEDIATE`, InMemory snapshot-and-swap), wipe events + streams/subscriptions, hand the orchestrator a per-event insert callback by invoking `driver(callback)`, then commit or roll back. `RESTART IDENTITY` (PG) / `sqlite_sequence` reset (SQLite) reseed dense ids from 1; InMemory uses `0..N-1`. `created` is preserved verbatim from the source — distinct from `commit`, which always stamps `now()`. Reactions re-subscribe via the orchestrator on the next settle cycle.

### `forget_pii` — the sensitive-data erasure primitive

`forget_pii(stream: string): Promise<number>` is the physical-erasure half of the sensitive-data epic. The orchestrator calls it from `app.forget(stream)`; the adapter wipes the PII column for every event on the stream and returns the row count. `events.data` and the rest of the row are never touched, so the append-only invariant the rest of the framework depends on stays intact.

```ts no-check
const wiped = await store.forget_pii("user-42");
// wiped === 7 — seven events had their pii column nulled.
```

The method is idempotent. A second call on an already-wiped stream returns `0` without error; a call on a stream that never carried PII also returns `0`. Adapters implement this by issuing a single `UPDATE events SET pii = NULL WHERE stream = ?` (PG/SQLite) or the in-memory equivalent, with no per-event branching for "did this event have PII to begin with."

Capability-gated through `StoreCapabilities.pii_isolation` in `@rotorsoft/act-tck`. Adapters that can ship the column declare `pii_isolation: true` and implement the method; adapters that can't (Kafka, append-only object-storage logs that don't support row-level UPDATE) declare `pii_isolation: false` and omit it. When `pii_isolation` is `true`, the TCK runs the full PII suite — commit-with-pii round trip, pii-less passthrough, `forget_pii` happy path, idempotency, and isolation across sibling streams. When `false`, the suite is skipped.

`app.forget(stream)` calls into `Store.forget_pii` directly. If the configured store omits the method, the orchestrator throws with a clear "your adapter cannot comply with sensitive-data erasure" message — operators discover the misconfiguration in dev, not during a compliance audit. The framework also invalidates the cache entry for the stream and emits the `forgotten` lifecycle event after a successful wipe. For the user-facing flow, see the [Handling sensitive data](../guides/sensitive-data.md) guide.

Disk reclamation is adapter-dependent and intentionally out of scope: PG autovacuum reclaims lazily; SQLite needs `PRAGMA incremental_vacuum` or `VACUUM` to release pages. The framework's job is isolation and erasure of the column; physical page reclamation is the operator's.

In-tree adapters that declare `pii_isolation`:

| Adapter | Capability | Notes |
|---|---|---|
| `InMemoryStore` | `true` | Per-event `pii` field cleared on `forget_pii`; useful for tests of the orchestrator's gate/strip path |
| `PostgresStore` | `true` | `events.pii JSONB` column, nulled with a single indexed `UPDATE` |
| `SqliteStore` | `true` | `events.pii TEXT` column, same pattern |

### `EventSource` / `EventSink` — the transfer surface

Added by [ACT-1128](https://github.com/Rotorsoft/act-root/issues/787) / [#788](https://github.com/Rotorsoft/act-root/issues/788), the public types `EventSource` and `EventSink` (in `libs/act/src/types/action.ts`) split the read end and the write end of the restore pipeline into separate interfaces, so the same `Act.restore` driver can move events between any source and any sink:

```ts no-check
interface EventSource extends Disposable {
  query<E>(callback: (event: Committed<E>) => void, query?: Query): Promise<number>;
}
interface EventSink extends Disposable {
  restore(driver: (callback: (event: Committed) => Promise<number>) => Promise<void>): Promise<void>;
}
```

`Store extends EventSource` — every adapter is a source for free. The optional `Store.restore` method matches the `EventSink.restore` shape, so a restore-capable store is also a sink. The framework ships `CsvFile` (in `libs/act/src/csv.ts`) as the bundled non-store implementation: it implements both ends so a CSV file can be either side of a transfer (back up a store → CSV, restore a CSV → store, or pipe one CSV to another). Construct with `new CsvFile({ path })` for an on-disk file or `new CsvFile({ blob })` for a string already in memory.

The orchestrator now exposes:

```ts no-check
app.restore(source: EventSource, opts?: ScanOptions, sink?: EventSink): Promise<ScanResult>
```

`sink` defaults to the singleton store (which must declare the `restore` capability); passing an explicit sink routes the transfer elsewhere without binding the singleton. This is how the inspector's unified transfer endpoint moves events between PG ↔ SQLite ↔ CSV without ever changing what's connected.

### Backpressure

The `EventSource.query` callback is typed `(event) => void`, and adapters wrap each invocation in `await Promise.resolve(callback(event))`. TypeScript's "any return ignored when the type says `void`" rule lets the same call site accept both sync (`e => arr.push(e)`, returns `number`) and async (`async e => …`) callbacks. The orchestrator's `scan` (in `libs/act/src/internal/event-sourcing.ts`) puts its per-event work directly inside the source's callback, so the adapter's per-event await throttles the producer to the consumer's pace.

`scan` paginates the source. Each batch calls `source.query` with `limit: ScanOptions.batch_size` (default 500, caller-tunable per `Act.restore` invocation) and `after: <last id seen>`. Stores that respect `limit` (`PostgresStore`'s `pool.query` honors it natively) hold one batch's worth of rows in memory per round trip — adapter cost is O(`batch_size`) regardless of total result size. Sources that ignore the filter and stream everything in one call (`CsvFile`) signal the loop to exit by returning more events than the requested limit; they're memory-safe because they read line-by-line internally.

A million-event PG → CSV transfer holds at most `batch_size` rows in the adapter, one event in flight through the source's callback, and whatever the consumer accumulates downstream — independent of total source size. `CsvFile`, `EventSource`, and `EventSink` are the public surface the rest of the framework speaks.

### `scan`, `Act.restore`, and the destructive path

The orchestrator-side validator lives in `scan` (`libs/act/src/internal/event-sourcing.ts`, alongside `load`/`action`/`snap`/`tombstone`) and is exposed publicly only via `Act.restore(source, opts, sink?)`. `scan` owns iteration over the `EventSource`, validates each event (negative version, malformed `created`), applies `drop_snapshots`, fires `on_progress`, and builds the per-call `old → new` id map that rewrites `meta.causation.event.id` so causation chains survive the renumber. Tools that operate on a raw `Store` without app state (e.g., the inspector) wrap the store in an empty Act via the scoped-ports option and call `app.restore` — the orchestrator path stays the only door in.

`ScanOptions` is interpreted by `scan`, not by adapters. It carries:

- `drop_snapshots` — skip every `__snapshot__` event in the source so the next snap policy regenerates them with current state ([ACT-1125](https://github.com/Rotorsoft/act-root/issues/784))
- `drop_closed_streams` — compact streams that have a `__tombstone__` event ([ACT-1126](https://github.com/Rotorsoft/act-root/issues/785)). Scan walks the source once upfront with a tombstone-name filter to collect closed-stream names, then the main pass drops every **pre-close event** whose stream is in the set. The tombstone is **kept** — it's what makes `app.do()` throw `StreamClosedError` in the rebuilt store, so dropping it would silently reopen the stream. Counted in `ScanResult.dropped.closed_streams`.
- `event_migrations` and `stream_rename` — transfer-time schema migration ([ACT-1126](https://github.com/Rotorsoft/act-root/issues/785)). Schema-guarded event rewrites + bulk stream rename for tenant relocation; see [Concepts → Migration overlay](../concepts/event-sourcing.md#migration-overlay).
- `on_progress` — one callback per event (caller throttles/debounces)
- `dry_run` — validate the source without touching the store (same scan loop, no transaction, no sink call; powers the inspector's transfer-preview)
- `batch_size` — pagination chunk size for the underlying `source.query` calls

All transforms run inside scan's existing pagination loop and atomic-rollback contract — any throw aborts the whole pass.

**Validation is a source operation, not a store operation.** Per-event blockers (malformed `created`, negative `version`) are caught inline by the scan loop on every `Act.restore` call and throw on the first hit; atomic transaction rollback in the sink means a failing restore leaves the target byte-for-byte unchanged. Cross-event invariants (duplicate ids, per-stream version gaps) are not the framework's job — DB `UNIQUE(stream, version)` catches dupes at commit time, and partial backups intentionally have gaps.

### Invariants an adapter must hold

- **Per-stream version monotonicity**: every event for a given stream has a `version` that's strictly greater than the previous event's `version` for that stream, starting at 0.
- **Optimistic concurrency**: when `expectedVersion` is provided, `commit` MUST throw `ConcurrencyError` if the stream's current head version doesn't match. This includes catching adapter-specific `(stream, version)` unique-constraint violations and re-throwing as `ConcurrencyError` — Postgres keys off SQLSTATE `23505`, SQLite off its unique-constraint message. Every *other* driver error from `commit` MUST be wrapped in `StoreError('commit')`; a raw dialect error leaking out leaves callers unable to tell a losable concurrency race from a real fault, and they cannot retry correctly on adapter-specific errors ([#1202](https://github.com/Rotorsoft/act-root/issues/1202)).
- **Atomic commits**: a multi-event commit is all-or-nothing. Either all events land or none do.
- **Atomic truncate**: a full `truncate` target deletes all events for a stream and inserts the seed event in a single transaction; a windowed target (`before`) deletes the prefix below the closest safe snapshot in the same transactional envelope. Partial states are not observable either way.
- **`truncate` is event-log work only**: it MUST NOT touch the subscriptions table, for retired and restarted targets alike ([#1527](https://github.com/Rotorsoft/act-root/issues/1527)). This is what keeps every method on one side of the log/subscription boundary, so a store holding the two halves on different systems can route rather than reimplement. Removing the subscription row was the sole exception, and it forced such a store into a distributed transaction it could not have. Leaving the row is safe because a retired stream's subscription is **inert** — the framework refuses commits on a tombstoned stream, so no scan can raise its work mark, `at < correlated_at` never becomes true again, and `claim` never returns it. The row's surviving value is the consumer's final watermark, a record of how far it got that outlives the events. Reclaiming the space is an operator job, documented in the [production checklist](../guides/production-checklist).
- **Correlation lease** (when implemented): `subscribe`'s optional third argument asks for it, and `correlating` in the result answers. At most one holder per `key` at a time, acquired **atomically** — a read-then-write lets two workers both see an expired lease and both believe they hold it, which is precisely the duplication the lease removes. The same `by` renews rather than fails, so acquiring and extending are one call; a non-positive `millis` releases. Expiry is the only other release, which keeps a crash and a clean stop on one path. It exists because correlation is duplicated work: every worker keeps its own scan position, so N workers wake on the same commit and each reads the whole range and writes the same marks — measured at exactly N reads and N mark-writes per committed event ([#1532](https://github.com/Rotorsoft/act-root/issues/1532)). The `key` scopes it to correlators that look for the same things; a worker deployed with a subset of the reactions is not interchangeable with a full one and must scan for itself. It also selects which checkpoint row the caller reads and advances, with the shared row as the floor a new key inherits. Omit the argument entirely and no lease is taken — every worker scans, which is correct but wasteful, since the marks are idempotent.
- **Atomic restore** (when implemented): `restore` wipes events + streams and rewrites the source rows in a single transaction. On any throw mid-iteration, the store reverts byte-for-byte to its pre-call state. Cache invalidation after restore is the caller's responsibility — restore does not touch the `Cache` port.
- **Backpressured query**: adapters MUST invoke the per-event callback as `await Promise.resolve(callback(event))`. Sync callbacks (`(e) => arr.push(e)`) resolve immediately and pay no overhead; async callbacks (`async (e) => …`) throttle the read loop, which is how `scan` and the transfer pipeline avoid OOM on multi-million-event sources.
- **Lease exclusivity**: a successful `claim` returns leases that no concurrent `claim()` can return again until released by `ack`/`block`/timeout.
- **The work set (`SubscribeInput.correlated_at`)**: a subscription row carries an optional **work mark** — the highest event id observed to resolve to that target ([#1485](https://github.com/Rotorsoft/act-root/issues/1485)). `subscribe` applies it as `GREATEST(correlated_at, N)`, so it never regresses, for every value including zero and negatives; omitting it leaves the stored value untouched. `claim` serves a stream from the row alone (`at < correlated_at`) and reads no events at all since [#1488](https://github.com/Rotorsoft/act-root/issues/1488), which is what moves its cost from O(subscribed streams) to O(rows with work). A row with **no mark is not claimable** — `NULL` means correlate has not spoken for it, not "go and look" — so an adapter must persist the column and honor the predicate; rows that predate it are given the log's head at `seed()` time, an over-estimate the first drain corrects. Only `correlate` may write a mark: the store cannot resolve user-code targets and `notify` is best-effort. A subscription's `source` is now purely the window its **fetch** reads; `claim` has no opinion on it, and correlate applies the matching when it decides which events may raise a mark.
- **Literal-vs-pattern fetch sources**: a **literal** subscription `source` (no regex metacharacter) selects events by **string equality** — index-friendly, and exact so `s1` never reads `s12`. A **pattern** source (carrying regex metacharacters) is compiled and matched against stream names. Adapters that cannot run an arbitrary regex reject a non-portable pattern at `subscribe` time. This governs what a subscription *fetches*; since #1488 it is not part of what `claim` decides.
- **Retry accounting**: every granted lease increments the stream's retry counter; only `ack` resets it. A timed-out lease reclaimed by any worker therefore counts against the retry budget (see the [concurrency model](./concurrency-model)). An adapter owes nothing beyond that. When one of its operations fails partway through a drain pass, the counter is left raised and the drain handles it on its own side, rather than asking the adapter to undo the increment while it is still failing.
- **Tombstone semantics**: a tombstone event is a regular event with `name === TOMBSTONE_EVENT`. Adapters don't need to know what it means — the framework's `action()` reads the head event to decide. Adapters just need to return tombstones in queries like any other event.

### Concrete adapters

| Adapter | Where | Use case |
|---|---|---|
| `InMemoryStore` | `libs/act/src/adapters/in-memory-store.ts` | Tests, single-process dev |
| `PostgresStore` | `libs/act-pg/src/PostgresStore.ts` | Production multi-process |
| `SqliteStore` | `libs/act-sqlite/src/SqliteStore.ts` | Embedded, single-node |

### What the framework does NOT promise the adapter

- Connection pooling — the adapter implements it (PG: `pg.Pool`; SQLite: libSQL's built-in)
- Transactions — the adapter wraps multi-step operations as needed
- Schema migration — adapters define their own DDL in `seed()`; users run it explicitly
- Auth/connection strings — adapter constructor takes a config; framework doesn't inspect

## Cache contract

```ts no-check
interface Cache extends Disposable {
  get<TState>(stream): Promise<CacheEntry<TState> | undefined>;
  set<TState>(stream, entry): Promise<void>;
  invalidate(stream): Promise<void>;
  clear(): Promise<void>;
}

interface CacheEntry<TState> {
  readonly stream: string; // the key, so an entry is self-describing in flight
  readonly state: TState;
  readonly version: number;
  readonly event_id: number;
  readonly patches: number;
  readonly snaps: number;
}
```

### Invariants

- **`get` is a hint, not a contract**: the cache may return undefined at any time (eviction, network failure for a Redis-backed adapter, cold start). The framework treats `undefined` the same as a logical miss and falls back to store replay.
- **`set` is best-effort**: failures are logged but don't propagate. The cache is an optimization, not source of truth.
- **`invalidate` should be reliable**: when called after `ConcurrencyError`, the framework relies on the entry being gone. A failed `invalidate` followed by a `get` returning the old entry would surface stale state. Adapters should treat this as a critical path.
- **Async by design**: the interface is async even for in-memory implementations. Don't optimize away the async — Redis/external caches need it.

### Concrete adapters

| Adapter | Where | Use case |
|---|---|---|
| `InMemoryCache` | `libs/act/src/adapters/in-memory-cache.ts` | Single-process; LRU, default `maxSize: 1000` |

For distributed deployments, a Redis-backed adapter is the natural extension. Not provided in this repo because Redis-vs-Memcached-vs-other choice is app-specific.

## Logger contract

```ts
interface Logger extends Disposable {
  level: string;
  // Each level overloads on (obj, msg?) and (msg) — see ports.ts
  fatal(obj: unknown, msg?: string): void;
  fatal(msg: string): void;
  // ... error, warn, info, debug, trace follow the same pair of overloads
  child(bindings: Record<string, unknown>): Logger;
}
```

### Invariants

- **No-throw**: log calls must never throw. A misbehaving logger crashing the framework is the classic operability footgun.
- **Level gating**: levels above `level` should be no-ops. The `tracing` module checks `logger.level === "trace"` to decide whether to instrument event-sourcing and drain ops with breadcrumb logs. Lying about the level disables tracing silently.
- **`child(bindings)` returns a logger that forwards to the same sink with merged bindings**. Used by `Act.create_correlations` and similar to add a per-instance binding (e.g., `correlationId`).

### Concrete adapters

| Adapter | Where | Use case |
|---|---|---|
| `ConsoleLogger` | `libs/act/src/adapters/console-logger.ts` | Default. JSON in production, colorized human-readable in dev. Zero deps. |
| `PinoLogger` | `libs/act-pino/src/index.ts` | Production deployments using pino's transport ecosystem. |

## Wiring it together — a minimal app

```ts no-check
import { act, store, cache, log, dispose } from "@rotorsoft/act";
import { PostgresStore } from "@rotorsoft/act-pg";
import { InMemoryCache } from "@rotorsoft/act";  // re-exported from main
import { PinoLogger } from "@rotorsoft/act-pino";

// 1. Wire ports BEFORE constructing Act
log(new PinoLogger({ level: "info" }));
store(new PostgresStore({ host: "...", database: "...", schema: "events", table: "events" }));
cache(new InMemoryCache({ maxSize: 5000 }));

// 2. Build the Act instance
const app = act()
  .withState(...)
  .build();

// 3. Run as normal
await app.do("...", target, payload);
```

If any port is left to default, the framework wires the in-memory implementation for that port. Useful for tests; deliberate for production.

## Scoped ports (per-Act)

The singleton path covers the common case: one Act instance per process, one store, one cache. When you need more than one Act in the same process — each with its own store and/or cache — pass an `ActOptions.scoped` bag at build time:

```ts no-check
import { act, InMemoryCache } from "@rotorsoft/act";
import { PostgresStore } from "@rotorsoft/act-pg";

const tenantApp = act()
  .withState(...)
  .build({
    scoped: {
      store: new PostgresStore({ schema: "tenant_a" }),
      cache: new InMemoryCache({ maxSize: 5000 }),
    },
  });
```

The framework threads the bag through `AsyncLocalStorage` and wraps every public Act method (`do`, `load`, `query`, `drain`, `settle`, `close`, ...) so internal `store()`/`cache()` calls resolve to the scoped ports transparently. Adapters are unchanged. Both `store` and `cache` are required together — sharing a single cache across two distinct stores would collide on stream-keyed entries.

### One store, one application

Each Act in the pattern above gets **its own store**. That is not incidental — it is the constraint.

**Two Acts built from *different registries* must never share one store**, whether through `scoped` or through the singleton `store()`. Correlation keeps a single shared read cursor per store, and a correlator key with no row of its own is seeded from that shared position. So a second application's first pass resumes wherever the first application had read to, and every event below that point is never correlated: the reactions for them do not run late, they **never run**, and nothing is logged ([#1581](https://github.com/Rotorsoft/act-root/issues/1581)).

The framework does not detect this, and cannot do so cheaply. The obvious signal — a correlator key sitting behind the shared cursor — is produced by a perfectly healthy single application, because an explicit `app.correlate()` is unleased and advances only the shared cursor. The same reading therefore means both "someone else is here" and "nothing is wrong," so an automatic warning would fire on ordinary restarts. Detecting it properly means seeing the other key, and no `Store` call exposes more than the caller's own row.

What is safe, and what is not:

| | |
|---|---|
| Many processes running the **same** application over one store | ✅ the core scaling model — same registry, same correlator key |
| Two Acts built from the **same builder** (multi-tenant, A/B), each with its own store | ✅ the pattern above |
| An empty Act wrapping a raw store for tooling (the inspector's `restore` path) | ✅ a registry with no reactions resolves no targets and never writes a checkpoint |
| Two **different** registries over one store | ❌ silently loses reactions |

If one store is currently serving several bounded contexts, [recipes/scaling/split-stores](https://github.com/Rotorsoft/act-root/blob/master/recipes/scaling/split-stores/README.md) is the migration: one Act per context, each with its own store and cache.

### The shared-builder pattern (multi-tenant, A/B testing)

For more than a couple of Acts — multi-tenant SaaS, parallel test workers, side-by-side store experiments — hold the builder in a constant and call `.build({ scoped: ... })` once per tenant. The builder is reusable: the first build performs one-time work (projection merge, deprecation scan, startup advisory) and subsequent builds reuse the merged registry to produce independent Acts.

```ts no-check
import { act, InMemoryCache, projection, state } from "@rotorsoft/act";
import { PostgresStore } from "@rotorsoft/act-pg";

// Compose the blueprint once — no `.build()` yet.
const tenantBuilder = act()
  .withState(Order)
  .withState(Customer)
  .withProjection(OrderProjection)
  .on("OrderPlaced").do(reduceInventory).to("inventory");

// One Act per tenant, each with its own store + cache.
const apps = new Map<string, ReturnType<typeof tenantBuilder.build>>();
for (const tenant of tenants) {
  apps.set(
    tenant,
    tenantBuilder.build({
      scoped: {
        store: new PostgresStore({ schema: tenant }),
        cache: new InMemoryCache({ maxSize: 5000 }),
      },
    })
  );
}

// New tenants signing up mid-process can call `.build()` lazily too.
function onTenantSignup(tenant: string) {
  apps.set(
    tenant,
    tenantBuilder.build({
      scoped: {
        store: new PostgresStore({ schema: tenant }),
        cache: new InMemoryCache({ maxSize: 5000 }),
      },
    })
  );
}
```

The per-Act mutable state (drain controller, correlate cycle, settle loop, notify subscription, lifecycle emitter) is constructed fresh on every `.build()`. So are **state-projection fold handlers** (`projection(...).of(State)`) — each one owns a per-stream cache of folded state, so every Act gets its own; they also pick up that build's own `validateFoldedState` setting. The shared blueprint (registry, states map, stateless projection batch handlers, deprecation set) is read-only post-build and is passed by reference to each Act — multi-tenant memory cost is dominated by the per-Act mutable state, not by N copies of the registry.

A/B store experiments are the same pattern with `tenants` replaced by the experiment arms — `apps.set("control", build({scoped: oldStore + oldCache}))` and `apps.set("candidate", build({scoped: newStore + newCache}))`.

### When this is necessary

Concrete scenarios:

- **Multi-tenant SaaS in one process.** Each tenant gets a dedicated store (e.g., per-schema `PostgresStore` on a shared host, or one DB per tenant) and a dedicated cache. The application code stays singleton-style — no parameter threading — because internals read `store()`/`cache()` and the ALS context dispatches to the right tenant on every call.
- **Parallel test workers in one process.** Vitest's `--threads=false` worker model and integration tests that want strict isolation without spinning up a process per test. Each test builds its own Act with a fresh `InMemoryStore` + `InMemoryCache`, and concurrent test bodies don't leak through the singleton.
- **Hybrid storage per bounded context.** A monolith where the "orders" context lives in Postgres but "audit" lives in SQLite (or vice versa). Each bounded context gets its own Act bound to its own backing store. Reactions across contexts go through whatever cross-process mechanism the operator wires (HTTP, message bus, or `Store.notify` if both speak the same protocol).
- **Side-by-side store experiments.** Running an existing Act on `PostgresStore` and a candidate Act on a new adapter in parallel to compare correctness or performance under live traffic — both pinned to the same process so they see the same input stream.

For the scaling angle — when to split one overloaded store into per-context or per-tenant stores, what you give up (cross-store total order, drain-carried cross-context reactions), and how the move compares to partitioning — see the [split-stores recipe](https://github.com/Rotorsoft/act-root/blob/master/recipes/scaling/split-stores/README.md).

### When *not* to use it

- **Single-tenant single-store apps.** Use the singleton path. The scoped overlay is invisible against everyday work but it still adds an `AsyncLocalStorage.run()` wrap on every method call; there's no reason to opt in if you don't need isolation.
- **Different *defaults* on the same store.** If the goal is just "use a different cache size" or "use a different log level," configure that via the adapter constructor on the singleton path. Scoped ports are for distinct adapter instances.

### Contracts and caveats

- **Notify subscriptions bind to the scoped store at construction.** `Store.notify` is wired once per Act, against `options.scoped.store` when scoped or the singleton otherwise. Same as the singleton case: late injection after `build()` doesn't take effect.
- **Lifecycle is the operator's.** Scoped adapters are *not* registered with the framework's `dispose()` registry. You own them — dispose them explicitly (or wrap your own `dispose()` callback that does). The singleton registry only tracks adapters installed via `store(adapter)` / `cache(adapter)` / `log(adapter)`.
- **Logger stays singleton.** `ActOptions.scoped` doesn't include a logger; all Acts in a process share `log()`. Per-Act logger overrides aren't required by current scenarios — add via child binding (`log().child({ tenant: ... })`) at the call site if you need correlation.
- **Performance.** ALS adds no measurable overhead in modern Node — the port getter is ~65 ns whether scoped or not, and `app.do()` / `app.load()` show no difference between scoped and unscoped Acts. See [`libs/act/PERFORMANCE.md` § Per-Act scoped ports](https://github.com/Rotorsoft/act-root/blob/master/libs/act/PERFORMANCE.md).

## `IAct` is a public surface too

The three port contracts above are the *infrastructure* extension points — replace the in-memory default with PostgreSQL, swap the LRU cache for Redis, drop in pino instead of `console`. But `IAct` itself (the orchestrator's public interface) is also load-bearing for a different class of extension: HTTP transports that wrap an Act registry without owning it.

`@rotorsoft/act-http`'s auto-generated API surfaces (`/trpc`, `/hono`, `/openapi`) take a built `IAct` instance and walk its `registry.actions` to emit one route per action. Each route resolves an actor + stream from the request and calls `app.do(action, target, payload)` — `app.do`'s signature (`(action: string, target: Target, payload: unknown) => Promise<Snapshot[]>`) is the contract those generators depend on. Same for `app.query`, `app.query_array`, `app.load`, and the registry shape on `app.registry.actions`.

That makes `IAct` part of the public surface for the package as much as the port contracts are. `STABILITY.md` already covers it: `libs/act/src/act.ts` (the `IAct` interface and lifecycle event shapes) is listed alongside `libs/act/src/types/ports.ts` as a charter-covered surface. Changes to `IAct.do` / `query` / `query_array` / `registry.actions` shape need the same additive-vs-breaking analysis as a port-contract change, with the same migration-note discipline when they're breaking. See the [auto-generated API guide](../guides/auto-generated-api.md) for the consumer side.

## Pointers

- `libs/act/src/ports.ts` — `port()` factory and the three default ports
- `libs/act/src/types/ports.ts` — `Store`, `Cache`, `Logger`, `Disposable` contracts
- `libs/act/src/adapters/` — default in-memory implementations of all three
- `libs/act-pg/src/PostgresStore.ts`, `libs/act-sqlite/src/SqliteStore.ts`, `libs/act-pino/src/index.ts` — production adapters
- `libs/act-pg/test/stress/` — multi-process stress harness exercising the Store contract under contention; useful as a worked example of which invariants the framework actually depends on
