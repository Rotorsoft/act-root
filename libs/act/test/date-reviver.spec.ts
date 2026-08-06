import { describe, expect, it } from "vitest";
import { dateReviver } from "../src/index.js";

/**
 * The single date reviver every adapter shares (#1198). It lives in core
 * so PG, SQLite, and any third-party adapter revive dates identically —
 * two hand-synced copies is how `pii` ended up parsing differently from
 * `data` (#1365/#1370).
 */
describe("dateReviver", () => {
  it("returns a Date for a valid ISO-8601 string", () => {
    const iso = "2023-01-01T10:00:00.000Z";
    const result = dateReviver("key", iso);
    expect(result).toBeInstanceOf(Date);
    expect((result as Date).toISOString()).toBe(iso);
  });

  it("rolls over invalid dates that still match the pattern", () => {
    // 2023-02-30 is well-formed but not a real date — Date rolls it to Mar 2.
    const result = dateReviver("key", "2023-02-30T10:00:00.000Z") as Date;
    expect(result).toBeInstanceOf(Date);
    expect(result.getUTCFullYear()).toBe(2023);
    expect(result.getUTCMonth()).toBe(2);
    expect(result.getUTCDate()).toBe(2);
  });

  it("passes non-string values through untouched", () => {
    const n = 12345;
    expect(dateReviver("key", n)).toBe(n);
  });

  it("passes non-date strings through untouched", () => {
    expect(dateReviver("key", "hello world")).toBe("hello world");
  });

  it("revives dates nested anywhere in a JSON.parse", () => {
    const parsed = JSON.parse(
      '{"at":"2024-03-01T10:20:30.000Z","nested":{"born":"2024-03-01T10:20:30.000Z"},"plain":"nope"}',
      dateReviver
    );
    expect(parsed.at).toBeInstanceOf(Date);
    expect(parsed.nested.born).toBeInstanceOf(Date);
    expect(parsed.plain).toBe("nope");
  });
});
