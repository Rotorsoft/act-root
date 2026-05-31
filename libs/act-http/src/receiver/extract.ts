/**
 * Pull the `Idempotency-Key` header from a Node-style headers bag,
 * case-insensitive. Returns `undefined` when the header is missing or
 * when its value is an array (ambiguous — can't pick one without a
 * policy the receiver hasn't declared).
 *
 * Pair with `IdempotencyStore.claim` from
 * `@rotorsoft/act-ops/idempotency`: extract the key from the inbound
 * request, claim it on the store, return a `deduped` marker when the
 * claim fails. The framework-agnostic middleware that wires these
 * together lands in #744.
 */
export function extractIdempotencyKey(
  headers: Record<string, string | string[] | undefined>
): string | undefined {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "idempotency-key") continue;
    if (Array.isArray(value)) return undefined;
    return value;
  }
  return undefined;
}
