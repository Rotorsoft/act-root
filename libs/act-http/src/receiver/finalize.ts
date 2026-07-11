import type { IdempotencyStore } from "@rotorsoft/act-ops/idempotency";

/**
 * The two-phase finalizers a receiver adapter binds to a single
 * inbound delivery. The claim `checkWebhook` makes is *tentative*;
 * exactly one of these promotes or drops it once the business handler
 * resolves its outcome.
 */
export type Finalizers = {
  /**
   * Promote the tentative claim to a durable record so every later
   * retry of this key dedups. Call on handler success.
   */
  commit: () => void | Promise<void>;
  /**
   * Drop the tentative claim so the sender's retry re-processes.
   * Call on transient handler failure.
   */
  release: () => void | Promise<void>;
};

/**
 * Build the {@link Finalizers} for one delivery.
 *
 * Guarantees:
 *
 * - **Deduped deliveries are inert.** When `deduped` is `true` the key
 *   was already committed by an earlier delivery; both finalizers are
 *   no-ops so a duplicate can never release someone else's committed
 *   claim.
 * - **Finalize-once.** After the first `commit` or `release` fires,
 *   further calls are no-ops — an adapter that both auto-finalizes and
 *   lets the operator call `commit()`/`release()` can't double-fire.
 */
export function make_finalizers(
  store: IdempotencyStore,
  key: string,
  deduped: boolean
): Finalizers {
  let settled = deduped;
  return {
    async commit() {
      if (settled) return;
      settled = true;
      await store.commit(key);
    },
    async release() {
      if (settled) return;
      settled = true;
      await store.release(key);
    },
  };
}
