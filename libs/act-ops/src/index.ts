/**
 * @packageDocumentation
 * @module act-ops
 *
 * Operational primitives for act apps and act-independent receivers.
 *
 * This package is the home for cross-cutting operational concerns —
 * receiver-side idempotency, retry-budget sizing, poison-message
 * classification — that need to ship without a hard dependency on
 * `@rotorsoft/act`. The forwarded-shape bus consumers from ACT-603
 * are the motivating example: a service that processes events off a
 * Kafka topic doesn't run an Act orchestrator, but it still needs
 * the same dedup contract the inline `webhook` reaction enforces.
 *
 * The contract lives here so both sides can speak it.
 *
 * Scope is intentionally narrow: ports + small framework-agnostic
 * helpers. Durable adapters (Postgres, Redis) ship in their own
 * packages and depend on the port declared here.
 */
export {};
