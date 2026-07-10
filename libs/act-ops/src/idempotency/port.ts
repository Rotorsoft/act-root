/**
 * Receiver-side idempotency contract: atomically claim a key as
 * processed-by-this-caller, report whether the claim succeeded.
 *
 * The verb mirrors {@link "@rotorsoft/act".Store.claim} — both are
 * atomic acquire-or-fail operations on a contested resource. There,
 * competing workers race for the right to drain a stream; here,
 * competing requests race for the right to be processed as the
 * canonical first-time delivery for an `Idempotency-Key`. One caller
 * wins; the others see the claim has already been made and treat
 * their request as a duplicate.
 *
 * **Not a Cache.** In this codebase `Cache` means "rebuildable from
 * a source of truth" (e.g. snapshot cache). Dedup state is
 * authoritative — losing it allows duplicate side effects, not just
 * a rebuild. Hence `Store`. Implementations should preserve records
 * for at least the sender's full retry envelope; see
 * [external integration](https://rotorsoft.github.io/act-root/docs/guides/external-integration)
 * for TTL sizing guidance (the matching helper lands in #747).
 *
 * Implementations may be sync (in-memory) or async (durable adapters
 * backed by Postgres, Redis, etc.). The middleware that consumes
 * this port (`#744`) awaits unconditionally, so either shape
 * composes cleanly with framework-agnostic receivers.
 */
export interface IdempotencyStore {
  /**
   * Atomically claim `key` for this caller. Returns `true` if the
   * caller won the claim (the key was fresh and is now recorded),
   * `false` if another caller already claimed it — the request
   * should be treated as a duplicate.
   *
   * The claim is **tentative** until the caller confirms the outcome
   * with {@link commit} or {@link release}. A tentative claim still
   * dedups a concurrent duplicate that arrives while the handler is
   * in flight — the second caller sees `false` and serializes behind
   * the first — but it is *not* durable across the caller's own
   * retries until committed. This two-phase shape is what stops a
   * transient handler failure from permanently dropping a delivery:
   * the sender retries with the same key, and because the failed
   * attempt released (or never committed) the claim, the retry
   * re-processes instead of being deduped into a silent success.
   *
   * `now` is exposed for tests; production callers should leave it
   * undefined so wall-clock is used.
   */
  claim(key: string, now?: number): boolean | Promise<boolean>;

  /**
   * Promote a tentative {@link claim} to a durable record so every
   * later delivery of the same key dedups. Call this once the
   * business handler has succeeded. Committing a key that was never
   * claimed records it too, so a durable adapter that lost the
   * tentative reservation (process crash between `claim` and
   * `commit`) still lands in a consistent "seen" state.
   *
   * `now` is exposed for tests; production callers should leave it
   * undefined so wall-clock is used.
   */
  commit(key: string, now?: number): void | Promise<void>;

  /**
   * Drop a tentative {@link claim} so a retry re-processes. Call this
   * when the business handler failed transiently and the delivery
   * should be re-attempted under the same key. Releasing a key that
   * has already been {@link commit}ted is a no-op — a successful
   * delivery stays deduped even if a late release arrives.
   */
  release(key: string): void | Promise<void>;
}
