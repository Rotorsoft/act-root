import { describe, expect, it } from "vitest";
// Imported from the internal path, not the package root — `min_safe_ttl`
// is intentionally not re-exported from `@rotorsoft/act-ops`. The
// math is an implementation detail of `InMemoryIdempotencyStore`
// (and future durable adapters); operators configure it through the
// store's `retry_profile` option, not by calling this function directly.
import {
  min_safe_ttl,
  type RetryProfile,
} from "../src/idempotency/min-safe-ttl.js";

describe("min_safe_ttl", () => {
  describe("worked example from external-integration.md", () => {
    // maxRetries=5, exponential { baseMs: 200, maxMs: 30_000 }, timeout_ms=2_000
    //   backoff_sum  = 200 + 400 + 800 + 1600 + 3200 = 6_200ms
    //   timeout_sum  = 6 * 2_000                     = 12_000ms
    //   ttl(sf=4)   = (6200 + 12000) * 4            = 72_800ms
    it("matches the documented envelope at default safety_factor", () => {
      const ttl = min_safe_ttl({
        maxRetries: 5,
        backoff: { strategy: "exponential", baseMs: 200, maxMs: 30_000 },
        timeout_ms: 2_000,
      });
      expect(ttl).toBe(72_800);
    });

    it("clears the doc's retry+timeout floor at the default safety factor", () => {
      // Doc states retry+timeout envelope is ~12s; safety_factor=4 default.
      const ttl = min_safe_ttl({
        maxRetries: 5,
        backoff: { strategy: "exponential", baseMs: 200, maxMs: 30_000 },
        timeout_ms: 2_000,
      });
      expect(ttl).toBeGreaterThanOrEqual(12_000 * 4);
    });
  });

  describe("strategy: fixed", () => {
    it("sums baseMs across every retry plus all timeouts", () => {
      // maxRetries=3, fixed baseMs=100, timeout_ms=500
      //   backoff_sum = 3 * 100 = 300
      //   timeout_sum = 4 * 500 = 2_000
      //   ttl(sf=4)  = (300 + 2000) * 4 = 9_200
      const ttl = min_safe_ttl({
        maxRetries: 3,
        backoff: { strategy: "fixed", baseMs: 100 },
        timeout_ms: 500,
      });
      expect(ttl).toBe(9_200);
    });
  });

  describe("strategy: linear", () => {
    it("sums baseMs * (retry + 1) across every retry plus all timeouts", () => {
      // maxRetries=4, linear baseMs=100, timeout_ms=500
      //   backoff_sum = 100 + 200 + 300 + 400 = 1_000
      //   timeout_sum = 5 * 500              = 2_500
      //   ttl(sf=4)  = (1000 + 2500) * 4    = 14_000
      const ttl = min_safe_ttl({
        maxRetries: 4,
        backoff: { strategy: "linear", baseMs: 100 },
        timeout_ms: 500,
      });
      expect(ttl).toBe(14_000);
    });
  });

  describe("strategy: exponential", () => {
    it("doubles baseMs each retry when maxMs is omitted", () => {
      // maxRetries=4, exponential baseMs=100 (no cap), timeout_ms=200
      //   backoff_sum = 100 + 200 + 400 + 800 = 1_500
      //   timeout_sum = 5 * 200              = 1_000
      //   ttl(sf=4)  = (1500 + 1000) * 4    = 10_000
      const ttl = min_safe_ttl({
        maxRetries: 4,
        backoff: { strategy: "exponential", baseMs: 100 },
        timeout_ms: 200,
      });
      expect(ttl).toBe(10_000);
    });

    it("caps individual delays at maxMs when the geometric run would exceed it", () => {
      // maxRetries=6, exponential baseMs=1_000 maxMs=5_000, timeout_ms=0
      //   raw delays: 1000, 2000, 4000, 8000, 16000, 32000
      //   capped:     1000, 2000, 4000, 5000, 5000,  5000
      //   backoff_sum                                = 22_000
      //   timeout_sum = 7 * 0                        = 0
      //   ttl(sf=4)                                 = 88_000
      const ttl = min_safe_ttl({
        maxRetries: 6,
        backoff: { strategy: "exponential", baseMs: 1_000, maxMs: 5_000 },
        timeout_ms: 0,
      });
      expect(ttl).toBe(88_000);
    });
  });

  describe("missing backoff", () => {
    it("treats retries as back-to-back, only timeouts contribute", () => {
      // maxRetries=3, no backoff, timeout_ms=1_000
      //   backoff_sum = 0
      //   timeout_sum = 4 * 1_000 = 4_000
      //   ttl(sf=4)  = 4_000 * 4 = 16_000
      const ttl = min_safe_ttl({
        maxRetries: 3,
        timeout_ms: 1_000,
      });
      expect(ttl).toBe(16_000);
    });
  });

  describe("jitter", () => {
    it("multiplies the backoff sum by 1.5 (worst-case multiplier)", () => {
      // Same shape as the linear case above; jitter inflates only backoff.
      //   backoff_sum (no jitter) = 1_000
      //   backoff_sum (jitter)    = 1_500
      //   timeout_sum             = 2_500
      //   ttl(sf=4)              = (1500 + 2500) * 4 = 16_000
      const profile: RetryProfile = {
        maxRetries: 4,
        backoff: { strategy: "linear", baseMs: 100, jitter: true },
        timeout_ms: 500,
      };
      expect(min_safe_ttl(profile)).toBe(16_000);
    });

    it("leaves the backoff sum unchanged when jitter is explicitly false", () => {
      const profile: RetryProfile = {
        maxRetries: 4,
        backoff: { strategy: "linear", baseMs: 100, jitter: false },
        timeout_ms: 500,
      };
      expect(min_safe_ttl(profile)).toBe(14_000);
    });
  });

  describe("safety_factor", () => {
    it("applies the caller-supplied value", () => {
      // Same as the worked example with safety_factor=1 — gives the bare envelope.
      const bare = min_safe_ttl({
        maxRetries: 5,
        backoff: { strategy: "exponential", baseMs: 200, maxMs: 30_000 },
        timeout_ms: 2_000,
        safety_factor: 1,
      });
      expect(bare).toBe(18_200);
    });

    it("scales linearly with the factor", () => {
      const sf1 = min_safe_ttl({
        maxRetries: 3,
        backoff: { strategy: "fixed", baseMs: 100 },
        timeout_ms: 500,
        safety_factor: 1,
      });
      const sf10 = min_safe_ttl({
        maxRetries: 3,
        backoff: { strategy: "fixed", baseMs: 100 },
        timeout_ms: 500,
        safety_factor: 10,
      });
      expect(sf10).toBe(sf1 * 10);
    });
  });

  describe("edge cases", () => {
    it("maxRetries=0 collapses to a single attempt × safety_factor", () => {
      // backoff_sum = 0 (no retries to delay before)
      // timeout_sum = 1 * 500 = 500
      // ttl(sf=4)  = 500 * 4 = 2_000
      const ttl = min_safe_ttl({
        maxRetries: 0,
        backoff: { strategy: "exponential", baseMs: 200 },
        timeout_ms: 500,
      });
      expect(ttl).toBe(2_000);
    });

    it("timeout_ms=0 with no backoff yields zero", () => {
      const ttl = min_safe_ttl({
        maxRetries: 5,
        timeout_ms: 0,
      });
      expect(ttl).toBe(0);
    });
  });
});
