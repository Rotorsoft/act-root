import type { BroadcastState } from "./types.js";

/**
 * Generic LRU cache for aggregate state objects.
 *
 * Keyed by stream ID. Each entry stores the full state (with `_v` from the
 * event store). Used as the "previous state" baseline for computing patches,
 * and as the fast path for reconnects.
 *
 * The cache is shared between the broadcast hot path and read queries.
 * Projections should maintain their own cache to avoid double-apply bugs.
 */
export class StateCache<S extends BroadcastState = BroadcastState> {
  private cache = new Map<string, S>();
  private maxSize: number;

  constructor(maxSize = 50) {
    this.maxSize = maxSize;
  }

  /** Get a cached state, promoting it to MRU position. */
  get(key: string): S | undefined {
    const s = this.cache.get(key);
    if (s) {
      // Move to end (MRU)
      this.cache.delete(key);
      this.cache.set(key, s);
    }
    return s;
  }

  /** Set a cached state, evicting the LRU entry if at capacity. */
  set(key: string, state: S): void {
    this.cache.delete(key);
    this.cache.set(key, state);
    if (this.cache.size > this.maxSize) {
      // Size > max guarantees at least one entry exists
      this.cache.delete(this.cache.keys().next().value!);
    }
  }

  /** Remove a cached entry. */
  delete(key: string): void {
    this.cache.delete(key);
  }

  /** Check if a key exists in the cache. */
  has(key: string): boolean {
    return this.cache.has(key);
  }

  /** Current number of cached entries. */
  get size(): number {
    return this.cache.size;
  }

  /** Direct access to the underlying map (for iteration). */
  entries(): IterableIterator<[string, S]> {
    return this.cache.entries();
  }
}
