import { describe, expect, it } from "vitest";
import { extractIdempotencyKey } from "../src/idempotency.js";

// The IdempotencyStore port + InMemoryIdempotencyStore impl tests
// moved to libs/act-ops/test/in-memory.spec.ts when the class was
// promoted to `@rotorsoft/act-ops` (#746). `extractIdempotencyKey`
// stays here until #743 lifts it into `@rotorsoft/act-http/receiver`.
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
