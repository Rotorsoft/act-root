import { InMemoryCache } from "../src/adapters/in-memory-cache.js";

// Contract-level cases live in `in-memory-cache-tck.spec.ts` (via the
// shared Cache TCK in `@rotorsoft/act-tck`). This file only covers
// InMemory-specific implementation details: LRU ordering and size
// bounding, both of which are adapter-specific (the Cache contract
// has no notion of eviction policy or max size).

describe("InMemoryCache (adapter-specific)", () => {
  it("evicts the least-recently-used entry when full", async () => {
    const cache = new InMemoryCache({ maxSize: 3 });
    await cache.set("a", {
      state: {},
      version: 0,
      event_id: 0,
      patches: 0,
      snaps: 0,
    });
    await cache.set("b", {
      state: {},
      version: 0,
      event_id: 1,
      patches: 0,
      snaps: 0,
    });
    await cache.set("c", {
      state: {},
      version: 0,
      event_id: 2,
      patches: 0,
      snaps: 0,
    });

    // Touch "a" so it becomes most-recently-used.
    await cache.get("a");

    // Adding "d" should evict "b" (least recently used).
    await cache.set("d", {
      state: {},
      version: 0,
      event_id: 3,
      patches: 0,
      snaps: 0,
    });

    expect(await cache.get("a")).toBeDefined();
    expect(await cache.get("b")).toBeUndefined();
    expect(await cache.get("c")).toBeDefined();
    expect(await cache.get("d")).toBeDefined();
  });

  it("set overwrites a prior entry on the same stream without growing", async () => {
    const cache = new InMemoryCache({ maxSize: 3 });
    await cache.set("a", {
      state: { v: 1 },
      version: 0,
      event_id: 0,
      patches: 0,
      snaps: 0,
    });
    await cache.set("a", {
      state: { v: 2 },
      version: 1,
      event_id: 1,
      patches: 1,
      snaps: 0,
    });
    expect(cache.size).toBe(1);
  });

  it("dispose clears all entries (observable via `size`)", async () => {
    const cache = new InMemoryCache({ maxSize: 3 });
    await cache.set("a", {
      state: {},
      version: 0,
      event_id: 0,
      patches: 0,
      snaps: 0,
    });
    await cache.dispose();
    expect(cache.size).toBe(0);
  });

  it("defaults maxSize to 1000", async () => {
    const big = new InMemoryCache();
    for (let i = 0; i < 1001; i++) {
      await big.set(`k${i}`, {
        state: {},
        version: 0,
        event_id: i,
        patches: 0,
        snaps: 0,
      });
    }
    expect(await big.get("k0")).toBeUndefined(); // evicted
    expect(await big.get("k1")).toBeDefined();
    expect(big.size).toBe(1000);
  });
});
