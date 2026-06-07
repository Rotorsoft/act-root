/**
 * @packageDocumentation
 * @module act-ops/idempotency
 *
 * Receiver-side idempotency primitives.
 *
 * - {@link IdempotencyStore} — port: atomically claim a key, report
 *   whether the caller is processing a fresh request or a duplicate.
 * - {@link InMemoryIdempotencyStore} — bounded LRU + TTL reference
 *   implementation. Swap for a durable adapter (Postgres unique
 *   index, Redis `SET NX`) in multi-process receivers without
 *   changing the call site.
 * - {@link min_safe_ttl} — derives the minimum safe dedup window from
 *   the sender's retry profile. The math durable adapters and
 *   `InMemoryIdempotencyStore`'s `retry_profile` option both call.
 * - {@link RetryProfile} — the sender's retry shape, used as input
 *   to `min_safe_ttl` and as the `retry_profile` option on the store.
 *
 * Sibling subpaths (e.g. `@rotorsoft/act-ops/poison`,
 * `@rotorsoft/act-ops/retry`) will host future operational primitives
 * as they land. Each subpath is its own ESM/CJS entry — pay for what
 * you import.
 *
 * The package has no runtime or peer dependency on `@rotorsoft/act`,
 * so non-Act receivers (forwarded-bus consumers, framework-agnostic
 * HTTP endpoints) can install `@rotorsoft/act-ops` and honor an
 * `Idempotency-Key` without pulling in the orchestrator.
 */

export {
  InMemoryIdempotencyStore,
  type InMemoryIdempotencyStoreOptions,
} from "./in-memory.js";
export { min_safe_ttl, type RetryProfile } from "./min-safe-ttl.js";
export type { IdempotencyStore } from "./port.js";
