import { runCacheDifferentialTck } from "@rotorsoft/act-tck";
import { InMemoryCache } from "../src/adapters/in-memory-cache.js";
import type { Cache, CacheEntry, Schema } from "../src/types/index.js";

/**
 * A second, structurally independent {@link Cache} so the differential has
 * a genuine comparand: a plain `Map` with no LRU, no eviction. Driven
 * within capacity, it must agree with `InMemoryCache` on every observable
 * `get()` — and would expose any divergence if `InMemoryCache`'s LRU ever
 * leaked into the contract.
 */
class MapCache implements Cache {
  private readonly entries = new Map<string, CacheEntry<Schema>>();
  async get<TState extends Schema>(stream: string) {
    return this.entries.get(stream) as CacheEntry<TState> | undefined;
  }
  async set<TState extends Schema>(stream: string, entry: CacheEntry<TState>) {
    this.entries.set(stream, entry);
  }
  async invalidate(stream: string) {
    this.entries.delete(stream);
  }
  async clear() {
    this.entries.clear();
  }
  async dispose() {
    this.entries.clear();
  }
}

// Cache differential (#1057): drive randomized set/invalidate/clear
// workloads against the LRU-backed InMemoryCache and a plain Map reference,
// comparing observable get() after every op. This invocation exercises the
// seed/streams/runs defaults.
runCacheDifferentialTck({
  name: "InMemoryCache vs MapCache",
  caches: [
    {
      name: "InMemoryCache",
      factory: () => new InMemoryCache({ maxSize: 1000 }),
    },
    { name: "MapCache", factory: () => new MapCache() },
  ],
});

// Explicit seed/streams/runs so both arms of the option fallbacks stay
// covered (the invocation above exercises the defaults).
runCacheDifferentialTck({
  name: "InMemoryCache vs MapCache (explicit options)",
  seed: 0x1057,
  streams: 4,
  runs: 3,
  caches: [
    {
      name: "InMemoryCache",
      factory: () => new InMemoryCache({ maxSize: 1000 }),
    },
    { name: "MapCache", factory: () => new MapCache() },
  ],
});
