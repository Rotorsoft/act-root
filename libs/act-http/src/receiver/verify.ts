import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Outcome of {@link verifyWebhook}. Either the request signature
 * checks out, or one of five distinct failure reasons applies. Each
 * reason maps to an operator-meaningful telemetry bucket — separated
 * deliberately so dashboards can distinguish "client lost its secret"
 * from "client clock is wrong" from "this is a replay attack."
 */
export type VerifyResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "missing-signature"
        | "missing-timestamp"
        | "stale"
        | "future"
        | "bad-signature";
    };

/** Options for {@link verifyWebhook}. */
export type VerifyOptions = {
  /**
   * Maximum acceptable timestamp drift in either direction, in
   * seconds. Default: 300 (±5 minutes) — matches Stripe / GitHub /
   * Slack conventions. Tightening narrows the replay window;
   * loosening accommodates clients with worse clock sync.
   */
  maxAgeSeconds?: number;
  /**
   * Current Unix-seconds time. Exposed for tests; production
   * callers should leave it undefined so wall-clock is used.
   */
  now?: number;
};

/**
 * Verify an inbound webhook's signature and timestamp against the
 * shared secret. Pair with the sender side: configure
 * `webhook({ secret })` from `@rotorsoft/act-http/webhook`.
 *
 * Returns `{ ok: true }` on success or `{ ok: false; reason }` on
 * failure. The reasons are:
 *
 * - `missing-signature` — no `X-Webhook-Signature` header, value
 *   was an array, or value was empty.
 * - `missing-timestamp` — no `X-Webhook-Timestamp` header, value
 *   was empty, or value isn't a parseable integer.
 * - `stale` — timestamp older than `maxAgeSeconds` from `now`.
 * - `future` — timestamp more than `maxAgeSeconds` ahead of `now`.
 * - `bad-signature` — signature header didn't start with `sha256=`,
 *   wasn't 64 hex chars, or the recomputed HMAC didn't match
 *   (constant-time compare).
 *
 * The signed payload is `${timestamp}.${body}`, so `body` must be
 * the **raw request body bytes**. Any pre-parse normalization
 * (whitespace trimming, JSON re-stringification) would change the
 * hash and reject every otherwise-valid request. Framework adapters
 * in #744 will provide the raw body alongside the parsed one.
 *
 * Uses Node's `crypto.timingSafeEqual` for the final comparison to
 * avoid signature-equality timing attacks.
 */
export function verifyWebhook(
  headers: Record<string, string | string[] | undefined>,
  body: string,
  secret: string,
  options?: VerifyOptions
): VerifyResult {
  const maxAgeSeconds = options?.maxAgeSeconds ?? 300;
  const now = options?.now ?? Math.floor(Date.now() / 1000);

  const signature = pick_header(headers, "x-webhook-signature");
  if (!signature) return { ok: false, reason: "missing-signature" };

  const timestamp_str = pick_header(headers, "x-webhook-timestamp");
  if (!timestamp_str) return { ok: false, reason: "missing-timestamp" };
  const timestamp = Number.parseInt(timestamp_str, 10);
  if (Number.isNaN(timestamp) || String(timestamp) !== timestamp_str) {
    return { ok: false, reason: "missing-timestamp" };
  }

  const delta = now - timestamp;
  if (delta > maxAgeSeconds) return { ok: false, reason: "stale" };
  if (delta < -maxAgeSeconds) return { ok: false, reason: "future" };

  if (!signature.startsWith("sha256=")) {
    return { ok: false, reason: "bad-signature" };
  }
  const provided_hex = signature.slice("sha256=".length);
  if (!/^[0-9a-fA-F]{64}$/.test(provided_hex)) {
    return { ok: false, reason: "bad-signature" };
  }

  const expected_hex = createHmac("sha256", secret)
    .update(`${timestamp_str}.${body}`)
    .digest("hex");

  const a = Buffer.from(provided_hex, "hex");
  const b = Buffer.from(expected_hex, "hex");
  if (!timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad-signature" };
  }

  return { ok: true };
}

function pick_header(
  headers: Record<string, string | string[] | undefined>,
  lower_name: string
): string | undefined {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== lower_name) continue;
    if (Array.isArray(value) || value === undefined || value === "") {
      return undefined;
    }
    return value;
  }
  return undefined;
}
