import { describe, expect, it } from "vitest";
import { patch } from "../src/index.js";

type Schema = Record<string, any>;

describe("patch", () => {
  describe("deep merge", () => {
    it("deep merges nested objects", () => {
      const result = patch<Schema>(
        { a: { x: 1, y: 2 }, b: 3 },
        { a: { x: 10 } }
      );
      expect(result).toEqual({ a: { x: 10, y: 2 }, b: 3 });
    });

    it("deeply nested (3+ levels)", () => {
      const result = patch<Schema>(
        { l1: { l2: { l3: { val: "old", keep: true } } } },
        { l1: { l2: { l3: { val: "new" } } } }
      );
      expect(result).toEqual({
        l1: { l2: { l3: { val: "new", keep: true } } },
      });
    });

    it("merges when original nested key is missing", () => {
      const result = patch<Schema>({ a: 1 }, { nested: { x: 1 } });
      expect(result).toEqual({ a: 1, nested: { x: 1 } });
    });

    it("merges when original is empty and patch is mergeable", () => {
      const result = patch<Schema>({}, { config: { feature: true } });
      expect(result).toEqual({ config: { feature: true } });
    });
  });

  describe("primitive replacement", () => {
    it("replaces numbers", () => {
      expect(patch<Schema>({ count: 0 }, { count: 5 })).toEqual({ count: 5 });
    });

    it("replaces strings", () => {
      expect(patch<Schema>({ name: "old" }, { name: "new" })).toEqual({
        name: "new",
      });
    });

    it("replaces booleans", () => {
      expect(patch<Schema>({ flag: true }, { flag: false })).toEqual({
        flag: false,
      });
    });
  });

  describe("delete via null/undefined", () => {
    it("deletes keys set to undefined", () => {
      const result = patch<Schema>({ a: 1, b: 2 }, { b: undefined });
      expect(result).toEqual({ a: 1 });
    });

    it("deletes keys set to null", () => {
      const result = patch<Schema>({ a: 1, b: 2 }, { b: null });
      expect(result).toEqual({ a: 1 });
    });

    it("deletes all keys", () => {
      const result = patch<Schema>({ a: 1, b: 2 }, { a: undefined, b: null });
      expect(result).toEqual({});
    });

    it("ignores null for keys not in original (no-op)", () => {
      const result = patch<Schema>({ a: 1 }, { b: null });
      expect(result).toEqual({ a: 1 });
    });

    it("deletes nested via undefined on parent", () => {
      const result = patch<Schema>(
        { config: { feature: true } },
        { config: undefined }
      );
      expect(result).toEqual({});
    });
  });

  describe("array replacement", () => {
    it("replaces arrays entirely", () => {
      const result = patch<Schema>({ items: [1, 2, 3] }, { items: [4, 5] });
      expect(result).toEqual({ items: [4, 5] });
    });

    it("replaces with empty array", () => {
      const result = patch<Schema>({ items: [1, 2] }, { items: [] });
      expect(result).toEqual({ items: [] });
    });
  });

  describe("unmergeable types", () => {
    it("replaces Date instances", () => {
      const d1 = new Date("2024-01-01");
      const d2 = new Date("2025-06-15");
      const result = patch<Schema>({ created: d1 }, { created: d2 });
      expect(result.created).toBe(d2);
    });

    it("replaces Map instances", () => {
      const m1 = new Map([["a", 1]]);
      const m2 = new Map([["b", 2]]);
      const result = patch<Schema>({ data: m1 }, { data: m2 });
      expect(result.data).toBe(m2);
    });

    it("replaces Set instances", () => {
      const s1 = new Set([1]);
      const s2 = new Set([2]);
      const result = patch<Schema>({ data: s1 }, { data: s2 });
      expect(result.data).toBe(s2);
    });

    it("replaces RegExp instances", () => {
      const r1 = /old/;
      const r2 = /new/;
      const result = patch<Schema>({ pattern: r1 }, { pattern: r2 });
      expect(result.pattern).toBe(r2);
    });

    it("replaces ArrayBuffer instances", () => {
      const b1 = new ArrayBuffer(8);
      const b2 = new ArrayBuffer(16);
      const result = patch<Schema>({ buf: b1 }, { buf: b2 });
      expect(result.buf).toBe(b2);
    });

    it("replaces Uint8Array instances", () => {
      const a1 = new Uint8Array([1, 2]);
      const a2 = new Uint8Array([3, 4]);
      const result = patch<Schema>({ buf: a1 }, { buf: a2 });
      expect(result.buf).toBe(a2);
    });

    it("replaces Int8Array instances", () => {
      const a1 = new Int8Array([1]);
      const a2 = new Int8Array([2]);
      const result = patch<Schema>({ buf: a1 }, { buf: a2 });
      expect(result.buf).toBe(a2);
    });

    it("replaces Uint8ClampedArray instances", () => {
      const a1 = new Uint8ClampedArray([1]);
      const a2 = new Uint8ClampedArray([2]);
      const result = patch<Schema>({ buf: a1 }, { buf: a2 });
      expect(result.buf).toBe(a2);
    });

    it("replaces Int16Array instances", () => {
      const a1 = new Int16Array([1]);
      const a2 = new Int16Array([2]);
      const result = patch<Schema>({ buf: a1 }, { buf: a2 });
      expect(result.buf).toBe(a2);
    });

    it("replaces Uint16Array instances", () => {
      const a1 = new Uint16Array([1]);
      const a2 = new Uint16Array([2]);
      const result = patch<Schema>({ buf: a1 }, { buf: a2 });
      expect(result.buf).toBe(a2);
    });

    it("replaces Int32Array instances", () => {
      const a1 = new Int32Array([1]);
      const a2 = new Int32Array([2]);
      const result = patch<Schema>({ buf: a1 }, { buf: a2 });
      expect(result.buf).toBe(a2);
    });

    it("replaces Uint32Array instances", () => {
      const a1 = new Uint32Array([1]);
      const a2 = new Uint32Array([2]);
      const result = patch<Schema>({ buf: a1 }, { buf: a2 });
      expect(result.buf).toBe(a2);
    });

    it("replaces Float32Array instances", () => {
      const a1 = new Float32Array([1.0]);
      const a2 = new Float32Array([2.0]);
      const result = patch<Schema>({ buf: a1 }, { buf: a2 });
      expect(result.buf).toBe(a2);
    });

    it("replaces Float64Array instances", () => {
      const a1 = new Float64Array([1.0]);
      const a2 = new Float64Array([2.0]);
      const result = patch<Schema>({ buf: a1 }, { buf: a2 });
      expect(result.buf).toBe(a2);
    });

    it("replaces DataView instances", () => {
      const dv1 = new DataView(new ArrayBuffer(8));
      const dv2 = new DataView(new ArrayBuffer(16));
      const result = patch<Schema>({ view: dv1 }, { view: dv2 });
      expect(result.view).toBe(dv2);
    });

    it("replaces WeakMap instances", () => {
      const wm1 = new WeakMap();
      const wm2 = new WeakMap();
      const result = patch<Schema>({ data: wm1 }, { data: wm2 });
      expect(result.data).toBe(wm2);
    });

    it("replaces WeakSet instances", () => {
      const ws1 = new WeakSet();
      const ws2 = new WeakSet();
      const result = patch<Schema>({ data: ws1 }, { data: ws2 });
      expect(result.data).toBe(ws2);
    });

    it("replaces SharedArrayBuffer instances", () => {
      if (typeof SharedArrayBuffer === "undefined") return;
      const s1 = new SharedArrayBuffer(8);
      const s2 = new SharedArrayBuffer(16);
      const result = patch<Schema>({ buf: s1 }, { buf: s2 });
      expect(result.buf).toBe(s2);
    });
  });

  describe("empty/no-op patches", () => {
    it("short-circuits on empty patch (returns original reference)", () => {
      const original: Schema = { a: 1, b: 2 };
      const result = patch(original, {});
      expect(result).toBe(original);
    });

    it("handles undefined patches gracefully", () => {
      const original: Schema = { a: 1 };
      const result = patch(original, undefined);
      expect(result).toBe(original);
    });

    it("handles null patches gracefully", () => {
      const original: Schema = { a: 1 };
      const result = patch(original, null);
      expect(result).toBe(original);
    });
  });

  describe("new keys", () => {
    it("adds keys not in original", () => {
      const result = patch<Schema>({ a: 1 }, { b: 2 });
      expect(result).toEqual({ a: 1, b: 2 });
    });
  });

  describe("immutability", () => {
    it("does not modify original", () => {
      const original: Schema = { a: { x: 1 }, b: 2 };
      const result = patch(original, { a: { x: 10 } });
      expect(original.a.x).toBe(1);
      expect(result.a.x).toBe(10);
    });

    it("structural sharing: unpatched subtrees reuse reference", () => {
      const original: Schema = { unchanged: { deep: true }, patched: "old" };
      const result = patch(original, { patched: "new" });
      expect(result).toEqual({ unchanged: { deep: true }, patched: "new" });
      expect(result.unchanged).toBe(original.unchanged);
    });
  });

  describe("mixed operations", () => {
    it("handles deep merge with arrays and maps", () => {
      const prev = {
        a: { b: { c: 1, e: [1, 2, 3] } },
      };
      const curr = {
        a: { b: { d: 2, e: [4, 5, 6] } },
      };
      const result = patch(prev, curr);
      expect(result).toEqual({
        a: { b: { c: 1, d: 2, e: [4, 5, 6] } },
      });
    });

    it("handles unmergeables alongside mergeable objects", () => {
      const prev = { a: new Map([["a", 1]]), b: 2 };
      const curr = { b: 3, c: new Map([["c", 4]]), d: new Map() };
      const result = patch(prev, curr);
      expect(result).toEqual({
        a: new Map([["a", 1]]),
        b: 3,
        c: new Map([["c", 4]]),
        d: new Map(),
      });
    });
  });

  describe("wide objects (>16 keys, two-pass path)", () => {
    it("patches a single key in a wide object", () => {
      const wide: Schema = {};
      for (let i = 0; i < 20; i++) wide[`k${i}`] = i;
      const result = patch(wide, { k10: 999 });
      expect(result.k10).toBe(999);
      expect(result.k0).toBe(0);
      expect(result.k19).toBe(19);
      expect(Object.keys(result)).toHaveLength(20);
    });

    it("deletes a key in a wide object", () => {
      const wide: Schema = {};
      for (let i = 0; i < 20; i++) wide[`k${i}`] = i;
      const result = patch(wide, { k5: null });
      expect(result.k5).toBeUndefined();
      expect(Object.keys(result)).toHaveLength(19);
    });

    it("deep merges nested value in a wide object", () => {
      const wide: Schema = {};
      for (let i = 0; i < 20; i++) wide[`k${i}`] = i;
      wide.nested = { a: 1, b: 2 };
      const result = patch(wide, { nested: { a: 10 } });
      expect(result.nested).toEqual({ a: 10, b: 2 });
      expect(result.k0).toBe(0);
    });
  });
});
