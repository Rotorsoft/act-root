import { bench, describe } from "vitest";
import { delta } from "../src/index.js";

type S = Record<string, any>;

// --- Inline RFC 7396 JSON Merge Patch generator ---
const isPlainObject = (v: unknown): v is S =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function mergePatchDiff(before: S, after: S): S {
  const out: S = {};
  for (const k of Object.keys(before)) {
    if (!(k in after)) out[k] = null;
  }
  for (const k of Object.keys(after)) {
    const a = after[k];
    const b = before[k];
    if (!(k in before)) {
      out[k] = a;
      continue;
    }
    if (a === b) continue;
    if (isPlainObject(a) && isPlainObject(b)) {
      const sub = mergePatchDiff(b, a);
      if (Object.keys(sub).length > 0) out[k] = sub;
      continue;
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) out[k] = a;
  }
  return out;
}

// --- Inline RFC 6902 JSON Patch generator (minimal compare) ---
type JsonPatchOp =
  | { op: "add" | "replace"; path: string; value: any }
  | { op: "remove"; path: string };

function jsonPatchDiff(before: S, after: S, base = ""): JsonPatchOp[] {
  const ops: JsonPatchOp[] = [];
  for (const k of Object.keys(before)) {
    if (!(k in after)) ops.push({ op: "remove", path: `${base}/${k}` });
  }
  for (const k of Object.keys(after)) {
    const a = after[k];
    const b = before[k];
    if (!(k in before)) {
      ops.push({ op: "add", path: `${base}/${k}`, value: a });
      continue;
    }
    if (a === b) continue;
    if (isPlainObject(a) && isPlainObject(b)) {
      ops.push(...jsonPatchDiff(b, a, `${base}/${k}`));
      continue;
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      ops.push({ op: "replace", path: `${base}/${k}`, value: a });
    }
  }
  return ops;
}

// --- Test fixtures ---
const shallowBefore: S = { a: 1, b: "hello", c: true, d: 42, e: "world" };
const shallowAfter: S = { ...shallowBefore, a: 2 };

const deepBefore: S = {
  l1: {
    l2: { l3: { val: "deep", flag: true, count: 99 }, other: "keep" },
    sibling: { x: 1, y: 2 },
  },
  top: "level",
};
const deepAfter: S = {
  l1: {
    l2: { l3: { val: "new", flag: true, count: 99 }, other: "keep" },
    sibling: { x: 1, y: 2 },
  },
  top: "level",
};

const wideBefore: S = {};
for (let i = 0; i < 100; i++) wideBefore[`k${i}`] = i;
const wideAfter: S = { ...wideBefore, k50: 999 };

const largeBefore: S = {};
for (let i = 0; i < 1000; i++) largeBefore[`k${i}`] = i;
const largeAfter: S = { ...largeBefore };
for (let i = 0; i < 10; i++) largeAfter[`k${i * 100}`] = i * 100 + 1000;

const deleteBefore: S = { a: 1, b: 2, c: 3 };
const deleteAfter: S = { a: 1, c: 3 };

const noopBefore: S = { a: 1, b: { c: 2, d: 3 }, e: [1, 2, 3] };
const noopAfter: S = { a: 1, b: { c: 2, d: 3 }, e: [1, 2, 3] };

const arrayBefore: S = { items: [1, 2, 3, 4, 5] };
const arrayAfter: S = { items: [6, 7, 8] };

// --- Benchmarks ---
describe("shallow single-key", () => {
  bench("act-patch delta", () => {
    delta(shallowBefore, shallowAfter);
  });
  bench("merge-patch (RFC 7396) diff", () => {
    mergePatchDiff(shallowBefore, shallowAfter);
  });
  bench("json-patch (RFC 6902) compare", () => {
    jsonPatchDiff(shallowBefore, shallowAfter);
  });
});

describe("deep 3-level", () => {
  bench("act-patch delta", () => {
    delta(deepBefore, deepAfter);
  });
  bench("merge-patch (RFC 7396) diff", () => {
    mergePatchDiff(deepBefore, deepAfter);
  });
  bench("json-patch (RFC 6902) compare", () => {
    jsonPatchDiff(deepBefore, deepAfter);
  });
});

describe("wide object (100 keys)", () => {
  bench("act-patch delta", () => {
    delta(wideBefore, wideAfter);
  });
  bench("merge-patch (RFC 7396) diff", () => {
    mergePatchDiff(wideBefore, wideAfter);
  });
  bench("json-patch (RFC 6902) compare", () => {
    jsonPatchDiff(wideBefore, wideAfter);
  });
});

describe("large state (1000 keys, 10-key change)", () => {
  bench("act-patch delta", () => {
    delta(largeBefore, largeAfter);
  });
  bench("merge-patch (RFC 7396) diff", () => {
    mergePatchDiff(largeBefore, largeAfter);
  });
  bench("json-patch (RFC 6902) compare", () => {
    jsonPatchDiff(largeBefore, largeAfter);
  });
});

describe("delete only", () => {
  bench("act-patch delta", () => {
    delta(deleteBefore, deleteAfter);
  });
  bench("merge-patch (RFC 7396) diff", () => {
    mergePatchDiff(deleteBefore, deleteAfter);
  });
  bench("json-patch (RFC 6902) compare", () => {
    jsonPatchDiff(deleteBefore, deleteAfter);
  });
});

describe("no-op (deeply equal)", () => {
  bench("act-patch delta", () => {
    delta(noopBefore, noopAfter);
  });
  bench("merge-patch (RFC 7396) diff", () => {
    mergePatchDiff(noopBefore, noopAfter);
  });
  bench("json-patch (RFC 6902) compare", () => {
    jsonPatchDiff(noopBefore, noopAfter);
  });
});

describe("array replacement", () => {
  bench("act-patch delta", () => {
    delta(arrayBefore, arrayAfter);
  });
  bench("merge-patch (RFC 7396) diff", () => {
    mergePatchDiff(arrayBefore, arrayAfter);
  });
  bench("json-patch (RFC 6902) compare", () => {
    jsonPatchDiff(arrayBefore, arrayAfter);
  });
});
