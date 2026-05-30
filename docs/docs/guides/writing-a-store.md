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
- `query(callback, query?)` — stream events to a callback with filter, range, regex, and `with_snaps` support. Respecting the `after` / `limit` pair is what gives `scan` bounded-memory restore: the framework paginates by re-issuing `query` per batch, so any adapter that already honors those filters gets memory-safe scans for free
- `claim(lagging, leading, by, millis, lane?)` — atomically discover and lease streams for reaction processing (the workhorse of `drain`); optional `lane` filter for ACT-1103 drain lanes
- `subscribe(streams)` — register streams so they become claimable; each row carries optional `lane` that the adapter UPSERTs on every call (restart-driven re-laning)
- `ack(leases)` / `block(leases)` — release a lease normally or after persistent failure
- `reset(streams)` / `prioritize(filter, n)` / `truncate(targets)` — operator-facing primitives; the `StreamFilter` shape carries an optional `lane` exact-match
- `query_streams(callback, query?)` — read-only introspection (operational dashboards); positions carry their `lane`
- `notify(handler)` — *optional* cross-process commit notifications
- `restore(driver)` — *optional* atomic wipe-and-rebuild from an event source (see below)

Reading the JSDoc on each method is the first step. The TCK is the second.

## The TCK is the spec

`@rotorsoft/act-tck` exports `runStoreTck`, a function you drop into your adapter's vitest suite:

```ts
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

```ts
runStoreTck({
  name: "MysqlStore",
  factory: () => new MysqlStore({ /* … */ }),
  capabilities: { notify: true }, // your adapter implements notify
});
```

When `notify: true`, the TCK runs a structural smoke test (subscribe → dispose) to confirm the optional API is present and well-shaped. Cross-process LISTEN/NOTIFY semantics need two processes and stay in your adapter's own tests.

The `restore` capability is the other opt-in today. Skip it (`capabilities.restore: false` or just omit) and the TCK's restore cases stay parked. Flip it on once you've implemented `Store.restore` — see the next section for the contract.

## Implementing `Store.restore` (optional)

`Store.restore` is the offline wipe-and-rebuild primitive. Capability-gated, because not every backend can atomically wipe and reinsert in one transaction (Kafka-fronted stores, partitioned multi-shard adapters, append-only object-storage logs). If your adapter can hold the operation under a single transaction or equivalent, implementing it earns the inspector's transfer dialog, the framework's cross-adapter migration story, and the compaction path.

### The HOF driver pattern

The signature is intentionally inverted — your adapter is handed a driver function and called with a per-event insert callback that the orchestrator owns:

```ts
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

### TCK opt-in

Once you've implemented the method, flip the capability flag:

```ts
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
│   ├── store-tck.spec.ts     # runStoreTck({ factory: () => new MysqlStore(…) })
│   └── store.error.spec.ts   # MySQL-specific error paths
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

```ts
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
