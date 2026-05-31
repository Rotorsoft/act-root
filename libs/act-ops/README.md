# @rotorsoft/act-ops

[![NPM Version](https://img.shields.io/npm/v/@rotorsoft/act-ops.svg)](https://www.npmjs.com/package/@rotorsoft/act-ops)
[![NPM Downloads](https://img.shields.io/npm/dm/@rotorsoft/act-ops.svg)](https://www.npmjs.com/package/@rotorsoft/act-ops)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

_Operational primitives for [@rotorsoft/act](https://www.npmjs.com/package/@rotorsoft/act) apps and act-independent receivers — idempotency, retry budgets, poison-message classification._

> **Note.** Package is currently at `0.0.0` — the scaffold is in place but no primitives have shipped yet. The first surface lands with the [ACT-1110 helper extraction tracker](https://github.com/Rotorsoft/act-root/issues/748) (`IdempotencyStore` port + `InMemoryIdempotencyStore`, then `computeMinSafeTtl`). This README will fill in as primitives land — track progress on the [milestone 1.1 board](https://github.com/Rotorsoft/act-root/milestone/4).

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

The first primitive — `IdempotencyStore` + `InMemoryIdempotencyStore` — lands with [#746 / ACT-1118](https://github.com/Rotorsoft/act-root/issues/746). Until then the `0.0.0` scaffold is published only as a placeholder for the tag chain and CI matrix; there is no runtime surface to import.

Once the port is in, the shape looks like this:

```ts
import { InMemoryIdempotencyStore } from "@rotorsoft/act-ops";

const dedup = new InMemoryIdempotencyStore({ ttlMs: 10 * 60_000 });

// In an Express / Fastify / Hono / tRPC receiver:
const key = req.headers["idempotency-key"];
if (await dedup.has(key)) return cached();
await handleEvent(event);
await dedup.put(key);
```

Subsequent tickets in the [ACT-1110 tracker](https://github.com/Rotorsoft/act-root/issues/748) add `computeMinSafeTtl` (deriving a safe dedup window from your reaction's backoff + lease configuration) and the framework-agnostic receiver middleware in `@rotorsoft/act-http`.

## Compatibility

- **Node**: >=22.18.0
- **Peer**: none — does not depend on `@rotorsoft/act`. Designed to be installed by non-Act receivers (bus consumers, HTTP endpoints) and by Act apps alike.
- **Module formats**: ESM (`import`) and CJS (`require`). No side effects.

## Stability

Public API governed by the [Act Stability Charter](../../STABILITY.md) once primitives ship. While the package is in `0.x` everything is provisional — the surface freezes when the first `1.0.0` cuts. The milestone tracker is [milestone 1.1](https://github.com/Rotorsoft/act-root/milestone/4).

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
