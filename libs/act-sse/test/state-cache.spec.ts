import { describe, expect, it } from "vitest";
import { StateCache } from "../src/state-cache.js";

describe("StateCache", () => {
  it("get/set/delete basics", () => {
    const cache = new StateCache<{ _v: number; x: number }>();
    expect(cache.get("a")).toBeUndefined();

    cache.set("a", { _v: 1, x: 10 });
    expect(cache.get("a")).toEqual({ _v: 1, x: 10 });

    cache.delete("a");
    expect(cache.get("a")).toBeUndefined();
  });

  it("evicts LRU when exceeding maxSize", () => {
    const cache = new StateCache<{ _v: number }>(3);
    cache.set("a", { _v: 1 });
    cache.set("b", { _v: 2 });
    cache.set("c", { _v: 3 });
    cache.set("d", { _v: 4 }); // evicts "a"

    expect(cache.has("a")).toBe(false);
    expect(cache.has("b")).toBe(true);
    expect(cache.has("d")).toBe(true);
    expect(cache.size).toBe(3);
  });

  it("get promotes to MRU (prevents eviction)", () => {
    const cache = new StateCache<{ _v: number }>(3);
    cache.set("a", { _v: 1 });
    cache.set("b", { _v: 2 });
    cache.set("c", { _v: 3 });

    cache.get("a"); // promote "a" to MRU
    cache.set("d", { _v: 4 }); // evicts "b" (now LRU), not "a"

    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
  });

  it("entries() iterates all cached entries", () => {
    const cache = new StateCache<{ _v: number }>();
    cache.set("a", { _v: 1 });
    cache.set("b", { _v: 2 });
    const entries = [...cache.entries()];
    expect(entries).toHaveLength(2);
    expect(entries.map(([k]) => k)).toContain("a");
    expect(entries.map(([k]) => k)).toContain("b");
  });

  it("evicts correctly with maxSize=1", () => {
    const cache = new StateCache<{ _v: number }>(1);
    cache.set("a", { _v: 1 });
    cache.set("b", { _v: 2 }); // evicts "a"
    expect(cache.has("a")).toBe(false);
    expect(cache.has("b")).toBe(true);
    expect(cache.size).toBe(1);
  });

  it("set overwrites existing entry", () => {
    const cache = new StateCache<{ _v: number; x: number }>();
    cache.set("a", { _v: 1, x: 10 });
    cache.set("a", { _v: 2, x: 20 });
    expect(cache.get("a")).toEqual({ _v: 2, x: 20 });
    expect(cache.size).toBe(1);
  });
});
