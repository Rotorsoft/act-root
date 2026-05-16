import { describe, expect, it } from "vitest";
import { extractIdempotencyKey, IdempotencyCache } from "../src/idempotency.js";

describe("IdempotencyCache", () => {
  it("recordIfFresh returns true the first time, false on re-record", () => {
    const cache = new IdempotencyCache();
    expect(cache.recordIfFresh("k1")).toBe(true);
    expect(cache.recordIfFresh("k1")).toBe(false);
    expect(cache.recordIfFresh("k2")).toBe(true);
  });

  it("expires entries after ttlMs and re-records on next call", () => {
    const cache = new IdempotencyCache({ ttlMs: 1_000 });
    const t0 = 1_000_000;
    expect(cache.recordIfFresh("k1", t0)).toBe(true);
    expect(cache.recordIfFresh("k1", t0 + 500)).toBe(false);
    // Expired — next recordIfFresh treats it as fresh.
    expect(cache.recordIfFresh("k1", t0 + 1_500)).toBe(true);
  });

  it("size reflects current entries after gc", () => {
    const cache = new IdempotencyCache({ ttlMs: 1_000 });
    const t0 = 1_000_000;
    cache.recordIfFresh("a", t0);
    cache.recordIfFresh("b", t0);
    cache.recordIfFresh("c", t0);
    expect(cache.size(t0)).toBe(3);
    // Advance past TTL — gc drops everything.
    expect(cache.size(t0 + 2_000)).toBe(0);
  });

  it("evicts the oldest entry when maxEntries is exceeded", () => {
    const cache = new IdempotencyCache({ maxEntries: 2 });
    cache.recordIfFresh("a");
    cache.recordIfFresh("b");
    cache.recordIfFresh("c"); // "a" evicts (oldest); cache is [b, c]
    expect(cache.size()).toBe(2);
    // "b" and "c" still present.
    expect(cache.recordIfFresh("b")).toBe(false);
    expect(cache.recordIfFresh("c")).toBe(false);
    // "a" is no longer in the cache → fresh again.
    expect(cache.recordIfFresh("a")).toBe(true);
  });

  it("clear drops all entries", () => {
    const cache = new IdempotencyCache();
    cache.recordIfFresh("k");
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.recordIfFresh("k")).toBe(true);
  });

  it("gc stops at the first non-expired entry (insertion order)", () => {
    const cache = new IdempotencyCache({ ttlMs: 1_000 });
    const t0 = 1_000_000;
    cache.recordIfFresh("expired-1", t0);
    cache.recordIfFresh("expired-2", t0 + 100);
    cache.recordIfFresh("fresh", t0 + 800);
    // Sweep at t0 + 1_500: expired-1 and expired-2 are past TTL,
    // "fresh" is not — gc must drop the first two and stop.
    expect(cache.size(t0 + 1_500)).toBe(1);
    expect(cache.recordIfFresh("fresh", t0 + 1_500)).toBe(false);
  });
});

describe("extractIdempotencyKey", () => {
  it("returns the header value (case-insensitive)", () => {
    expect(extractIdempotencyKey({ "Idempotency-Key": "abc" })).toBe("abc");
    expect(extractIdempotencyKey({ "idempotency-key": "abc" })).toBe("abc");
    expect(extractIdempotencyKey({ "IDEMPOTENCY-KEY": "abc" })).toBe("abc");
  });

  it("returns undefined when header is absent", () => {
    expect(extractIdempotencyKey({})).toBeUndefined();
    expect(
      extractIdempotencyKey({ "content-type": "application/json" })
    ).toBeUndefined();
  });

  it("returns undefined when header value is an array (ambiguous)", () => {
    expect(
      extractIdempotencyKey({ "idempotency-key": ["a", "b"] })
    ).toBeUndefined();
  });

  it("returns undefined when header value is undefined", () => {
    expect(
      extractIdempotencyKey({ "idempotency-key": undefined })
    ).toBeUndefined();
  });
});
