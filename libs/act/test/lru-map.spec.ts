import { LruMap, LruSet } from "../src/lru-map.js";

describe("LruMap", () => {
  it("returns undefined for missing keys", () => {
    const m = new LruMap<string, number>(3);
    expect(m.get("a")).toBeUndefined();
    expect(m.has("a")).toBe(false);
  });

  it("stores and retrieves values", () => {
    const m = new LruMap<string, number>(3);
    m.set("a", 1);
    expect(m.get("a")).toBe(1);
    expect(m.has("a")).toBe(true);
    expect(m.size).toBe(1);
  });

  it("evicts the least-recently-used entry when at capacity", () => {
    const m = new LruMap<string, number>(2);
    m.set("a", 1);
    m.set("b", 2);
    m.set("c", 3); // evicts "a"
    expect(m.has("a")).toBe(false);
    expect(m.has("b")).toBe(true);
    expect(m.has("c")).toBe(true);
    expect(m.size).toBe(2);
  });

  it("promotes on get(), so the touched entry survives eviction", () => {
    const m = new LruMap<string, number>(2);
    m.set("a", 1);
    m.set("b", 2);
    m.get("a"); // promote a
    m.set("c", 3); // evicts the now-oldest, which is "b"
    expect(m.has("a")).toBe(true);
    expect(m.has("b")).toBe(false);
    expect(m.has("c")).toBe(true);
  });

  it("does NOT promote on has()", () => {
    const m = new LruMap<string, number>(2);
    m.set("a", 1);
    m.set("b", 2);
    m.has("a"); // peek without promoting
    m.set("c", 3); // evicts "a" (still oldest)
    expect(m.has("a")).toBe(false);
    expect(m.has("b")).toBe(true);
    expect(m.has("c")).toBe(true);
  });

  it("re-inserting an existing key promotes it", () => {
    const m = new LruMap<string, number>(2);
    m.set("a", 1);
    m.set("b", 2);
    m.set("a", 10); // promote a
    m.set("c", 3); // evicts b
    expect(m.get("a")).toBe(10);
    expect(m.has("b")).toBe(false);
    expect(m.has("c")).toBe(true);
  });

  it("supports delete and clear", () => {
    const m = new LruMap<string, number>(3);
    m.set("a", 1);
    m.set("b", 2);
    expect(m.delete("a")).toBe(true);
    expect(m.has("a")).toBe(false);
    expect(m.size).toBe(1);
    m.clear();
    expect(m.size).toBe(0);
  });
});

describe("LruSet", () => {
  it("tracks presence with bounded capacity", () => {
    const s = new LruSet<string>(2);
    s.add("a");
    s.add("b");
    s.add("c"); // evicts "a"
    expect(s.has("a")).toBe(false);
    expect(s.has("b")).toBe(true);
    expect(s.has("c")).toBe(true);
    expect(s.size).toBe(2);
  });

  it("re-adding promotes the entry", () => {
    const s = new LruSet<string>(2);
    s.add("a");
    s.add("b");
    s.add("a"); // promote a; b is oldest
    s.add("c"); // evicts b
    expect(s.has("a")).toBe(true);
    expect(s.has("b")).toBe(false);
    expect(s.has("c")).toBe(true);
  });

  it("supports delete and clear", () => {
    const s = new LruSet<string>(3);
    s.add("a");
    s.add("b");
    expect(s.delete("a")).toBe(true);
    expect(s.has("a")).toBe(false);
    s.clear();
    expect(s.size).toBe(0);
  });
});
