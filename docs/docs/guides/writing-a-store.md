---
id: writing-a-store
title: Writing a custom Store adapter
---

# Writing a custom Store adapter

`Store` is the persistence port of the framework — every event log, lease table, projection watermark, and stream subscription lives behind it. The shipped adapters are `InMemoryStore`, `@rotorsoft/act-pg` (Postgres), and `@rotorsoft/act-sqlite` (libSQL). If you need another backend (MySQL, MongoDB, DynamoDB, EventStoreDB-as-Act-store, etc.), this guide walks through scaffolding one against the executable contract defined by `@rotorsoft/act-tck`.

## The contract

The interface lives in [`libs/act/src/types/ports.ts`](https://github.com/Rotorsoft/act-root/blob/master/libs/act/src/types/ports.ts):

- `seed()` / `drop()` — initialization and teardown
- `commit(stream, msgs, meta, expectedVersion?)` — append events atomically with optimistic concurrency
- `query(callback, query?)` — stream events to a callback with filter, range, regex, and `with_snaps` support. Respecting the `after` / `limit` pair is what gives `scan` bounded-memory restore: the framework paginates by re-issuing `query` per batch, so any adapter that already honors those filters gets memory-safe scans for free. Stream/source filters must honor the portable regex grammar (`^` / `$` anchors, `.`, `.*`, literal characters — literal `_` / `%` included); if your backend can't express a richer pattern exactly, **throw `ValidationError`** instead of approximating — the TCK's "stream filter grammar" suite enforces both halves ([#1114](https://github.com/Rotorsoft/act-root/issues/1114))
- `claim(lagging, leading, by, millis, lane?)` — atomically discover and lease streams for reaction processing (the workhorse of `drain`); optional `lane` filter for ACT-1103 drain lanes
- `subscribe(streams)` — register streams so they become claimable; each row carries optional `lane` that the adapter UPSERTs on every call (restart-driven re-laning)
- `ack(leases)` / `block(leases)` — release a lease normally or after persistent failure. `ack` doubles as the drain's atomic finalize: a lease carrying `due` (ms since epoch) defers instead of acking — schedule set, watermark held, retry reset — in the same transaction as the batch's acks; deferred entries are excluded from the return value
- `defer(input, deferred_at)` — park streams until a future wall-clock time without advancing their watermark (the deferred-reaction outcome, [#1090](https://github.com/Rotorsoft/act-root/issues/1090)); covered below
- `reset(streams)` / `prioritize(filter, n)` / `truncate(targets)` — operator-facing primitives; the `StreamFilter` shape carries an optional `lane` exact-match
- `query_streams(callback, query?)` — read-only introspection (operational dashboards); positions carry their `lane`. The query gained an optional `source_matches` filter — covered below
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

Adoption is **import, not adapt**: `seed()` assumes Act owns its tables. To
bring existing events in from another system or shape, seed a fresh store
and import via `scan`/`restore` (see § Implementing `Store.restore` below
and the inspector's transfer pipeline) — never point Act at a foreign table
and try to reshape it in place.

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

When `notify: true`, the TCK runs a structural smoke test (subscribe → dispose) to confirm the optional API is present and well-shaped. Cross-process LISTEN/NOTIFY semantics need two processes and stay in your adapter's own tests.

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

Second, the `claim` query gains a guard that skips any stream still parked in the future:

```sql no-check
-- inside claim(...), alongside the blocked = false and lease-expiry predicates
AND (deferred_at IS NULL OR deferred_at <= $now)
```

The second write path for `deferred_at` is `ack` itself: the framework's drain finalizes every cycle with one `ack` call in which deferred leases ride the batch marked with `due`. Branch on it inside your ack transaction — no `due` means advance the watermark and clear the schedule; `due` means set the schedule, keep the watermark, reset retry, and honor the same `leased_by` ownership check as a plain ack. Atomicity here is load-bearing: a cycle's acks landing without its schedules (or vice versa) is exactly the partial state the contract forbids, and the TCK's `describe("ack finalize (due-marked leases)")` block pins it.

That guard is the whole correctness story. Because the skip lives in the shared store and not in worker memory, every competing consumer honors the same deferral — this is durable shared state, not the in-process pacing that reaction backoff does. When the due-time passes, the next `claim` from any worker picks the stream up again at the unchanged watermark, so the same pending event is re-delivered and the handler gets another chance to decide.

`deferred_at` is transient: it must clear the moment the stream makes progress or is recovered. `ack` (the watermark advanced), `block` (the stream is quarantined), `reset` (rewind to replay), and `unblock` (operator recovery) all set it back to `NULL`. Re-deferring simply overwrites it. Keep these clears in lockstep with how you already clear `retry_count` and `error` on those verbs — the same rows, the same statements.

The TCK pins all of this. `store-tck.ts` has a `describe("defer")` block that asserts a deferred stream is hidden from `claim` until its `deferred_at` passes, becomes claimable once the time is in the past, never bumps `retry` while deferred, gets its defer cleared by `reset`, and counts the streams a filter matched. If your adapter passes that block, the deferred-reaction outcome works on your backend with no further wiring.

## Paginating `query_stats` and the `source_matches` hint

Two query options carry semantics that are easy to get subtly wrong, so the contract spells them out and the TCK enforces them.

`query_stats` keyset-paginates by stream name. Order your result by stream name ascending; when `after` is set, return only streams sorting strictly after it (it's exclusive, never inclusive); when `limit` is set, stop after that many streams. The trap is the default: an **omitted** `limit` means unbounded — return every matching stream. That preserves the pre-pagination behavior every caller already relied on, and it's deliberately unlike `query_streams`, whose `limit` defaults to 100. Callers walk pages by feeding the last key they saw back as the next `after`, so your only job is consistent ordering and an honest exclusive cursor.

`query_streams.source_matches` is the inverse of the existing `source` filter and, unlike everything else in the query, it's a *hint*. The `source` filter narrows to subscriptions whose pattern is matched by a value (`source ~ pattern`); `source_matches` narrows to subscriptions whose stored `source` pattern matches one of the supplied stream names (`name ~ source`). A subscription whose `source` is absent or empty has no source constraint and reacts to every stream, so it must always be included no matter what names are passed. If your backend can run regex in that direction, implement it for real — Postgres does it with `EXISTS(SELECT 1 FROM unnest($names) n WHERE n ~ source)` plus the null/empty-source always-match clause. If it can't, **not implementing it is a conformant choice**: ignore the field and return a superset. The framework's only caller (the close-cycle safety probe) re-checks source and target in process, so correctness holds whether you narrow precisely or hand back extra rows. Gate the narrowing tests behind the `source_matches` capability — declare it `true` only when your adapter actually filters, and the TCK leaves the narrowing assertions parked otherwise.

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
