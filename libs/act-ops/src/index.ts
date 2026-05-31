/**
 * @packageDocumentation
 * @module act-ops
 *
 * Operational primitives for act apps and act-independent receivers.
 *
 * The package's first surface is the **receiver-side idempotency
 * contract**: an {@link IdempotencyStore} port plus an
 * {@link InMemoryIdempotencyStore} reference implementation. Both Act
 * apps and non-Act receivers (forwarded-bus consumers, framework-
 * agnostic HTTP endpoints) install `@rotorsoft/act-ops` to speak the
 * dedup contract — the package has no runtime or peer dependency on
 * `@rotorsoft/act`, so non-Act consumers don't pay for the orchestrator
 * just to honor an `Idempotency-Key`.
 *
 * Durable adapters (Postgres, Redis) implement the same port in their
 * own packages and slot in transparently. The framework-agnostic
 * receiver middleware (`#744`) consumes the port from here without
 * binding to a specific adapter.
 */

export {
  InMemoryIdempotencyStore,
  type InMemoryIdempotencyStoreOptions,
} from "./idempotency/in-memory.js";
export type { IdempotencyStore } from "./idempotency/port.js";
