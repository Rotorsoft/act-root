import { describe, expect, it } from "vitest";
import { InMemoryIdempotencyStore } from "../src/idempotency/index.js";

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

  describe("two-phase commit / release", () => {
    it("release drops an uncommitted claim so a retry re-processes", () => {
      const store = new InMemoryIdempotencyStore();
      // Tentatively claim, then release — mirrors a handler that threw.
      expect(store.claim("k")).toBe(true);
      store.release("k");
      // The key is fresh again: a retry after failure re-runs the handler.
      expect(store.claim("k")).toBe(true);
    });

    it("commit makes a claim survive so a retry dedups", () => {
      const store = new InMemoryIdempotencyStore();
      expect(store.claim("k")).toBe(true);
      store.commit("k");
      // Committed — a retry sees the key and dedups.
      expect(store.claim("k")).toBe(false);
    });

    it("release after commit is a no-op — a committed claim stays claimed", () => {
      const store = new InMemoryIdempotencyStore();
      expect(store.claim("k")).toBe(true);
      store.commit("k");
      store.release("k");
      // Committing wins: release must not resurrect a committed key.
      expect(store.claim("k")).toBe(false);
    });

    it("a competing claim during the tentative window still dedups", () => {
      const store = new InMemoryIdempotencyStore();
      // First delivery claims tentatively (handler still in flight).
      expect(store.claim("k")).toBe(true);
      // A concurrent duplicate arrives mid-flight — it must be deduped.
      expect(store.claim("k")).toBe(false);
    });

    it("commit on a never-claimed key records it (durable-adapter safety)", () => {
      const store = new InMemoryIdempotencyStore();
      store.commit("k");
      expect(store.claim("k")).toBe(false);
    });

    it("release on a never-claimed key is a no-op", () => {
      const store = new InMemoryIdempotencyStore();
      store.release("k");
      expect(store.size()).toBe(0);
      expect(store.claim("k")).toBe(true);
    });

    it("committed entries still expire after ttlMs", () => {
      const store = new InMemoryIdempotencyStore({ ttlMs: 1_000 });
      const t0 = 1_000_000;
      expect(store.claim("k", t0)).toBe(true);
      store.commit("k", t0);
      expect(store.claim("k", t0 + 500)).toBe(false);
      // Past the window — fresh again even though it was committed.
      expect(store.claim("k", t0 + 1_500)).toBe(true);
    });
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

  describe("commit must not corrupt iteration order (#1268)", () => {
    it("a commit-refreshed entry does not shield an expired one from gc", () => {
      const store = new InMemoryIdempotencyStore({ ttlMs: 1_000 });
      store.claim("a", 0); // expires 1_000
      store.claim("b", 1); // expires 1_001
      // Commit refreshes "a" to expires 1_900. If it kept "a" at its early
      // insertion slot, the gc break-scan would stop at the still-fresh "a"
      // and never reach the expired "b" behind it.
      store.commit("a", 900);
      // At t=1_500 "b" (1_001) has elapsed but "a" (1_900) has not — only
      // "a" must remain, and "b" must be collectable/fresh again.
      expect(store.size(1_500)).toBe(1);
      expect(store.claim("b", 1_500)).toBe(true);
    });

    it("commit does not evict a durable key before a staler tentative one", () => {
      const store = new InMemoryIdempotencyStore({ maxEntries: 2 });
      const t0 = 1_000_000;
      store.claim("a", t0); // [a]
      store.claim("b", t0); // [a, b]
      // Commit touches "a" → it becomes most-recently-used, so the next
      // eviction must drop the stale tentative "b", not the durable "a".
      store.commit("a", t0); // [b, a]
      store.claim("c", t0); // size 3 > 2 → evict oldest ("b") → [a, c]
      expect(store.claim("a", t0)).toBe(false); // durable "a" survived
      expect(store.claim("c", t0)).toBe(false); // "c" survived
      expect(store.claim("b", t0)).toBe(true); // stale "b" was evicted
    });
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
