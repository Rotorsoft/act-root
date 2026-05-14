# @rotorsoft/act-tck

Test Compatibility Kit for the `Store`, `Cache`, and `Logger` ports of [`@rotorsoft/act`](https://www.npmjs.com/package/@rotorsoft/act).

## Why it exists

A port without an executable contract is undefined behavior. The three pluggable ports in `@rotorsoft/act` (event store, snapshot cache, logger) each have multiple in-tree adapters and an open door for third-party implementations. Before this package, each adapter's test file independently re-stated what the contract was — that's tribal knowledge, not a spec. This package turns the contract into a runnable spec a third party can validate themselves against.

## Usage

```ts
// libs/act-mysql/test/store-tck.spec.ts
import { runStoreTck } from "@rotorsoft/act-tck";
import { MysqlStore } from "../src/index.js";

runStoreTck({
  name: "MysqlStore",
  factory: () => new MysqlStore({ host: "localhost", database: "act_tck" }),
  capabilities: { notify: false },
});
```

```ts
// libs/act-redis/test/cache-tck.spec.ts
import { runCacheTck } from "@rotorsoft/act-tck";
import { RedisCache } from "../src/index.js";

runCacheTck({
  name: "RedisCache",
  factory: () => new RedisCache({ url: process.env.REDIS_URL! }),
});
```

```ts
// libs/act-winston/test/logger-tck.spec.ts
import { runLoggerTck } from "@rotorsoft/act-tck";
import { WinstonLogger } from "../src/index.js";

runLoggerTck({
  name: "WinstonLogger",
  factory: () => new WinstonLogger({ level: "trace" }),
});
```

Each `run*Tck` is a function that calls vitest's `describe` and `it` internally. Vitest is a peer dependency — your test runner drives execution. The TCK ships a fixed Counter-style fixture domain so tests are deterministic and self-contained.

## What's covered

### `runStoreTck`

Every method on the `Store` interface in [`libs/act/src/types/ports.ts`](https://github.com/Rotorsoft/act-root/blob/master/libs/act/src/types/ports.ts):

- `commit` — single + multi-event commits, optimistic concurrency, preserved state on rejection
- `query` — stream, names, correlation, before/after, created_after/before, limit, with_snaps, stream_exact, backward traversal
- `subscribe` — idempotent re-subscribe
- `claim` / `ack` — lease lifecycle, dual frontiers, leased streams not double-claimed, ack rejected from wrong holder
- `block` — blocked streams hidden from claim, same-drainer-only enforcement
- `reset` — restart watermarks (including blocked), no-op for missing
- `prioritize` — bulk priority updates by filter
- `truncate` — snapshot vs tombstone seeding, empty inputs, missing streams
- `query_streams` — filters, exact-match, pagination, blocked
- `notify` (capability-gated) — subscribe + dispose smoke test

### `runCacheTck`

Every method on the `Cache` interface:

- `get` on unset stream returns `undefined`
- `set` then `get` round-trip
- `set` overwrites a prior entry
- `invalidate` removes one stream, leaves others
- `invalidate` / `clear` no-op on absent state
- `clear` empties every stream
- Cross-stream isolation
- `dispose` idempotency

### `runLoggerTck`

Structural smoke test of the `Logger` interface:

- `level` is a non-empty string
- Every level method (`fatal`/`error`/`warn`/`info`/`debug`/`trace`) callable with both overload signatures
- `null` and cyclic payloads don't throw
- `child(bindings)` returns a Logger satisfying the same contract; child loggers can themselves spawn children
- `dispose` is idempotent and awaitable

## Capabilities flags

Optional methods (currently just `Store.notify`) are gated by capability flags so adapters can opt out of features they don't implement:

```ts
runStoreTck({
  name: "MysqlStore",
  factory: () => new MysqlStore({ /* … */ }),
  capabilities: {
    notify: true, // adapter implements Store.notify
  },
});
```

## When the port interface changes

When a method is added, removed, or changed on `Store`, `Cache`, or `Logger`, the matching cases in `libs/act-tck/src/` are updated in lockstep. New optional methods land behind a `Capabilities` flag so existing adapters keep passing until they opt in.

## Reference adapters

The in-tree adapters are the first customers of this kit. They prove the TCK works before any external adapter ships:

- [`InMemoryStore`](https://github.com/Rotorsoft/act-root/blob/master/libs/act/src/adapters/in-memory-store.ts), [`InMemoryCache`](https://github.com/Rotorsoft/act-root/blob/master/libs/act/src/adapters/in-memory-cache.ts), [`ConsoleLogger`](https://github.com/Rotorsoft/act-root/blob/master/libs/act/src/adapters/console-logger.ts)
- [`@rotorsoft/act-pg`](https://www.npmjs.com/package/@rotorsoft/act-pg)
- [`@rotorsoft/act-sqlite`](https://www.npmjs.com/package/@rotorsoft/act-sqlite)
- [`@rotorsoft/act-pino`](https://www.npmjs.com/package/@rotorsoft/act-pino)

## See also

- [Writing a custom Store adapter](https://github.com/Rotorsoft/act-root/blob/master/docs/docs/guides/writing-a-store.md)
- [Writing a custom Cache adapter](https://github.com/Rotorsoft/act-root/blob/master/docs/docs/guides/writing-a-cache.md)
- [Writing a custom Logger adapter](https://github.com/Rotorsoft/act-root/blob/master/docs/docs/guides/writing-a-logger.md)

## License

MIT
