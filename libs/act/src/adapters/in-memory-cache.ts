import { LruMap } from "../lru-map.js";
import type { Cache, CacheEntry, Schema } from "../types/index.js";

/**
 * In-memory LRU cache for stream snapshots.
 *
 * Backed by an internal `LruMap` for O(1) get/set with LRU eviction.
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
  // CacheEntry<any> lets `get<TState>` and `set<TState>` flow without casts:
  // any is bidirectionally compatible with the per-call TState binding, while
  // the public Cache interface still presents a typed surface to callers.
  private readonly _entries: LruMap<string, CacheEntry<any>>;

  constructor(options?: { maxSize?: number }) {
    this._entries = new LruMap(options?.maxSize ?? 1000);
  }

  /** @inheritDoc */
  async get<TState extends Schema>(
    stream: string
  ): Promise<CacheEntry<TState> | undefined> {
    return this._entries.get(stream);
  }

  /** @inheritDoc */
  async set<TState extends Schema>(
    stream: string,
    entry: CacheEntry<TState>
  ): Promise<void> {
    this._entries.set(stream, entry);
  }

  /** @inheritDoc */
  async invalidate(stream: string): Promise<void> {
    this._entries.delete(stream);
  }

  /** @inheritDoc */
  async clear(): Promise<void> {
    this._entries.clear();
  }

  /** @inheritDoc */
  async dispose(): Promise<void> {
    this._entries.clear();
  }

  /** Current number of entries held by the LRU. */
  get size(): number {
    return this._entries.size;
  }
}
