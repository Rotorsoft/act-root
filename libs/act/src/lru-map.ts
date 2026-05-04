/**
 * @module lru-map
 * @category Internal
 *
 * Tiny bounded LRU map / set built on insertion-ordered `Map`. Used to cap
 * memory in long-running orchestrators that mint large numbers of keys —
 * notably:
 *
 * - {@link InMemoryCache}: stream → state checkpoint
 * - `Act._subscribed_streams`: stream → presence (LruSet)
 *
 * Apps with millions of dynamic streams (one target per aggregate) can't
 * afford an unbounded `Set<string>` — eviction is required.
 *
 * @internal
 */

/**
 * Bounded LRU map. `get()` promotes; `has()` does not. `set()` always
 * promotes and evicts the oldest entry when at capacity.
 *
 * @internal
 */
export class LruMap<K, V> {
  private readonly _entries = new Map<K, V>();

  constructor(private readonly _maxSize: number) {}

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
    if (this._entries.size >= this._maxSize) {
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

/**
 * Bounded LRU set built on top of {@link LruMap}. `has()` does not promote;
 * `add()` does (re-inserting if already present, evicting the oldest at
 * capacity).
 *
 * @internal
 */
export class LruSet<T> {
  private readonly _map: LruMap<T, true>;

  constructor(maxSize: number) {
    this._map = new LruMap(maxSize);
  }

  has(value: T): boolean {
    return this._map.has(value);
  }

  add(value: T): void {
    this._map.set(value, true);
  }

  delete(value: T): boolean {
    return this._map.delete(value);
  }

  clear(): void {
    this._map.clear();
  }

  get size(): number {
    return this._map.size;
  }
}
