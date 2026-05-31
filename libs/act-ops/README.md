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
import { InMemoryIdempotencyStore } from "@rotorsoft/act-ops/idempotency";

// Either set ttlMs explicitly…
const dedup = new InMemoryIdempotencyStore({
  ttlMs: 24 * 60 * 60 * 1000,  // 24h covers any reasonable retry envelope
  maxEntries: 50_000,
});

// …or describe the sender's retry profile and let the store size
// the dedup window correctly (per-retry backoff + per-attempt
// timeouts × default 4× safety factor; jitter honored).
const sized = new InMemoryIdempotencyStore({
  retryProfile: {
    maxRetries: 5,
    backoff: { strategy: "exponential", baseMs: 200, maxMs: 30_000 },
    timeoutMs: 2_000,
  },
  maxEntries: 50_000,
});

// In any receiver — tRPC, Express, Fastify, Hono, a Kafka consumer, …
const key = extractIdempotencyKeyFromHeaders(req);
const fresh = dedup.claim(key);
if (!fresh) return replyDedupedWithoutSideEffects();
await applyEventToAggregate(event);
```

`claim` is the entire contract — atomically acquire the right to process this key, return whether the caller won the claim. One call. No separate `has` / `put` dance. The verb mirrors `Store.claim`'s lease semantic from `@rotorsoft/act`: there, competing workers race for the right to drain a stream; here, competing requests race for the right to be the canonical first-time delivery for an `Idempotency-Key`. One caller wins; the others learn the claim is already taken and treat their request as a duplicate.

The in-memory implementation is sync; durable adapters (Postgres, Redis) return a `Promise<boolean>` — the port's union return type covers both, so the call site is identical.

The `retryProfile` option captures the math that every receiver otherwise computes by hand and many get wrong — the dedup window has to outlast the sender's full retry envelope, otherwise a key expires before the sender finishes retrying and the side effect runs twice. Pass the sender's `{ maxRetries, backoff?, timeoutMs }` and the store sizes the window for you. The full math (per-retry sums per strategy, jitter worst-case 1.5×, default 4× safety factor) is documented inline on `RetryProfile` and worked through in the [external integration guide](https://rotorsoft.github.io/act-root/docs/guides/external-integration#ttl-sizing).

## Subpath layout

The package follows a subpath-export-per-domain shape, matching `@rotorsoft/act-http`. All idempotency primitives ship from `@rotorsoft/act-ops/idempotency`; future domains (poison-message classifiers, retry-budget helpers, …) will land on their own subpaths (`@rotorsoft/act-ops/poison`, `@rotorsoft/act-ops/retry`). Each subpath is its own ESM/CJS entry — pay for what you import.

## API — `@rotorsoft/act-ops/idempotency`

- **`IdempotencyStore`** — the contract. One method, `claim(key, now?): boolean | Promise<boolean>`. Returns `true` when the key was fresh (and is now recorded), `false` when it was already present. Implementations should preserve records for at least the sender's full retry envelope.
- **`InMemoryIdempotencyStore`** — bounded LRU + TTL reference implementation. Single-process only; for multi-process receivers swap for a durable adapter (Postgres unique index, Redis `SET NX`, …) without changing the call site.
- **`InMemoryIdempotencyStoreOptions`** — `{ ttlMs?, retryProfile?, maxEntries? }`. Set `ttlMs` directly, or pass `retryProfile` and the store derives the safe window. When both are supplied, `ttlMs` wins.
- **`RetryProfile`** — `{ maxRetries, backoff?, timeoutMs, safetyFactor? }`. The sender's retry shape, used by `InMemoryIdempotencyStore` to derive its window. The `backoff` field is typed structurally inline so it accepts the framework's `BackoffOptions` without a cast — but this package doesn't reinvent or re-export the type, preserving the zero-act-dep property.
- **`minSafeTtl(profile): number`** — the derivation the in-memory store uses internally, exported for **adapter authors**. Durable adapters (e.g. the future `PostgresIdempotencyStore`) import this from `@rotorsoft/act-ops/idempotency` so every adapter applies the same math when given a `retryProfile` option. Application developers don't typically call this directly — they pass `retryProfile` to the store and let the store call it.

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
