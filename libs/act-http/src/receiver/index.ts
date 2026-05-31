/**
 * @packageDocumentation
 * @module act-http/receiver
 *
 * Server-side helpers for the inbound HTTP role — the receiver that
 * sits on the other end of an `@rotorsoft/act-http/webhook` POST.
 *
 * Today the subpath hosts the case-insensitive `Idempotency-Key`
 * parser. The framework-agnostic middleware that consumes
 * `IdempotencyStore.claim` from `@rotorsoft/act-ops/idempotency`
 * lands in #744 (ACT-1116) alongside per-framework adapters
 * (tRPC / Express / Fastify / Hono).
 *
 * Sibling subpaths in the same package:
 *
 * - `@rotorsoft/act-http/webhook` — the sender side: outbound POSTs,
 *   automatic `Idempotency-Key`, status-classified retries.
 * - `@rotorsoft/act-http/sse` — incremental state broadcast over
 *   Server-Sent Events.
 *
 * The receiver subpath ships from the same package as `/webhook` so
 * a service that both sends and receives webhooks installs one
 * dependency. The dedup contract that links them lives in
 * `@rotorsoft/act-ops/idempotency`.
 */

export { extractIdempotencyKey } from "./extract.js";
