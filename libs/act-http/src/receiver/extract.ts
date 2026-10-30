/**
 * Pull the `Idempotency-Key` header from a Node-style headers bag,
 * case-insensitive. Returns `undefined` when any of the following
 * carries no usable key:
 *
 * - the header is missing
 * - its value is an array (ambiguous — can't pick one without a
 *   policy the receiver hasn't declared)
 * - its value is the empty string (carries no idempotency
 *   information; structurally equivalent to "no header at all")
 *
 * Pair with `IdempotencyStore.claim` from
 * `@rotorsoft/act-ops/idempotency`: extract the key from the inbound
 * request, claim it on the store, return a `deduped` marker when the
 * claim fails. The receiver subpaths' `webhookMiddleware` wires these
 * together.
 *
 * Validation beyond "is there a usable key?" (length bounds, format
 * checks, normalization) is intentionally out of scope. Receivers
 * picking a policy can layer it on top, or use the middleware's
 * defaults.
 */
export function extractIdempotencyKey(
  headers: Record<string, string | string[] | undefined>
): string | undefined {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "idempotency-key") continue;
    if (Array.isArray(value)) return undefined;
    if (value === "") return undefined;
    return value;
  }
  return undefined;
}
