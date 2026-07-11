import type { IdempotencyStore } from "@rotorsoft/act-ops/idempotency";
import { extractIdempotencyKey } from "./extract.js";
import { type VerifyOptions, verifyWebhook } from "./verify.js";

/**
 * Failure reasons returned by {@link checkWebhook}. The shape splits
 * client/configuration errors (`missing-key`, `empty-body` — HTTP 400)
 * from the five verification failures (authentication errors, HTTP 401)
 * so each maps to its own telemetry bucket. `empty-body` is the
 * misconfigured-raw-parser signal: `secret` is set but the resolved
 * body is empty, so hashing it would compute an HMAC over `${ts}.` and
 * reject every otherwise-valid signed request with a misleading
 * bad-signature — a distinct config error is far easier to diagnose.
 */
export type CheckFailureReason =
  | "missing-key"
  | "empty-body"
  | "missing-signature"
  | "missing-timestamp"
  | "stale"
  | "future"
  | "bad-signature";

/**
 * Outcome of {@link checkWebhook}. Either the request passed every
 * configured check and carries a usable idempotency key, or it
 * failed one of them and the framework adapter should reply with the
 * corresponding HTTP status.
 */
export type CheckResult =
  | { ok: false; status: 400 | 401; reason: CheckFailureReason }
  | { ok: true; key: string; deduped: boolean };

/** Options for {@link checkWebhook}. */
export type CheckWebhookOptions = {
  /** Idempotency store the framework-agnostic core claims the key on. */
  store: IdempotencyStore;
  /**
   * Optional HMAC-SHA256 secret. When set, the request's
   * `X-Webhook-Signature` and `X-Webhook-Timestamp` headers are
   * verified before the dedup claim. When omitted, signature
   * verification is skipped (unsigned receivers).
   */
  secret?: string;
  /**
   * Verification options forwarded to {@link verifyWebhook}. Only
   * meaningful when `secret` is set. Defaults to a ±300-second
   * timestamp window.
   */
  verify?: VerifyOptions;
};

/**
 * Framework-agnostic receiver check: verify the signature (when a
 * secret is configured), extract the `Idempotency-Key`, and claim
 * it on the store. Returns the request's fate as a discriminated
 * union the per-framework adapter translates into the framework's
 * idiomatic 4xx response or context injection.
 *
 * **Order of checks** (matters):
 *
 * 1. Verify signature + timestamp window (when `secret` is set).
 *    Rejecting bad signatures *before* extracting and claiming the
 *    key keeps attacker-supplied keys out of the dedup store —
 *    otherwise a flood of spoofed POSTs would pollute the LRU.
 * 2. Extract the `Idempotency-Key`. Missing → reject with 400.
 * 3. Claim the key on the store. If already seen, return
 *    `{ ok: true; deduped: true }` so the framework adapter can
 *    short-circuit the handler without re-running side effects.
 *
 * The dedup store may be sync (`InMemoryIdempotencyStore`) or async
 * (durable adapters like a future `PostgresIdempotencyStore`); the
 * core awaits unconditionally so both shapes compose cleanly.
 */
export async function checkWebhook(
  headers: Record<string, string | string[] | undefined>,
  body: string,
  options: CheckWebhookOptions
): Promise<CheckResult> {
  if (options.secret !== undefined) {
    // Raw body not captured (default JSON parser ate the bytes) but a
    // secret is configured — hashing the empty string is a guaranteed
    // bad-signature. Surface a distinct configuration error instead of a
    // misleading 401 so the operator mounts the raw-body parser.
    if (body === "") {
      return { ok: false, status: 400, reason: "empty-body" };
    }
    const verification = verifyWebhook(
      headers,
      body,
      options.secret,
      options.verify
    );
    if (!verification.ok) {
      return { ok: false, status: 401, reason: verification.reason };
    }
  }

  const key = extractIdempotencyKey(headers);
  if (!key) return { ok: false, status: 400, reason: "missing-key" };

  const claimed = await options.store.claim(key);
  return { ok: true, key, deduped: !claimed };
}
