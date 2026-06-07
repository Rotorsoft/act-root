import { describe, expect, it } from "vitest";
import { extractIdempotencyKey } from "../../src/receiver/index.js";

describe("extractIdempotencyKey", () => {
  it("returns the header value (case-insensitive)", () => {
    expect(extractIdempotencyKey({ "Idempotency-Key": "abc" })).toBe("abc");
    expect(extractIdempotencyKey({ "idempotency-key": "abc" })).toBe("abc");
    expect(extractIdempotencyKey({ "IDEMPOTENCY-KEY": "abc" })).toBe("abc");
  });

  it("handles mixed-case header names", () => {
    expect(extractIdempotencyKey({ "iDeMpOtEnCy-KeY": "abc" })).toBe("abc");
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

  it("returns undefined when header value is the empty string", () => {
    // An empty Idempotency-Key carries no idempotency information —
    // every empty-keyed request would dedup against every other
    // empty-keyed request, almost certainly a client bug. Treat as
    // missing.
    expect(extractIdempotencyKey({ "idempotency-key": "" })).toBeUndefined();
  });
});
