# @rotorsoft/act-ops

[![NPM Version](https://img.shields.io/npm/v/@rotorsoft/act-ops.svg)](https://www.npmjs.com/package/@rotorsoft/act-ops)
[![NPM Downloads](https://img.shields.io/npm/dm/@rotorsoft/act-ops.svg)](https://www.npmjs.com/package/@rotorsoft/act-ops)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

_Operational primitives for [@rotorsoft/act](https://www.npmjs.com/package/@rotorsoft/act) apps and act-independent receivers — idempotency, retry budgets, poison-message classification._

## Why this package

Operational concerns that pair with Act — receiver-side idempotency, retry-budget sizing, poison-message classification — show up on both sides of the wire. The inline `webhook` reaction from `@rotorsoft/act-http` enforces dedup with an auto-derived `Idempotency-Key`; the cooperative receiver on the other end has to actually honor it. When the receiver is itself an Act app, it can reach for the same primitives the framework uses internally. When the receiver is something else — a Kafka consumer, an Express endpoint, a queue worker — it should be able to speak the same contract without dragging the orchestrator along.

`@rotorsoft/act-ops` is the home for those primitives. The package has **no dependency on `@rotorsoft/act`** and no peer dep. A service that processes forwarded events off a bus can install `@rotorsoft/act-ops` alone and get a port, an in-memory reference implementation, and the sizing helpers that pair with it. The cost of speaking the contract is one small library, not the full framework.

Durable adapters (Postgres, Redis, etc.) ship in their own packages and depend on the port declared here. `@rotorsoft/act-http`'s receiver middleware consumes the port too. The split mirrors the existing store/cache/logger pattern: the contract lives in one small lib; adapters slot in around it.

## Installation

```bash
pnpm add @rotorsoft/act-ops
```

No peer dependencies. Drop it next to whatever framework — or no framework at all — your receiver runs on.

## Quick start

```ts
import { InMemoryIdempotencyStore } from "@rotorsoft/act-ops";

const dedup = new InMemoryIdempotencyStore({
  ttlMs: 24 * 60 * 60 * 1000,  // dedup window (default: 24h)
  maxEntries: 50_000,           // memory bound (default: 100_000)
});

// In any receiver — tRPC, Express, Fastify, Hono, a Kafka consumer, …
const key = extractIdempotencyKeyFromHeaders(req);
const fresh = dedup.record_if_fresh(key);
if (!fresh) return replyDedupedWithoutSideEffects();
await applyEventToAggregate(event);
```

`record_if_fresh` is the entire contract — atomically record the key and report whether the caller is processing a fresh request or a duplicate. One call. No separate `has` / `put` dance. The in-memory implementation is sync; durable adapters (Postgres, Redis) return a `Promise<boolean>` — the port's union return type covers both, so the call site is identical.

## API

- **`IdempotencyStore`** — the contract. One method, `record_if_fresh(key, now?): boolean | Promise<boolean>`. Returns `true` when the key was fresh (and is now recorded), `false` when it was already present. Implementations should preserve records for at least the sender's full retry envelope.
- **`InMemoryIdempotencyStore`** — bounded LRU + TTL reference implementation. Single-process only; for multi-process receivers swap for a durable adapter (Postgres unique index, Redis `SET NX`, …) without changing the call site.
- **`InMemoryIdempotencyStoreOptions`** — TypeScript type for the constructor's options bag.

## Why a Store and not a Cache

The doc colloquially calls these "cache shapes," but structurally this is **authoritative** storage. Losing a dedup record causes a duplicate side effect — paying the same invoice twice, sending the same email twice, opening the same incident twice — not just a rebuild from a source of truth. In this codebase `Cache` is reserved for "rebuildable" state (the snapshot cache); `Store` is reserved for authoritative state. The idempotency contract sits in the second bucket. Hence `IdempotencyStore`.

The practical implication: when you swap `InMemoryIdempotencyStore` for a durable adapter at deploy time, the durable adapter's *persistence* is the load-bearing property — not its hit rate.

## Compatibility

- **Node**: >=22.18.0
- **Peer**: none — does not depend on `@rotorsoft/act`. Designed to be installed by non-Act receivers (bus consumers, HTTP endpoints) and by Act apps alike.
- **Module formats**: ESM (`import`) and CJS (`require`). No side effects.

## Stability

Public API governed by the [Act Stability Charter](../../STABILITY.md) once primitives stabilise. While the package is in `0.x` everything is provisional — the surface freezes when the first `1.0.0` cuts. The milestone tracker is [milestone 1.1](https://github.com/Rotorsoft/act-root/milestone/4).

## Related packages

- **[@rotorsoft/act](https://www.npmjs.com/package/@rotorsoft/act)** — the framework. Reactions and the inline `webhook` helper produce the requests this package's primitives are designed to dedup on the receiving side.
- **[@rotorsoft/act-http](https://www.npmjs.com/package/@rotorsoft/act-http)** — outbound `webhook` (sets `Idempotency-Key`) and, once #744 lands, the framework-agnostic receiver middleware that consumes the `IdempotencyStore` port declared here.
- **[@rotorsoft/act-pg](https://www.npmjs.com/package/@rotorsoft/act-pg)** / **[@rotorsoft/act-sqlite](https://www.npmjs.com/package/@rotorsoft/act-sqlite)** — store adapters today; future durable `IdempotencyStore` adapters will follow the same packaging pattern.
- **[@rotorsoft/act-tck](https://www.npmjs.com/package/@rotorsoft/act-tck)** — Store / Cache / Logger conformance kit. An `IdempotencyStore` conformance suite will land here in 1.2 alongside a durable adapter.

## Documentation

- **[External integration patterns](https://rotorsoft.github.io/act-root/docs/guides/external-integration)** — inline `webhook` vs forwarded bus, the receiver-side idempotency contract this package implements, the recovery loop.
- **[ACT-1110 helper extraction & act-ops foundation](https://github.com/Rotorsoft/act-root/issues/748)** — milestone 1.1 tracker for the helpers landing here over the next few PRs.

## License

MIT
