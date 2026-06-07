/**
 * @packageDocumentation
 * @module act-http/api
 *
 * Shared utilities for the act-http auto-generated API surfaces.
 * Three concerns that every transport (tRPC, Hono, OpenAPI) has to
 * address — actor extraction, error envelope mapping,
 * `Idempotency-Key` wiring — defined once here and composed by each
 * transport sibling subpath.
 *
 * - {@link ActorExtractor} — the host-supplied closure that resolves
 *   an `Actor` from an incoming request. Auth (JWT, session, API
 *   key) stays in the host; the package only asks for this one
 *   function.
 * - {@link ApiError}, {@link ERROR_MAP}, {@link to_api_error} — the
 *   uniform error envelope and the status/code mapping every
 *   transport uses. Cross-transport consistency by construction.
 * - {@link with_idempotency} — the helper that wraps action handlers
 *   in an `Idempotency-Key` claim. Reuses the
 *   `@rotorsoft/act-ops/idempotency` contract that
 *   `@rotorsoft/act-http/receiver` already speaks, so receivers and
 *   generated APIs share one `IdempotencyStore` implementation.
 *
 * Sibling subpaths in the same package consume the utilities here:
 *
 * - `@rotorsoft/act-http/trpc` — tRPC adapter (#843).
 * - `@rotorsoft/act-http/hono` — Hono adapter (#844).
 * - `@rotorsoft/act-http/openapi` — OpenAPI emitter (#845).
 *
 * Existing siblings unrelated to the generated-API work:
 *
 * - `@rotorsoft/act-http/webhook` — outbound POST delivery.
 * - `@rotorsoft/act-http/sse` — incremental state broadcast.
 * - `@rotorsoft/act-http/receiver` — inbound webhook ingestion.
 */

export type { ActorExtractor } from "./actor.js";
export {
  type ApiError,
  ERROR_MAP,
  type ErrorMapEntry,
  to_api_error,
} from "./errors.js";
export { type IdempotencyResult, with_idempotency } from "./idempotency.js";
