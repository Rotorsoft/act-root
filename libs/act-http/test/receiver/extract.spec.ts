import { describe, expect, it } from "vitest";
import { extract_idempotency_key } from "../../src/receiver/index.js";

describe("extract_idempotency_key", () => {
  it("returns the header value (case-insensitive)", () => {
    expect(extract_idempotency_key({ "Idempotency-Key": "abc" })).toBe("abc");
    expect(extract_idempotency_key({ "idempotency-key": "abc" })).toBe("abc");
    expect(extract_idempotency_key({ "IDEMPOTENCY-KEY": "abc" })).toBe("abc");
  });

  it("handles mixed-case header names", () => {
    expect(extract_idempotency_key({ "iDeMpOtEnCy-KeY": "abc" })).toBe("abc");
  });

  it("returns undefined when header is absent", () => {
    expect(extract_idempotency_key({})).toBeUndefined();
    expect(
      extract_idempotency_key({ "content-type": "application/json" })
    ).toBeUndefined();
  });

  it("returns undefined when header value is an array (ambiguous)", () => {
    expect(
      extract_idempotency_key({ "idempotency-key": ["a", "b"] })
    ).toBeUndefined();
  });

  it("returns undefined when header value is undefined", () => {
    expect(
      extract_idempotency_key({ "idempotency-key": undefined })
    ).toBeUndefined();
  });

  it("returns undefined when header value is the empty string", () => {
    // An empty Idempotency-Key carries no idempotency information —
    // every empty-keyed request would dedup against every other
    // empty-keyed request, almost certainly a client bug. Treat as
    // missing.
    expect(extract_idempotency_key({ "idempotency-key": "" })).toBeUndefined();
  });
});
