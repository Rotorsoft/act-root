/**
 * Receiver-side idempotency contract: atomically record a key as seen,
 * report whether the caller is processing a fresh request or a duplicate.
 *
 * **Not a Cache.** In this codebase `Cache` means "rebuildable from a
 * source of truth" (e.g. snapshot cache). Dedup state is authoritative —
 * losing it allows duplicate side effects, not just a rebuild. Hence
 * `Store`. Implementations should preserve records for at least the
 * sender's full retry envelope; see
 * [external integration](https://rotorsoft.github.io/act-root/docs/guides/external-integration)
 * for TTL sizing guidance (the matching helper lands in #747).
 *
 * Implementations may be sync (in-memory) or async (durable adapters
 * backed by Postgres, Redis, etc.). The middleware that consumes this
 * port (`#744`) awaits unconditionally, so either shape composes
 * cleanly with framework-agnostic receivers.
 */
export interface IdempotencyStore {
  /**
   * Atomically record `key` as seen. Returns `true` if the key was
   * fresh (and is now recorded), `false` if it was already present
   * — the caller should treat the request as a duplicate.
   *
   * `now` is exposed for tests; production callers should leave it
   * undefined so wall-clock is used.
   */
  record_if_fresh(key: string, now?: number): boolean | Promise<boolean>;
}
