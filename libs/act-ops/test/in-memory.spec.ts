import { describe, expect, it } from "vitest";
import { InMemoryIdempotencyStore } from "../src/index.js";

describe("InMemoryIdempotencyStore", () => {
  it("claim returns true the first time, false on re-claim", () => {
    const store = new InMemoryIdempotencyStore();
    expect(store.claim("k1")).toBe(true);
    expect(store.claim("k1")).toBe(false);
    expect(store.claim("k2")).toBe(true);
  });

  it("expires entries after ttlMs and re-claims on next call", () => {
    const store = new InMemoryIdempotencyStore({ ttlMs: 1_000 });
    const t0 = 1_000_000;
    expect(store.claim("k1", t0)).toBe(true);
    expect(store.claim("k1", t0 + 500)).toBe(false);
    // Expired — next claim treats the key as fresh.
    expect(store.claim("k1", t0 + 1_500)).toBe(true);
  });

  it("size reflects current entries after gc", () => {
    const store = new InMemoryIdempotencyStore({ ttlMs: 1_000 });
    const t0 = 1_000_000;
    store.claim("a", t0);
    store.claim("b", t0);
    store.claim("c", t0);
    expect(store.size(t0)).toBe(3);
    // Advance past TTL — gc drops everything.
    expect(store.size(t0 + 2_000)).toBe(0);
  });

  it("size with default `now` returns current entry count", () => {
    const store = new InMemoryIdempotencyStore();
    expect(store.size()).toBe(0);
    store.claim("k");
    expect(store.size()).toBe(1);
  });

  it("evicts the oldest entry when maxEntries is exceeded", () => {
    const store = new InMemoryIdempotencyStore({ maxEntries: 2 });
    store.claim("a");
    store.claim("b");
    store.claim("c"); // "a" evicts (oldest); store now holds [b, c]
    expect(store.size()).toBe(2);
    // "b" and "c" still present.
    expect(store.claim("b")).toBe(false);
    expect(store.claim("c")).toBe(false);
    // "a" was evicted → fresh again.
    expect(store.claim("a")).toBe(true);
  });

  it("clear drops all entries", () => {
    const store = new InMemoryIdempotencyStore();
    store.claim("k");
    store.clear();
    expect(store.size()).toBe(0);
    expect(store.claim("k")).toBe(true);
  });

  it("gc stops at the first non-expired entry (insertion order)", () => {
    const store = new InMemoryIdempotencyStore({ ttlMs: 1_000 });
    const t0 = 1_000_000;
    store.claim("expired-1", t0);
    store.claim("expired-2", t0 + 100);
    store.claim("fresh", t0 + 800);
    // Sweep at t0 + 1_500: expired-1 and expired-2 are past TTL,
    // "fresh" is not — gc must drop the first two and stop.
    expect(store.size(t0 + 1_500)).toBe(1);
    expect(store.claim("fresh", t0 + 1_500)).toBe(false);
  });
});
