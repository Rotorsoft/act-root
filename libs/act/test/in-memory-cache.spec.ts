import { InMemoryCache } from "../src/adapters/InMemoryCache.js";

describe("InMemoryCache", () => {
  let cache: InMemoryCache;

  beforeEach(() => {
    cache = new InMemoryCache({ maxSize: 3 });
  });

  it("returns undefined for missing keys", async () => {
    expect(await cache.get("missing")).toBeUndefined();
  });

  it("stores and retrieves entries", async () => {
    const entry = {
      state: { count: 1 },
      version: 0,
      event_id: 0,
      patches: 1,
      snaps: 0,
    };
    await cache.set("s1", entry);
    expect(await cache.get("s1")).toEqual(entry);
  });

  it("evicts LRU entry when full", async () => {
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

    // Access "a" to make it recently used
    await cache.get("a");

    // Adding "d" should evict "b" (least recently used)
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

  it("updates existing keys without growing", async () => {
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
    expect((await cache.get("a"))?.state).toEqual({ v: 2 });
  });

  it("invalidates a specific key", async () => {
    await cache.set("s1", {
      state: {},
      version: 0,
      event_id: 0,
      patches: 0,
      snaps: 0,
    });
    await cache.invalidate("s1");
    expect(await cache.get("s1")).toBeUndefined();
  });

  it("clears all entries", async () => {
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
    await cache.clear();
    expect(cache.size).toBe(0);
  });

  it("dispose clears all entries", async () => {
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
    // First entry should have been evicted
    expect(await big.get("k0")).toBeUndefined();
    expect(await big.get("k1")).toBeDefined();
    expect(big.size).toBe(1000);
  });
});
