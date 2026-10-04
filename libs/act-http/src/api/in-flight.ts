/**
 * @module act-http/api/in-flight
 *
 * Tells a duplicate of a delivery that is still running apart from a
 * duplicate of one that already succeeded. An {@link IdempotencyStore}
 * can't: its `claim` returns `false` in both cases. Answering the first
 * "accepted, stop retrying" loses the delivery if the original then fails
 * and releases the key, so the receiver and the generated API both ask
 * the sender to retry while the original is in flight.
 *
 * Internal — not re-exported from the package. Process-local, which
 * matches `InMemoryIdempotencyStore`'s single-process scope.
 */
import type { IdempotencyStore } from "@rotorsoft/act-ops/idempotency";

/** A wrapped store plus the in-flight check it maintains. @internal */
export type InFlightTracker = {
  /** Pass this to the code that claims, commits, and releases. */
  readonly store: IdempotencyStore;
  /**
   * True while a claim on `key` is pending, or was won and is not yet
   * committed or released. Read it after your own claim lost.
   */
  in_flight(key: string): boolean;
};

/**
 * Wraps `store` so claims are counted per key. A key is counted **before**
 * the claim is awaited, not when its reply arrives: with an async store
 * the loser's `false` can arrive before the winner's `true`, and marking
 * only on the winner's reply would leave the loser a window to see the key
 * unmarked and be answered as a settled duplicate. A claim that loses (or
 * throws) uncounts itself at once; a claim that wins stays counted until
 * its commit or release lands.
 *
 * A concurrent duplicate of an already-committed key can therefore read
 * as in flight while another duplicate's claim is pending. That costs one
 * extra retry, never a lost delivery.
 *
 * @internal
 */
export function track_in_flight(store: IdempotencyStore): InFlightTracker {
  const pending = new Map<string, number>();
  const up = (key: string) => pending.set(key, (pending.get(key) ?? 0) + 1);
  const down = (key: string) => {
    const left = (pending.get(key) ?? 0) - 1;
    if (left > 0) pending.set(key, left);
    else pending.delete(key);
  };
  const settle = (key: string, won: boolean) => {
    if (!won) down(key);
    return won;
  };
  return {
    in_flight: (key) => pending.has(key),
    store: {
      claim(key, now) {
        up(key);
        let won: boolean | Promise<boolean>;
        try {
          won = store.claim(key, now);
        } catch (err) {
          down(key);
          throw err;
        }
        return typeof won === "boolean"
          ? settle(key, won)
          : won.then(
              (w) => settle(key, w),
              (err: unknown) => {
                down(key);
                throw err;
              }
            );
      },
      async commit(key, now) {
        try {
          await store.commit(key, now);
        } finally {
          down(key);
        }
      },
      async release(key) {
        try {
          await store.release(key);
        } finally {
          down(key);
        }
      },
    },
  };
}
