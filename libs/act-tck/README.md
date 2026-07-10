# @rotorsoft/act-tck

[![NPM Version](https://img.shields.io/npm/v/@rotorsoft/act-tck.svg)](https://www.npmjs.com/package/@rotorsoft/act-tck)
[![NPM Downloads](https://img.shields.io/npm/dm/@rotorsoft/act-tck.svg)](https://www.npmjs.com/package/@rotorsoft/act-tck)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

_Test Compatibility Kit for the `Store`, `Cache`, and `Logger` ports of [@rotorsoft/act](https://www.npmjs.com/package/@rotorsoft/act). Lane conformance suite (claim filter, subscribe UPSERT, ack/block round-trip) added in v0.4.0 ([ACT-1103](https://github.com/Rotorsoft/act-root/issues/733))._

## Why this package

A port without an executable contract is undefined behavior. Act has three pluggable ports (event store, snapshot cache, logger), each with multiple in-tree adapters and an open door for third-party implementations. Before this package, every adapter's test file independently re-stated what the contract was — tribal knowledge, not a spec.

`act-tck` turns the contract into a runnable spec. Drop it into your adapter's test file, point it at your implementation, and vitest will execute the same conformance suite the in-tree adapters pass. New port methods land here first; adapters add capability flags and opt in.

## Installation

```bash
pnpm add -D @rotorsoft/act-tck
```

The kit is a dev dependency — it ships test code, not runtime code.

## Quick start

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

That's the whole integration. `run*Tck` calls vitest's `describe`/`it` internally; your test runner drives execution. A fixed Counter-style fixture domain keeps tests deterministic and self-contained.

## API

- **`runStoreTck(options)`** — every `Store` method, capability-gated where optional.
- **`runStoreDifferentialTck(options)`** — drives a family of randomized, seeded workloads against multiple `Store` instances and asserts identical normalized output (event order, `with_snaps` floor, `query_stats` / `query_streams`) for every workload. Catches cross-adapter drift a single-adapter suite can't.
- **`runStorePropertyTck(options)`** — property-based store invariants (commit version monotonicity, claim/lease no-leak, watermark monotonicity, block exclusion) over fast-check-generated sequences.
- **`runCacheTck(options)`** — every `Cache` method, cross-stream isolation, dispose idempotency.
- **`runCacheDifferentialTck(options)`** — drives randomized `set` / `invalidate` / `clear` workloads against multiple `Cache` instances and asserts identical observable `get()` after every op.
- **`runLoggerTck(options)`** — structural smoke test of the `Logger` contract.
- **`runLoggerDifferentialTck(options)`** — drives the identical call surface against multiple `Logger` instances and asserts robustness + structural parity (what throws, what conforms).
- **`runStabilityTck(options)`** — snapshot-based public-API stability gate. Catches accidental rename / removal / signature drift on a package's public surface before it merges.
- **`StoreCapabilities`** / **`CacheCapabilities`** / **`LoggerCapabilities`** — flag types for opting into optional surface (e.g., `Store.notify`).
- Fixture helpers re-exported from `@rotorsoft/act-tck/fixtures` for adapter-specific tests that want the same Counter domain.

## What's covered

### `runStoreTck`

Every method on the `Store` interface in [`libs/act/src/types/ports.ts`](https://github.com/Rotorsoft/act-root/blob/master/libs/act/src/types/ports.ts):

- `commit` — single + multi-event commits, optimistic concurrency, preserved state on rejection
- `query` — stream, names, correlation, before/after, created_after/before, limit, with_snaps, stream_exact, backward traversal
- `subscribe` — idempotent re-subscribe
- `claim` / `ack` — lease lifecycle, dual frontiers, leased streams not double-claimed, ack rejected from wrong holder, exact-source has-work matching, timed-out-lease retry accounting
- `block` — blocked streams hidden from claim, same-drainer-only enforcement
- `reset` — restart watermarks (including blocked), no-op for missing
- `prioritize` — bulk priority updates by filter
- `truncate` — snapshot vs tombstone seeding, empty inputs, missing streams
- `query_streams` — filters, exact-match, pagination, blocked
- `query_stats` — array + filter forms, opt-in count/tail/names, exclude + before, snapshot count via `names`
- `notify` (capability-gated) — cross-instance delivery, self-filtering (an instance never receives its own commits), one notification per commit transaction with the full event batch; requires the `factory` to produce instances sharing one backing store

### `runStoreDifferentialTck`

Where `runStoreTck` proves each adapter honors the contract in isolation, the differential harness proves they honor it _identically_. It replays a **family of randomized, seeded workloads** — commits, inline snapshots, truncates, subscriptions, in a seed-varying order — against two or more `Store` instances (in-memory as the reference, durable adapters as comparands), then asserts their **normalized** outputs match exactly for every workload. Each workload runs from a distinct seed (`seed`, `seed + 1`, …, `seed + runs - 1`), so divergence is hunted across the input space rather than one fixed script; a failing workload names its seed for replay:

- global forward `query` order
- per-stream `with_snaps` snapshot floor
- backward traversal order
- `query_stats` head / tail / count / names (plus filter-form key order)
- `query_streams` rows (source, watermark, blocked, priority, lane)

Normalization drops only what legitimately differs between stores (absolute event ids, `created` timestamps, correlation/causation uuids). A one-adapter `with_snaps` regression surfaces as a diff against the reference. Wire it with the in-memory store first:

```ts
import { runStoreDifferentialTck } from "@rotorsoft/act-tck";
import { InMemoryStore } from "@rotorsoft/act";
import { MysqlStore } from "../src/index.js";

runStoreDifferentialTck({
  name: "InMemory vs Mysql",
  stores: [
    { name: "InMemoryStore", factory: () => new InMemoryStore() },
    { name: "MysqlStore", factory: () => new MysqlStore({ /* … */ }) },
  ],
});
```

### `runCacheTck`

Every method on the `Cache` interface: `get` on unset stream returns `undefined`; `set` then `get` round-trip; `set` overwrites; `invalidate` removes one stream, leaves others; `invalidate`/`clear` no-op on absent state; `clear` empties every stream; cross-stream isolation; `dispose` idempotency.

### `runCacheDifferentialTck`

The `Cache` analog of the store differential. It drives a family of randomized, seeded workloads (`set` / `invalidate` / `clear` over a small key set kept within capacity, so eviction — an adapter policy, not a contract guarantee — never enters the comparison) against two or more `Cache` instances and asserts their observable `get()` snapshot is identical after **every** operation. A cache that mishandles overwrite ordering, leaks an invalidated key, or clears partially diverges on the exact op that broke it.

```ts
import { runCacheDifferentialTck } from "@rotorsoft/act-tck";
import { InMemoryCache } from "@rotorsoft/act";
import { RedisCache } from "../src/index.js";

runCacheDifferentialTck({
  name: "InMemory vs Redis",
  caches: [
    { name: "InMemoryCache", factory: () => new InMemoryCache({ maxSize: 1000 }) },
    { name: "RedisCache", factory: () => new RedisCache({ /* … */ }) },
  ],
});
```

### `runLoggerTck`

Structural smoke test of the `Logger` interface: `level` is a non-empty string; every level method callable with both overload signatures; `null` and cyclic payloads don't throw; `child(bindings)` returns a Logger satisfying the same contract; `dispose` is idempotent and awaitable.

### `runLoggerDifferentialTck`

A logger has no portable output to byte-compare — its format is adapter-specific by design. The meaningful differential is **robustness and structural parity**: driven through the identical call surface (every level, both overloads, `null` + cyclic payloads, child spawning), two implementations must agree on what throws and what conforms. A logger that throws on a cyclic payload the reference tolerates, or returns a non-conforming child, diverges from the reference outcome vector.

```ts
import { runLoggerDifferentialTck } from "@rotorsoft/act-tck";
import { ConsoleLogger } from "@rotorsoft/act";
import { PinoLogger } from "../src/index.js";

runLoggerDifferentialTck({
  name: "Console vs Pino",
  loggers: [
    { name: "ConsoleLogger", factory: () => new ConsoleLogger({ level: "trace" }) },
    { name: "PinoLogger", factory: () => new PinoLogger({ level: "trace" }) },
  ],
});
```

### `runStabilityTck`

Walks the source of every declared entry point, follows relative re-exports recursively, and snapshots the concatenated text via Vitest. Any rename, removed export, or signature change to the public surface shows up as a snapshot diff in the PR — reviewers either accept the change (re-run with `-u`) or push back. Stops at non-relative imports (other packages, `node:*`); each package owns its own snapshot.

```ts
// libs/act-mysql/test/stability.spec.ts
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runStabilityTck } from "@rotorsoft/act-tck";

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

runStabilityTck({
  name: "@rotorsoft/act-mysql",
  entryPoints: { "": path.join(src, "index.ts") },
});
```

The TCK reads source (`.ts`) rather than built `.d.ts` — no prior `pnpm build` required, and the snapshot text matches what reviewers actually read.

## Common patterns

### Capability flags for optional methods

Optional methods are gated so adapters can opt out of features they don't implement:

```ts
runStoreTck({
  name: "MysqlStore",
  factory: () => new MysqlStore({ /* … */ }),
  capabilities: { notify: true }, // adapter implements Store.notify
});
```

### Adding adapter-specific tests alongside the TCK

The TCK validates the contract; adapter-specific edge cases (defensive `rowCount ?? 0` branches, dialect-specific SQL paths) belong in the adapter's own test file. See `libs/act-pg/test/store.error.spec.ts` and `libs/act-sqlite/test/store.error.spec.ts` for the fault-injection patterns the in-tree adapters use to round out the 100% coverage gate.

### When the port interface changes

New / changed methods on `Store`, `Cache`, or `Logger` are added to `libs/act-tck/src/` in lockstep. Optional methods land behind a `Capabilities` flag so existing adapters keep passing until they opt in.

## Compatibility

- **Node**: >=22.18.0
- **Peer**: `@rotorsoft/act` (workspace version), `vitest` >=3.0.9, `zod` ^4.4.3
- **Runtime deps**: none — pure test code

## Stability

Public API governed by the [Act Stability Charter](../../STABILITY.md). The TCK's published surface — `runStoreTck`, `runCacheTck`, `runLoggerTck`, the `Capabilities` types, and the fixture helpers — is now covered by SemVer alongside the `Store`/`Cache`/`Logger` contracts it validates. Charter is **in effect as of 1.0.0**; the milestone tracker is [milestone 1.0](https://github.com/Rotorsoft/act-root/milestone/1).

## Related packages

- **[@rotorsoft/act](https://www.npmjs.com/package/@rotorsoft/act)** — the framework defining the ports this kit validates.
- **[@rotorsoft/act-pg](https://www.npmjs.com/package/@rotorsoft/act-pg)** / **[@rotorsoft/act-sqlite](https://www.npmjs.com/package/@rotorsoft/act-sqlite)** — reference `Store` adapters; both pass `runStoreTck`.
- **[@rotorsoft/act-pino](https://www.npmjs.com/package/@rotorsoft/act-pino)** — reference `Logger` adapter; passes `runLoggerTck`.

The in-tree InMemoryStore / InMemoryCache / ConsoleLogger (bundled with `@rotorsoft/act`) are the first customers — they prove the TCK works before any external adapter ships.

## Documentation

- **[Writing a custom Store adapter](https://github.com/Rotorsoft/act-root/blob/master/docs/docs/guides/writing-a-store.md)** — full walkthrough, with `runStoreTck` as the acceptance harness.
- **[Writing a custom Cache adapter](https://github.com/Rotorsoft/act-root/blob/master/docs/docs/guides/writing-a-cache.md)**.
- **[Writing a custom Logger adapter](https://github.com/Rotorsoft/act-root/blob/master/docs/docs/guides/writing-a-logger.md)**.

## License

MIT
