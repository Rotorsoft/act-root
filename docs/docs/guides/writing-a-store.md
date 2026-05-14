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
- `query(callback, query?)` — stream events to a callback with filter, range, regex, and `with_snaps` support
- `claim(lagging, leading, by, millis)` — atomically discover and lease streams for reaction processing (the workhorse of `drain`)
- `subscribe(streams)` — register streams so they become claimable
- `ack(leases)` / `block(leases)` — release a lease normally or after persistent failure
- `reset(streams)` / `prioritize(filter, n)` / `truncate(targets)` — operator-facing primitives
- `query_streams(callback, query?)` — read-only introspection (operational dashboards)
- `notify(handler)` — *optional* cross-process commit notifications

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

The TCK and the interface evolve together. When the framework adds, removes, or changes a method on `Store` (e.g., the planned `Store.query_heads(streams)` primitive in [#639](https://github.com/Rotorsoft/act-root/issues/639)):

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
