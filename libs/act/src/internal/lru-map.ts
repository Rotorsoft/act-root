/**
 * Tiny bounded LRU map built on insertion-ordered `Map`. Caps memory in
 * long-running orchestrators that mint large numbers of keys:
 *
 * - {@link InMemoryCache}: stream → state checkpoint
 * - correlate's dynamic subscriptions (stream → priority and lane) and its
 *   compiled source patterns
 *
 * Apps with millions of dynamic streams (one target per aggregate) can't
 * afford an unbounded map: eviction is required.
 */

/**
 * Bounded LRU map. `get()` promotes; `has()` does not. `set()` always
 * promotes and evicts the oldest entry when at capacity.
 */
export class LruMap<K, V> {
  private readonly _entries = new Map<K, V>();
  private readonly _max_size: number;

  constructor(maxSize: number) {
    this._max_size = maxSize;
  }

  get(key: K): V | undefined {
    const v = this._entries.get(key);
    if (v === undefined) return undefined;
    // promote: delete + re-insert moves to most-recent position
    this._entries.delete(key);
    this._entries.set(key, v);
    return v;
  }

  has(key: K): boolean {
    return this._entries.has(key);
  }

  set(key: K, value: V): void {
    this._entries.delete(key);
    if (this._entries.size >= this._max_size) {
      // size >= maxSize ≥ 1 → at least one entry exists → next().value
      // is the oldest key (asserted with `!`).
      const oldest = this._entries.keys().next().value!;
      this._entries.delete(oldest);
    }
    this._entries.set(key, value);
  }

  delete(key: K): boolean {
    return this._entries.delete(key);
  }

  clear(): void {
    this._entries.clear();
  }

  get size(): number {
    return this._entries.size;
  }
}
