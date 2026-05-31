/**
 * Receiver-side header parser for the idempotency contract. The
 * dedup store itself — `IdempotencyStore` port +
 * `InMemoryIdempotencyStore` reference impl — now lives in
 * `@rotorsoft/act-ops`; import from there for new code.
 *
 * `extractIdempotencyKey` stays here until #743 (ACT-1115) lifts it
 * into `@rotorsoft/act-http/receiver` alongside the framework-specific
 * middleware adapters.
 */

/**
 * Pull the `Idempotency-Key` header from a Node-style headers bag,
 * case-insensitive. Returns `undefined` when the header is missing or
 * malformed (an array value, which would be ambiguous).
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
