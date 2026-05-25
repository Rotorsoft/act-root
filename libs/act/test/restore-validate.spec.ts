import { describe, expect, it } from "vitest";
import { validateRestoreRow } from "../src/restore-validate.js";
import type { RestoreRow } from "../src/types/index.js";

/**
 * Source-side blocker validator (ACT-1125). Pure function — no
 * adapter, no I/O, no store. Tests exercise the validator directly
 * with hand-crafted rows; callers iterate their source themselves.
 */
const baseRow = (overrides: Partial<RestoreRow> = {}): RestoreRow => ({
  id: 1,
  name: "Tick",
  data: {},
  stream: "s",
  version: 0,
  created: new Date("2024-01-01T00:00:00.000Z"),
  meta: { correlation: "c", causation: {} },
  ...overrides,
});

describe("validateRestoreRow", () => {
  it("returns no errors for a well-formed row", () => {
    const v = validateRestoreRow();
    expect(v(baseRow(), 1)).toEqual([]);
  });

  it("flags duplicate ids across calls", () => {
    const v = validateRestoreRow();
    expect(v(baseRow({ id: 7 }), 1)).toEqual([]);
    expect(
      v(baseRow({ id: 7, stream: "other", version: 0 }), 2)
    ).toContainEqual({ reason: "Duplicate id: 7" });
  });

  it("flags negative version", () => {
    const v = validateRestoreRow();
    expect(v(baseRow({ version: -1 }), 1)).toContainEqual({
      reason: "Negative version: -1",
    });
  });

  it("flags malformed `created`", () => {
    const v = validateRestoreRow();
    // biome-ignore lint/suspicious/noExplicitAny: invalid input shape
    const row = baseRow({ created: "not-a-date" as any });
    expect(v(row, 1)).toContainEqual({
      reason: "Malformed created: not-a-date",
    });
  });

  it("flags per-stream version-contiguity gap", () => {
    const v = validateRestoreRow();
    expect(v(baseRow({ id: 1, stream: "s", version: 0 }), 1)).toEqual([]);
    expect(v(baseRow({ id: 2, stream: "s", version: 1 }), 2)).toEqual([]);
    // expected 2, got 5
    expect(v(baseRow({ id: 3, stream: "s", version: 5 }), 3)).toContainEqual({
      reason: "Version gap on s: expected 2, got 5",
    });
    // After flagging, advances past the source-provided version so
    // subsequent rows don't cascade — version 6 should be OK.
    expect(v(baseRow({ id: 4, stream: "s", version: 6 }), 4)).toEqual([]);
  });

  it("tracks version progression per stream independently", () => {
    const v = validateRestoreRow();
    expect(v(baseRow({ id: 1, stream: "a", version: 0 }), 1)).toEqual([]);
    expect(v(baseRow({ id: 2, stream: "b", version: 0 }), 2)).toEqual([]);
    expect(v(baseRow({ id: 3, stream: "a", version: 1 }), 3)).toEqual([]);
    expect(v(baseRow({ id: 4, stream: "b", version: 1 }), 4)).toEqual([]);
  });

  it("accepts ISO-string created and Date created equivalently", () => {
    const v = validateRestoreRow();
    expect(v(baseRow({ created: "2024-06-15T12:00:00.000Z" }), 1)).toEqual([]);
  });

  it("returns a fresh stateful closure per factory call", () => {
    const v1 = validateRestoreRow();
    const v2 = validateRestoreRow();
    expect(v1(baseRow({ id: 9 }), 1)).toEqual([]);
    // A second validator doesn't share state with the first.
    expect(v2(baseRow({ id: 9 }), 1)).toEqual([]);
  });

  it("composes — caller can extend with custom rules", () => {
    const baseline = validateRestoreRow();
    const long = "x".repeat(101);
    const customValidator = (row: RestoreRow, rowIdx: number) => {
      const errors = [...baseline(row, rowIdx)];
      if (row.stream.length > 100)
        errors.push({ reason: "Stream name too long" });
      return errors;
    };
    expect(customValidator(baseRow({ stream: long }), 1)).toContainEqual({
      reason: "Stream name too long",
    });
  });

  it("supports an end-to-end iteration loop", async () => {
    // The canonical caller-side pattern: iterate the source, accumulate
    // {row, reason} entries per validator hit.
    const v = validateRestoreRow();
    const errors: Array<{ row: number; reason: string }> = [];
    const rows: RestoreRow[] = [
      baseRow({ id: 1, stream: "s", version: 0 }),
      baseRow({ id: 1, stream: "s", version: 1 }), // duplicate id
      baseRow({ id: 3, stream: "s", version: -1 }), // negative version
    ];
    let rowIdx = 0;
    for (const row of rows) {
      rowIdx++;
      for (const r of v(row, rowIdx))
        errors.push({ row: rowIdx, reason: r.reason });
    }
    expect(errors).toContainEqual({ row: 2, reason: "Duplicate id: 1" });
    expect(errors).toContainEqual({ row: 3, reason: "Negative version: -1" });
  });
});
