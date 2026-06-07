import { createHmac } from "node:crypto";

/**
 * Compute the HMAC-SHA256 signature for an outbound webhook request.
 *
 * The signed payload is `${timestamp}.${body}` — Stripe-style. The
 * timestamp is included so the receiver can reject replays via a
 * window check, and the dot separator prevents `timestamp + body`
 * ambiguity (12 + 345 vs 123 + 45).
 *
 * Returns `{ signature, timestamp }` so the webhook helper can attach
 * both as headers — `X-Webhook-Signature: sha256=<hex>` and
 * `X-Webhook-Timestamp: <unix-seconds>` — for the receiver to verify
 * via `verify_webhook` from `@rotorsoft/act-http/receiver`.
 *
 * `now` is exposed for tests; production callers should leave it
 * undefined so wall-clock is used.
 *
 * @internal Reachable from tests via the source path. Not re-exported
 *   from the package's `./webhook` entry — the webhook helper calls
 *   it internally, and operators don't need it directly.
 */
export function sign_request(
  body: string,
  secret: string,
  now: number = Math.floor(Date.now() / 1000)
): { signature: string; timestamp: string } {
  const timestamp = String(now);
  const payload = `${timestamp}.${body}`;
  const hex = createHmac("sha256", secret).update(payload).digest("hex");
  return { signature: `sha256=${hex}`, timestamp };
}
