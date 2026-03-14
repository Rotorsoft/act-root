import { describe, expect, it } from "vitest";
import { patch } from "../src/patch.js";

type Schema = Record<string, any>;

describe("patch", () => {
  it("deep merges nested objects", () => {
    const result = patch<Schema>({ a: { x: 1, y: 2 }, b: 3 }, { a: { x: 10 } });
    expect(result).toEqual({ a: { x: 10, y: 2 }, b: 3 });
  });

  it("replaces primitives", () => {
    const result = patch<Schema>({ count: 0, name: "old" }, { count: 5 });
    expect(result).toEqual({ count: 5, name: "old" });
  });

  it("deletes keys set to undefined", () => {
    const result = patch<Schema>({ a: 1, b: 2 }, { b: undefined });
    expect(result).toEqual({ a: 1 });
  });

  it("deletes keys set to null", () => {
    const result = patch<Schema>({ a: 1, b: 2 }, { b: null });
    expect(result).toEqual({ a: 1 });
  });

  it("replaces arrays (not merged)", () => {
    const result = patch<Schema>({ items: [1, 2, 3] }, { items: [4, 5] });
    expect(result).toEqual({ items: [4, 5] });
  });

  it("replaces Date instances (not merged)", () => {
    const d1 = new Date("2024-01-01");
    const d2 = new Date("2025-06-15");
    const result = patch<Schema>({ created: d1 }, { created: d2 });
    expect(result.created).toBe(d2);
  });

  it("replaces Map instances (not merged)", () => {
    const m1 = new Map([["a", 1]]);
    const m2 = new Map([["b", 2]]);
    const result = patch<Schema>({ data: m1 }, { data: m2 });
    expect(result.data).toBe(m2);
  });

  it("adds new keys", () => {
    const result = patch<Schema>({ a: 1 }, { b: 2 });
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it("is immutable — does not modify original", () => {
    const original: Schema = { a: { x: 1 }, b: 2 };
    const result = patch(original, { a: { x: 10 } });
    expect(original.a.x).toBe(1);
    expect(result.a.x).toBe(10);
  });

  it("handles empty patches", () => {
    const original: Schema = { a: 1, b: 2 };
    const result = patch(original, {});
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it("handles deeply nested merges", () => {
    const result = patch<Schema>(
      { l1: { l2: { l3: { val: "old", keep: true } } } },
      { l1: { l2: { l3: { val: "new" } } } }
    );
    expect(result).toEqual({
      l1: { l2: { l3: { val: "new", keep: true } } },
    });
  });

  it("handles patching with missing original nested key", () => {
    const result = patch<Schema>({ a: 1 }, { nested: { x: 1 } });
    expect(result).toEqual({ a: 1, nested: { x: 1 } });
  });

  it("structural sharing: unpatched subtrees reuse reference", () => {
    const original: Schema = { unchanged: { deep: true }, patched: "old" };
    const result = patch(original, { patched: "new" });
    expect(result).toEqual({ unchanged: { deep: true }, patched: "new" });
    expect(result.unchanged).toBe(original.unchanged);
  });

  it("replaces RegExp instances (not merged)", () => {
    const r1 = /old/;
    const r2 = /new/;
    const result = patch<Schema>({ pattern: r1 }, { pattern: r2 });
    expect(result.pattern).toBe(r2);
  });

  it("replaces Set instances (not merged)", () => {
    const s1 = new Set([1]);
    const s2 = new Set([2]);
    const result = patch<Schema>({ data: s1 }, { data: s2 });
    expect(result.data).toBe(s2);
  });

  it("replaces TypedArray instances (not merged)", () => {
    const a1 = new Uint8Array([1, 2]);
    const a2 = new Uint8Array([3, 4]);
    const result = patch<Schema>({ buf: a1 }, { buf: a2 });
    expect(result.buf).toBe(a2);
  });
});
