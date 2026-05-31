/**
 * @packageDocumentation
 * @module act-http/receiver
 *
 * Server-side helpers for the inbound HTTP role — the receiver that
 * sits on the other end of an `@rotorsoft/act-http/webhook` POST.
 *
 * The subpath hosts two primitives today:
 *
 * - {@link extractIdempotencyKey} — case-insensitive
 *   `Idempotency-Key` parser; pair with `IdempotencyStore.claim`
 *   from `@rotorsoft/act-ops/idempotency` for dedup.
 * - {@link verifyWebhook} — HMAC-SHA256 signature + timestamp
 *   verifier; pair with `webhook({ secret })` from
 *   `@rotorsoft/act-http/webhook` for authenticated, replay-resistant
 *   delivery.
 *
 * The framework-agnostic middleware that wires these into request
 * handlers, plus per-framework adapters (tRPC / Express / Fastify /
 * Hono), lands in #744 (ACT-1116).
 *
 * Sibling subpaths in the same package:
 *
 * - `@rotorsoft/act-http/webhook` — the sender side: outbound POSTs,
 *   automatic `Idempotency-Key`, status-classified retries, optional
 *   HMAC signing.
 * - `@rotorsoft/act-http/sse` — incremental state broadcast over
 *   Server-Sent Events.
 *
 * The receiver subpath ships from the same package as `/webhook` so
 * a service that both sends and receives webhooks installs one
 * dependency. The dedup contract that links them lives in
 * `@rotorsoft/act-ops/idempotency`.
 */

export {
  type CheckFailureReason,
  type CheckResult,
  type CheckWebhookOptions,
  checkWebhook,
} from "./check.js";
export { extractIdempotencyKey } from "./extract.js";
export { webhookReceiver } from "./start.js";
export {
  type VerifyOptions,
  type VerifyResult,
  verifyWebhook,
} from "./verify.js";
