import { describe, expect, it } from "vitest";
import { InMemoryIdempotencyStore } from "../src/index.js";

describe("InMemoryIdempotencyStore", () => {
  it("record_if_fresh returns true the first time, false on re-record", () => {
    const store = new InMemoryIdempotencyStore();
    expect(store.record_if_fresh("k1")).toBe(true);
    expect(store.record_if_fresh("k1")).toBe(false);
    expect(store.record_if_fresh("k2")).toBe(true);
  });

  it("expires entries after ttlMs and re-records on next call", () => {
    const store = new InMemoryIdempotencyStore({ ttlMs: 1_000 });
    const t0 = 1_000_000;
    expect(store.record_if_fresh("k1", t0)).toBe(true);
    expect(store.record_if_fresh("k1", t0 + 500)).toBe(false);
    // Expired — next record_if_fresh treats it as fresh.
    expect(store.record_if_fresh("k1", t0 + 1_500)).toBe(true);
  });

  it("size reflects current entries after gc", () => {
    const store = new InMemoryIdempotencyStore({ ttlMs: 1_000 });
    const t0 = 1_000_000;
    store.record_if_fresh("a", t0);
    store.record_if_fresh("b", t0);
    store.record_if_fresh("c", t0);
    expect(store.size(t0)).toBe(3);
    // Advance past TTL — gc drops everything.
    expect(store.size(t0 + 2_000)).toBe(0);
  });

  it("size with default `now` returns current entry count", () => {
    const store = new InMemoryIdempotencyStore();
    expect(store.size()).toBe(0);
    store.record_if_fresh("k");
    expect(store.size()).toBe(1);
  });

  it("evicts the oldest entry when maxEntries is exceeded", () => {
    const store = new InMemoryIdempotencyStore({ maxEntries: 2 });
    store.record_if_fresh("a");
    store.record_if_fresh("b");
    store.record_if_fresh("c"); // "a" evicts (oldest); store now holds [b, c]
    expect(store.size()).toBe(2);
    // "b" and "c" still present.
    expect(store.record_if_fresh("b")).toBe(false);
    expect(store.record_if_fresh("c")).toBe(false);
    // "a" was evicted → fresh again.
    expect(store.record_if_fresh("a")).toBe(true);
  });

  it("clear drops all entries", () => {
    const store = new InMemoryIdempotencyStore();
    store.record_if_fresh("k");
    store.clear();
    expect(store.size()).toBe(0);
    expect(store.record_if_fresh("k")).toBe(true);
  });

  it("gc stops at the first non-expired entry (insertion order)", () => {
    const store = new InMemoryIdempotencyStore({ ttlMs: 1_000 });
    const t0 = 1_000_000;
    store.record_if_fresh("expired-1", t0);
    store.record_if_fresh("expired-2", t0 + 100);
    store.record_if_fresh("fresh", t0 + 800);
    // Sweep at t0 + 1_500: expired-1 and expired-2 are past TTL,
    // "fresh" is not — gc must drop the first two and stop.
    expect(store.size(t0 + 1_500)).toBe(1);
    expect(store.record_if_fresh("fresh", t0 + 1_500)).toBe(false);
  });
});
