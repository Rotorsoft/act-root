import type { Cache, CacheEntry } from "@rotorsoft/act/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Options for {@link run_cache_tck}.
 */
export type CacheTckOptions = {
  /**
   * Display name for the implementation under test. Becomes the
   * top-level `describe` block in the vitest run.
   */
  readonly name: string;
  /**
   * Factory invoked before each test. Must return a fresh, empty cache
   * — tests assume zero starting entries. Any per-implementation tuning
   * (max size, TTL, etc.) is the factory's responsibility, but the TCK
   * itself sets ≤ 8 entries in any single test, so a default max of
   * `≥ 8` is safe.
   */
  readonly factory: () => Cache;
};

const entry = (
  event_id: number,
  state: Record<string, unknown> = {}
): CacheEntry<Record<string, unknown>> => ({
  state,
  version: event_id,
  event_id,
  patches: 1,
  snaps: 0,
});

/**
 * Runs the Cache contract test compatibility kit against the
 * implementation produced by `options.factory`.
 *
 * Covers the full {@link Cache} surface defined in
 * `libs/act/src/types/ports.ts`:
 * - get/set round-trip
 * - get on a missing key returns undefined
 * - invalidate removes a single stream without affecting others
 * - clear wipes all entries
 * - dispose is idempotent and awaitable
 * - cross-stream isolation
 *
 * Adapter-specific behavior (LRU ordering, TTL, size limits, …) stays
 * in the adapter's own test suite — the TCK only asserts the contract
 * every Cache must honor.
 *
 * @example
 * ```ts
 * import { run_cache_tck } from "@rotorsoft/act-tck";
 * import { InMemoryCache } from "@rotorsoft/act";
 *
 * run_cache_tck({
 *   name: "InMemoryCache",
 *   factory: () => new InMemoryCache({ maxSize: 1000 }),
 * });
 * ```
 */
export const run_cache_tck = (options: CacheTckOptions): void => {
  describe(`TCK / Cache / ${options.name}`, () => {
    let cache: Cache;

    beforeEach(() => {
      cache = options.factory();
    });

    afterEach(async () => {
      await cache.dispose();
    });

    it("returns undefined for an unset stream", async () => {
      expect(await cache.get("missing")).toBeUndefined();
    });

    it("set then get round-trips an entry", async () => {
      const e = entry(1, { count: 7 });
      await cache.set("s1", e);
      expect(await cache.get("s1")).toEqual(e);
    });

    it("set overwrites a prior entry on the same stream", async () => {
      await cache.set("s1", entry(1, { count: 1 }));
      await cache.set("s1", entry(2, { count: 2 }));
      const got = await cache.get<Record<string, unknown>>("s1");
      expect(got?.event_id).toBe(2);
      expect(got?.state).toEqual({ count: 2 });
    });

    it("invalidate removes one stream and leaves others", async () => {
      await cache.set("a", entry(1));
      await cache.set("b", entry(2));
      await cache.invalidate("a");
      expect(await cache.get("a")).toBeUndefined();
      expect(await cache.get("b")).toBeDefined();
    });

    it("invalidate on an unknown stream is a no-op", async () => {
      await expect(cache.invalidate("never-set")).resolves.toBeUndefined();
    });

    it("clear empties every stream", async () => {
      await cache.set("a", entry(1));
      await cache.set("b", entry(2));
      await cache.set("c", entry(3));
      await cache.clear();
      expect(await cache.get("a")).toBeUndefined();
      expect(await cache.get("b")).toBeUndefined();
      expect(await cache.get("c")).toBeUndefined();
    });

    it("clear on an empty cache is a no-op", async () => {
      await expect(cache.clear()).resolves.toBeUndefined();
    });

    it("entries are isolated per stream", async () => {
      const ea = entry(1, { id: "a" });
      const eb = entry(2, { id: "b" });
      await cache.set("a", ea);
      await cache.set("b", eb);
      expect(await cache.get("a")).toEqual(ea);
      expect(await cache.get("b")).toEqual(eb);
    });

    it("dispose is idempotent", async () => {
      await cache.set("a", entry(1));
      await cache.dispose();
      await expect(cache.dispose()).resolves.toBeUndefined();
    });
  });
};
