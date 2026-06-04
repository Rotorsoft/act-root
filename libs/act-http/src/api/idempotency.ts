import type { IdempotencyStore } from "@rotorsoft/act-ops/idempotency";

/**
 * Result of a {@link withIdempotency} call.
 *
 * - `{ deduped: false, result }` — the claim was fresh; the handler
 *   ran and produced `result`.
 * - `{ deduped: true }` — the claim was already taken; the handler
 *   was *not* invoked. The caller decides how to respond (typically
 *   a 2xx with no body, matching the receiver-side convention).
 *
 * Note: the contract does not cache the previous response. A
 * duplicate call returns the deduped marker only — replaying the
 * original handler's output would require a response-caching
 * adapter, which is out of scope here. The receiver-side convention
 * (and the convention the generated transports follow) is "ack the
 * duplicate; do nothing else."
 */
export type IdempotencyResult<T> =
  | { deduped: false; result: T }
  | { deduped: true };

/**
 * Wrap an action handler so the framework honors `Idempotency-Key`
 * dedup. Acquires the key via {@link IdempotencyStore.claim}, runs
 * the handler exactly when the claim was fresh, and skips the
 * handler entirely on a duplicate.
 *
 * Reuses the contract `@rotorsoft/act-ops/idempotency` already
 * defines for the receiver-side `Idempotency-Key` story. A single
 * `IdempotencyStore` implementation covers both halves of the "Act
 * over the wire" surface — receiver and generated API.
 */
export async function withIdempotency<T>(
  store: IdempotencyStore,
  key: string,
  handler: () => Promise<T>
): Promise<IdempotencyResult<T>> {
  const fresh = await store.claim(key);
  if (!fresh) {
    return { deduped: true };
  }
  return { deduped: false, result: await handler() };
}
