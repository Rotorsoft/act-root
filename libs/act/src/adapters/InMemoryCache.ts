import type { Cache, CacheEntry, Schema } from "../types/index.js";

/**
 * In-memory LRU cache for stream snapshots.
 *
 * Uses a `Map` (insertion-ordered) for O(1) get/set with LRU eviction.
 * Configurable `maxSize` bounds memory usage.
 *
 * @example
 * ```typescript
 * import { cache } from "@rotorsoft/act";
 * import { InMemoryCache } from "@rotorsoft/act";
 *
 * cache(new InMemoryCache({ maxSize: 500 }));
 * ```
 */
/* eslint-disable @typescript-eslint/require-await -- async interface for Redis-compatibility */
export class InMemoryCache implements Cache {
  private readonly _entries = new Map<string, CacheEntry<Schema>>();
  private readonly _maxSize: number;

  constructor(options?: { maxSize?: number }) {
    this._maxSize = options?.maxSize ?? 1000;
  }

  async get<TState extends Schema>(
    stream: string
  ): Promise<CacheEntry<TState> | undefined> {
    const entry = this._entries.get(stream);
    if (!entry) return undefined;
    // Move to end (most recently used)
    this._entries.delete(stream);
    this._entries.set(stream, entry);
    return entry as CacheEntry<TState>;
  }

  async set<TState extends Schema>(
    stream: string,
    entry: CacheEntry<TState>
  ): Promise<void> {
    this._entries.delete(stream);
    if (this._entries.size >= this._maxSize) {
      // Evict least recently used (first entry)
      const first = this._entries.keys().next().value as string;
      this._entries.delete(first);
    }
    this._entries.set(stream, entry as CacheEntry<Schema>);
  }

  async invalidate(stream: string): Promise<void> {
    this._entries.delete(stream);
  }

  async clear(): Promise<void> {
    this._entries.clear();
  }

  async dispose(): Promise<void> {
    this._entries.clear();
  }

  get size(): number {
    return this._entries.size;
  }
}
