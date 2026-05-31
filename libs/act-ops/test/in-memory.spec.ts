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

  describe("ttl source resolution", () => {
    it("derives ttlMs from retryProfile when ttlMs isn't supplied", () => {
      // Worked example: backoff (linear, base 100, 4 retries) → 1_000,
      // timeouts → 5 * 500 = 2_500, sf=4 → 14_000ms window.
      const store = new InMemoryIdempotencyStore({
        retryProfile: {
          maxRetries: 4,
          backoff: { strategy: "linear", baseMs: 100 },
          timeoutMs: 500,
        },
      });
      const t0 = 1_000_000;
      expect(store.claim("k", t0)).toBe(true);
      // Still inside the derived 14_000ms window — duplicate.
      expect(store.claim("k", t0 + 13_999)).toBe(false);
      // Past the window — fresh again.
      expect(store.claim("k", t0 + 14_001)).toBe(true);
    });

    it("ttlMs wins over retryProfile when both are supplied", () => {
      // retryProfile would derive 14_000ms; explicit ttlMs is 1_000ms.
      const store = new InMemoryIdempotencyStore({
        ttlMs: 1_000,
        retryProfile: {
          maxRetries: 4,
          backoff: { strategy: "linear", baseMs: 100 },
          timeoutMs: 500,
        },
      });
      const t0 = 1_000_000;
      expect(store.claim("k", t0)).toBe(true);
      // Past the explicit 1_000ms window — fresh again, proving
      // ttlMs (not retryProfile's 14s) is in effect.
      expect(store.claim("k", t0 + 1_001)).toBe(true);
    });

    it("falls back to the 24-hour default when neither is supplied", () => {
      const store = new InMemoryIdempotencyStore();
      const t0 = 1_000_000;
      const dayMs = 24 * 60 * 60 * 1000;
      expect(store.claim("k", t0)).toBe(true);
      // Just inside the default window.
      expect(store.claim("k", t0 + dayMs - 1)).toBe(false);
      // Just past it.
      expect(store.claim("k", t0 + dayMs + 1)).toBe(true);
    });
  });
});
