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

    it("returns {} for deeply-equal-but-distinct plain inputs (recursion bottoms out)", () => {
      expect(delta<Schema>({ a: { b: 1 } }, { a: { b: 1 } })).toEqual({});
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

  describe("non-plain values — reference equality", () => {
    it("omits same array reference", () => {
      const items = [1, 2, 3];
      expect(delta<Schema>({ items }, { items })).toEqual({});
    });

    it("replaces array on different reference (even with same content)", () => {
      const a1 = [1, 2, 3];
      const a2 = [1, 2, 3];
      expect(delta<Schema>({ items: a1 }, { items: a2 })).toEqual({
        items: a2,
      });
    });

    it("replaces array on different content", () => {
      expect(delta<Schema>({ items: [1, 2, 3] }, { items: [4, 5] })).toEqual({
        items: [4, 5],
      });
    });

    it("omits same Date reference", () => {
      const d = new Date("2024-01-01");
      expect(delta<Schema>({ created: d }, { created: d })).toEqual({});
    });

    it("replaces Date on different reference (even with same getTime)", () => {
      const d1 = new Date("2024-01-01");
      const d2 = new Date("2024-01-01");
      expect(delta<Schema>({ created: d1 }, { created: d2 })).toEqual({
        created: d2,
      });
    });

    it("omits same Map reference", () => {
      const m = new Map([["a", 1]]);
      expect(delta<Schema>({ data: m }, { data: m })).toEqual({});
    });

    it("replaces Map on different reference", () => {
      const m1 = new Map([["a", 1]]);
      const m2 = new Map([["a", 1]]);
      expect(delta<Schema>({ data: m1 }, { data: m2 })).toEqual({ data: m2 });
    });

    it("omits same Set reference", () => {
      const s = new Set([1, 2, 3]);
      expect(delta<Schema>({ data: s }, { data: s })).toEqual({});
    });

    it("replaces Set on different reference", () => {
      const s1 = new Set([1, 2, 3]);
      const s2 = new Set([1, 2, 3]);
      expect(delta<Schema>({ data: s1 }, { data: s2 })).toEqual({ data: s2 });
    });

    it("omits same RegExp reference", () => {
      const r = /abc/i;
      expect(delta<Schema>({ p: r }, { p: r })).toEqual({});
    });

    it("replaces RegExp on different reference", () => {
      expect(delta<Schema>({ p: /abc/i }, { p: /abc/i })).toEqual({
        p: /abc/i,
      });
    });

    it("omits same TypedArray reference", () => {
      const a = new Uint8Array([1, 2, 3]);
      expect(delta<Schema>({ buf: a }, { buf: a })).toEqual({});
    });

    it("replaces TypedArray on different reference", () => {
      const a1 = new Uint8Array([1, 2, 3]);
      const a2 = new Uint8Array([1, 2, 3]);
      expect(delta<Schema>({ buf: a1 }, { buf: a2 })).toEqual({ buf: a2 });
    });
  });

  describe("empty / no-op", () => {
    it("returns {} when before === after (reference equality)", () => {
      const x = { a: 1, b: 2 };
      const result = delta(x, x);
      expect(result).toEqual({});
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
