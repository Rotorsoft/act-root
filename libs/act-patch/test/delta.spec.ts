import { describe, expect, it } from "vitest";
import { delta, patch } from "../src/index.js";

type Schema = Record<string, any>;

describe("delta", () => {
  describe("plain object diffs", () => {
    it("computes shallow add", () => {
      expect(delta<Schema>({ a: 1 }, { a: 1, b: 2 })).toEqual({ b: 2 });
    });

    it("computes shallow change", () => {
      expect(delta<Schema>({ a: 1, b: 2 }, { a: 10, b: 2 })).toEqual({ a: 10 });
    });

    it("computes shallow delete", () => {
      expect(delta<Schema>({ a: 1, b: 2 }, { a: 1 })).toEqual({ b: null });
    });

    it("returns empty result on equality", () => {
      expect(delta<Schema>({ a: 1, b: 2 }, { a: 1, b: 2 })).toEqual({});
    });

    it("computes nested delta (3+ levels)", () => {
      const before = { l1: { l2: { l3: { val: "old", keep: true } } } };
      const after = { l1: { l2: { l3: { val: "new", keep: true } } } };
      expect(delta<Schema>(before, after)).toEqual({
        l1: { l2: { l3: { val: "new" } } },
      });
    });

    it("omits unchanged nested branches", () => {
      const before = {
        a: { x: 1, y: 2 },
        b: { z: 3 },
      };
      const after = {
        a: { x: 10, y: 2 },
        b: { z: 3 },
      };
      expect(delta<Schema>(before, after)).toEqual({ a: { x: 10 } });
    });

    it("inlines new nested object when key is missing in before", () => {
      const before = { a: 1 };
      const after = { a: 1, nested: { x: 1 } };
      expect(delta<Schema>(before, after)).toEqual({ nested: { x: 1 } });
    });

    it("deletes nested via null when key is missing in after", () => {
      const before = { config: { feature: true } };
      const after = {};
      expect(delta<Schema>(before, after)).toEqual({ config: null });
    });
  });

  describe("primitive equality", () => {
    it("treats equal numbers as no-op", () => {
      expect(delta<Schema>({ x: 1 }, { x: 1 })).toEqual({});
    });

    it("treats equal strings as no-op", () => {
      expect(delta<Schema>({ x: "a" }, { x: "a" })).toEqual({});
    });

    it("treats equal booleans as no-op", () => {
      expect(delta<Schema>({ x: true }, { x: true })).toEqual({});
    });

    it("treats NaN as equal to NaN (Object.is)", () => {
      expect(delta<Schema>({ x: NaN }, { x: NaN })).toEqual({});
    });

    it("treats +0 and -0 as different (Object.is)", () => {
      const result = delta<Schema>({ x: +0 }, { x: -0 });
      expect(Object.is(result.x, -0)).toBe(true);
    });
  });

  describe("deletion via missing keys", () => {
    it("emits null for keys present only in before", () => {
      expect(delta<Schema>({ a: 1, b: 2, c: 3 }, { a: 1 })).toEqual({
        b: null,
        c: null,
      });
    });
  });

  describe("array equality", () => {
    it("treats same-length element-wise equal arrays as no-op", () => {
      expect(delta<Schema>({ items: [1, 2, 3] }, { items: [1, 2, 3] })).toEqual(
        {}
      );
    });

    it("replaces array on different length", () => {
      expect(delta<Schema>({ items: [1, 2, 3] }, { items: [1, 2] })).toEqual({
        items: [1, 2],
      });
    });

    it("replaces array on different element", () => {
      expect(delta<Schema>({ items: [1, 2, 3] }, { items: [1, 9, 3] })).toEqual(
        { items: [1, 9, 3] }
      );
    });

    it("replaces with empty array", () => {
      expect(delta<Schema>({ items: [1, 2] }, { items: [] })).toEqual({
        items: [],
      });
    });

    it("treats nested-equal arrays as no-op", () => {
      const before = { items: [{ x: 1 }, { y: 2 }] };
      const after = { items: [{ x: 1 }, { y: 2 }] };
      expect(delta<Schema>(before, after)).toEqual({});
    });
  });

  describe("unmergeable types", () => {
    it("treats Date instances with same getTime as equal", () => {
      const d1 = new Date("2024-01-01");
      const d2 = new Date("2024-01-01");
      expect(delta<Schema>({ created: d1 }, { created: d2 })).toEqual({});
    });

    it("replaces Date instances with different getTime", () => {
      const d1 = new Date("2024-01-01");
      const d2 = new Date("2025-06-15");
      expect(delta<Schema>({ created: d1 }, { created: d2 })).toEqual({
        created: d2,
      });
    });

    it("treats RegExp with same source+flags as equal", () => {
      expect(delta<Schema>({ p: /abc/i }, { p: /abc/i })).toEqual({});
    });

    it("replaces RegExp on different source", () => {
      expect(delta<Schema>({ p: /old/ }, { p: /new/ })).toEqual({ p: /new/ });
    });

    it("replaces RegExp on different flags", () => {
      expect(delta<Schema>({ p: /abc/ }, { p: /abc/i })).toEqual({ p: /abc/i });
    });

    it("treats TypedArrays with same content as equal", () => {
      const a1 = new Uint8Array([1, 2, 3]);
      const a2 = new Uint8Array([1, 2, 3]);
      expect(delta<Schema>({ buf: a1 }, { buf: a2 })).toEqual({});
    });

    it("replaces TypedArrays on different content", () => {
      const a1 = new Uint8Array([1, 2]);
      const a2 = new Uint8Array([3, 4]);
      expect(delta<Schema>({ buf: a1 }, { buf: a2 })).toEqual({ buf: a2 });
    });

    it("replaces TypedArrays on different length", () => {
      const a1 = new Uint8Array([1, 2]);
      const a2 = new Uint8Array([1, 2, 3]);
      expect(delta<Schema>({ buf: a1 }, { buf: a2 })).toEqual({ buf: a2 });
    });

    it("treats different TypedArray subtypes as different", () => {
      const a1 = new Uint8Array([1, 2]);
      const a2 = new Int8Array([1, 2]);
      expect(delta<Schema>({ buf: a1 }, { buf: a2 })).toEqual({ buf: a2 });
    });

    it("treats Float TypedArrays with same content as equal", () => {
      const a1 = new Float64Array([1.5, 2.5]);
      const a2 = new Float64Array([1.5, 2.5]);
      expect(delta<Schema>({ buf: a1 }, { buf: a2 })).toEqual({});
    });

    it("treats ArrayBuffer with byte-equal content as equal", () => {
      const b1 = new ArrayBuffer(4);
      const b2 = new ArrayBuffer(4);
      new Uint8Array(b1).set([1, 2, 3, 4]);
      new Uint8Array(b2).set([1, 2, 3, 4]);
      expect(delta<Schema>({ buf: b1 }, { buf: b2 })).toEqual({});
    });

    it("replaces ArrayBuffer on different bytes", () => {
      const b1 = new ArrayBuffer(4);
      const b2 = new ArrayBuffer(4);
      new Uint8Array(b1).set([1, 2, 3, 4]);
      new Uint8Array(b2).set([5, 6, 7, 8]);
      expect(delta<Schema>({ buf: b1 }, { buf: b2 })).toEqual({ buf: b2 });
    });

    it("replaces ArrayBuffer on different byteLength", () => {
      const b1 = new ArrayBuffer(8);
      const b2 = new ArrayBuffer(16);
      expect(delta<Schema>({ buf: b1 }, { buf: b2 })).toEqual({ buf: b2 });
    });

    it("treats SharedArrayBuffer with byte-equal content as equal", () => {
      if (typeof SharedArrayBuffer === "undefined") return;
      const s1 = new SharedArrayBuffer(4);
      const s2 = new SharedArrayBuffer(4);
      new Uint8Array(s1).set([1, 2, 3, 4]);
      new Uint8Array(s2).set([1, 2, 3, 4]);
      expect(delta<Schema>({ buf: s1 }, { buf: s2 })).toEqual({});
    });

    it("treats DataView with same byte content as equal", () => {
      const buf1 = new ArrayBuffer(4);
      const buf2 = new ArrayBuffer(4);
      new Uint8Array(buf1).set([1, 2, 3, 4]);
      new Uint8Array(buf2).set([1, 2, 3, 4]);
      const dv1 = new DataView(buf1);
      const dv2 = new DataView(buf2);
      expect(delta<Schema>({ view: dv1 }, { view: dv2 })).toEqual({});
    });

    it("replaces DataView on different bytes", () => {
      const dv1 = new DataView(new ArrayBuffer(4));
      const dv2 = new DataView(new ArrayBuffer(4));
      new Uint8Array(dv2.buffer).set([1, 2, 3, 4]);
      expect(delta<Schema>({ view: dv1 }, { view: dv2 })).toEqual({
        view: dv2,
      });
    });

    it("treats Maps with same entries as equal regardless of order", () => {
      const m1 = new Map([
        ["a", 1],
        ["b", 2],
      ]);
      const m2 = new Map([
        ["b", 2],
        ["a", 1],
      ]);
      expect(delta<Schema>({ data: m1 }, { data: m2 })).toEqual({});
    });

    it("replaces Maps on different size", () => {
      const m1 = new Map([["a", 1]]);
      const m2 = new Map([
        ["a", 1],
        ["b", 2],
      ]);
      expect(delta<Schema>({ data: m1 }, { data: m2 })).toEqual({ data: m2 });
    });

    it("replaces Maps on different value at same key", () => {
      const m1 = new Map([["a", 1]]);
      const m2 = new Map([["a", 2]]);
      expect(delta<Schema>({ data: m1 }, { data: m2 })).toEqual({ data: m2 });
    });

    it("treats Sets with same members as equal regardless of order", () => {
      const s1 = new Set([1, 2, 3]);
      const s2 = new Set([3, 2, 1]);
      expect(delta<Schema>({ data: s1 }, { data: s2 })).toEqual({});
    });

    it("replaces Sets on different members", () => {
      const s1 = new Set([1, 2]);
      const s2 = new Set([1, 3]);
      expect(delta<Schema>({ data: s1 }, { data: s2 })).toEqual({ data: s2 });
    });

    it("treats WeakMaps as equal only on reference", () => {
      const wm = new WeakMap();
      expect(delta<Schema>({ data: wm }, { data: wm })).toEqual({});
    });

    it("replaces WeakMaps when references differ", () => {
      const wm1 = new WeakMap();
      const wm2 = new WeakMap();
      expect(delta<Schema>({ data: wm1 }, { data: wm2 })).toEqual({
        data: wm2,
      });
    });

    it("treats WeakSets as equal only on reference", () => {
      const ws = new WeakSet();
      expect(delta<Schema>({ data: ws }, { data: ws })).toEqual({});
    });

    it("replaces WeakSets when references differ", () => {
      const ws1 = new WeakSet();
      const ws2 = new WeakSet();
      expect(delta<Schema>({ data: ws1 }, { data: ws2 })).toEqual({
        data: ws2,
      });
    });
  });

  describe("empty / no-op", () => {
    it("returns {} when before === after (reference equality)", () => {
      const x = { a: 1, b: 2 };
      const result = delta(x, x);
      expect(result).toEqual({});
    });

    it("returns {} for deeply-equal-but-distinct inputs", () => {
      expect(delta<Schema>({ a: { b: 1 } }, { a: { b: 1 } })).toEqual({});
    });

    it("returns {} for deeply equal arrays at root via key", () => {
      expect(delta<Schema>({ list: [{ x: 1 }] }, { list: [{ x: 1 }] })).toEqual(
        {}
      );
    });
  });

  describe("wide objects (>16 keys)", () => {
    const buildWide = (): Schema => {
      const o: Schema = {};
      for (let i = 0; i < 20; i++) o[`k${i}`] = i;
      return o;
    };

    it("emits a single-key delta for one changed key", () => {
      const before = buildWide();
      const after = { ...before, k10: 999 };
      expect(delta(before, after)).toEqual({ k10: 999 });
    });

    it("emits a single-key null delta for one deleted key", () => {
      const before = buildWide();
      const after = { ...before };
      delete after.k5;
      expect(delta(before, after)).toEqual({ k5: null });
    });
  });

  describe("mixed adds/deletes/changes at the same level", () => {
    it("combines all three operations", () => {
      const before = { keep: 1, change: "old", remove: true };
      const after = { keep: 1, change: "new", add: 42 };
      expect(delta<Schema>(before, after)).toEqual({
        change: "new",
        remove: null,
        add: 42,
      });
    });
  });

  describe("round-trip property — patch(before, delta(before, after)) ≡ after", () => {
    type Fixture = { name: string; before: Schema; patches: Schema };
    const fixtures: Fixture[] = [
      {
        name: "deep merges nested objects",
        before: { a: { x: 1, y: 2 }, b: 3 },
        patches: { a: { x: 10 } },
      },
      {
        name: "deeply nested (3+ levels)",
        before: { l1: { l2: { l3: { val: "old", keep: true } } } },
        patches: { l1: { l2: { l3: { val: "new" } } } },
      },
      {
        name: "merges when original nested key is missing",
        before: { a: 1 },
        patches: { nested: { x: 1 } },
      },
      {
        name: "merges when original is empty and patch is mergeable",
        before: {},
        patches: { config: { feature: true } },
      },
      {
        name: "replaces numbers",
        before: { count: 0 },
        patches: { count: 5 },
      },
      {
        name: "replaces strings",
        before: { name: "old" },
        patches: { name: "new" },
      },
      {
        name: "replaces booleans",
        before: { flag: true },
        patches: { flag: false },
      },
      {
        name: "deletes keys set to null",
        before: { a: 1, b: 2 },
        patches: { b: null },
      },
      {
        name: "deletes all keys",
        before: { a: 1, b: 2 },
        patches: { a: null, b: null },
      },
      {
        name: "deletes nested via undefined on parent",
        before: { config: { feature: true } },
        patches: { config: null },
      },
      {
        name: "replaces arrays entirely",
        before: { items: [1, 2, 3] },
        patches: { items: [4, 5] },
      },
      {
        name: "replaces with empty array",
        before: { items: [1, 2] },
        patches: { items: [] },
      },
      {
        name: "replaces Date instances",
        before: { created: new Date("2024-01-01") },
        patches: { created: new Date("2025-06-15") },
      },
      {
        name: "replaces Map instances",
        before: { data: new Map([["a", 1]]) },
        patches: { data: new Map([["b", 2]]) },
      },
      {
        name: "replaces Set instances",
        before: { data: new Set([1]) },
        patches: { data: new Set([2]) },
      },
      {
        name: "replaces RegExp instances",
        before: { pattern: /old/ },
        patches: { pattern: /new/ },
      },
      {
        name: "adds keys not in original",
        before: { a: 1 },
        patches: { b: 2 },
      },
      {
        name: "deep merge with arrays and maps",
        before: { a: { b: { c: 1, e: [1, 2, 3] } } },
        patches: { a: { b: { d: 2, e: [4, 5, 6] } } },
      },
      {
        name: "wide single-key change",
        before: (() => {
          const o: Schema = {};
          for (let i = 0; i < 20; i++) o[`k${i}`] = i;
          return o;
        })(),
        patches: { k10: 999 },
      },
      {
        name: "wide single-key delete",
        before: (() => {
          const o: Schema = {};
          for (let i = 0; i < 20; i++) o[`k${i}`] = i;
          return o;
        })(),
        patches: { k5: null },
      },
      {
        name: "wide deep-merge nested value",
        before: (() => {
          const o: Schema = { nested: { a: 1, b: 2 } };
          for (let i = 0; i < 20; i++) o[`k${i}`] = i;
          return o;
        })(),
        patches: { nested: { a: 10 } },
      },
    ];

    for (const f of fixtures) {
      it(`round-trip: ${f.name}`, () => {
        const after = patch(f.before, f.patches);
        const d = delta(f.before, after);
        const replayed = patch(f.before, d);
        expect(replayed).toEqual(after);
      });
    }
  });
});
