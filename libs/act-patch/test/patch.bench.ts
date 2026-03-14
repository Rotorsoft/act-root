import { bench, describe } from "vitest";
import { patch } from "../src/index.js";

type S = Record<string, any>;

// --- Inline RFC 6902 JSON Patch (minimal apply) ---
type JsonPatchOp =
  | { op: "add" | "replace"; path: string; value: any }
  | { op: "remove"; path: string };

function jsonPatchApply(doc: S, ops: JsonPatchOp[]): S {
  const result = JSON.parse(JSON.stringify(doc)) as S;
  for (const op of ops) {
    const parts = op.path.split("/").slice(1);
    const last = parts.pop()!;
    let target: any = result;
    for (const p of parts) target = target[p];
    if (op.op === "remove") {
      delete target[last];
    } else {
      target[last] = op.value;
    }
  }
  return result;
}

// --- Inline RFC 7396 JSON Merge Patch ---
function mergePatch(target: S, p: S): S {
  const result: S = { ...target };
  for (const key of Object.keys(p)) {
    const val = p[key] as unknown;
    if (val === null) {
      delete result[key];
    } else if (
      typeof val === "object" &&
      !Array.isArray(val) &&
      typeof result[key] === "object" &&
      !Array.isArray(result[key])
    ) {
      result[key] = mergePatch(result[key] as S, val as S);
    } else {
      result[key] = val;
    }
  }
  return result;
}

// --- Test fixtures ---
const shallow: S = { a: 1, b: "hello", c: true, d: 42, e: "world" };

const deep: S = {
  l1: {
    l2: { l3: { val: "deep", flag: true, count: 99 }, other: "keep" },
    sibling: { x: 1, y: 2 },
  },
  top: "level",
};

const wide: S = {};
for (let i = 0; i < 100; i++) wide[`k${i}`] = i;

const large: S = {};
for (let i = 0; i < 1000; i++) large[`k${i}`] = i;

// Equivalent JSON Patch ops
const shallowOp: JsonPatchOp[] = [{ op: "replace", path: "/a", value: 2 }];
const deepOps: JsonPatchOp[] = [
  { op: "replace", path: "/l1/l2/l3/val", value: "new" },
];
const wideOp: JsonPatchOp[] = [{ op: "replace", path: "/k50", value: 999 }];
const largeOps: JsonPatchOp[] = [
  { op: "replace", path: "/k10", value: 100 },
  { op: "replace", path: "/k100", value: 200 },
  { op: "replace", path: "/k200", value: 300 },
  { op: "replace", path: "/k300", value: 400 },
  { op: "replace", path: "/k400", value: 500 },
  { op: "replace", path: "/k500", value: 600 },
  { op: "replace", path: "/k600", value: 700 },
  { op: "replace", path: "/k700", value: 800 },
  { op: "replace", path: "/k800", value: 900 },
  { op: "replace", path: "/k900", value: 1000 },
];
const deleteOp: JsonPatchOp[] = [{ op: "remove", path: "/b" }];

// --- Benchmarks ---
describe("shallow single-key", () => {
  bench("act-patch", () => {
    patch(shallow, { a: 2 });
  });
  bench("merge-patch (RFC 7396)", () => {
    mergePatch(shallow, { a: 2 });
  });
  bench("json-patch (RFC 6902)", () => {
    jsonPatchApply(shallow, shallowOp);
  });
});

describe("deep 3-level", () => {
  bench("act-patch", () => {
    patch(deep, { l1: { l2: { l3: { val: "new" } } } });
  });
  bench("merge-patch (RFC 7396)", () => {
    mergePatch(deep, { l1: { l2: { l3: { val: "new" } } } });
  });
  bench("json-patch (RFC 6902)", () => {
    jsonPatchApply(deep, deepOps);
  });
});

describe("wide object (100 keys)", () => {
  bench("act-patch", () => {
    patch(wide, { k50: 999 });
  });
  bench("merge-patch (RFC 7396)", () => {
    mergePatch(wide, { k50: 999 });
  });
  bench("json-patch (RFC 6902)", () => {
    jsonPatchApply(wide, wideOp);
  });
});

describe("large state (1000 keys, 10-key patch)", () => {
  bench("act-patch", () => {
    patch(large, {
      k10: 100,
      k100: 200,
      k200: 300,
      k300: 400,
      k400: 500,
      k500: 600,
      k600: 700,
      k700: 800,
      k800: 900,
      k900: 1000,
    });
  });
  bench("merge-patch (RFC 7396)", () => {
    mergePatch(large, {
      k10: 100,
      k100: 200,
      k200: 300,
      k300: 400,
      k400: 500,
      k500: 600,
      k600: 700,
      k700: 800,
      k800: 900,
      k900: 1000,
    });
  });
  bench("json-patch (RFC 6902)", () => {
    jsonPatchApply(large, largeOps);
  });
});

describe("delete", () => {
  bench("act-patch", () => {
    patch(shallow, { b: null });
  });
  bench("merge-patch (RFC 7396)", () => {
    mergePatch(shallow, { b: null });
  });
  bench("json-patch (RFC 6902)", () => {
    jsonPatchApply(shallow, deleteOp);
  });
});

describe("no-op", () => {
  bench("act-patch", () => {
    patch(shallow, {});
  });
  bench("merge-patch (RFC 7396)", () => {
    mergePatch(shallow, {});
  });
  bench("json-patch (RFC 6902)", () => {
    jsonPatchApply(shallow, []);
  });
});

describe("array replacement", () => {
  bench("act-patch", () => {
    patch({ items: [1, 2, 3, 4, 5] } as S, { items: [6, 7, 8] });
  });
  bench("merge-patch (RFC 7396)", () => {
    mergePatch({ items: [1, 2, 3, 4, 5] }, { items: [6, 7, 8] });
  });
  bench("json-patch (RFC 6902)", () => {
    jsonPatchApply({ items: [1, 2, 3, 4, 5] }, [
      { op: "replace", path: "/items", value: [6, 7, 8] },
    ]);
  });
});

describe("sequential 10 patches", () => {
  bench("act-patch", () => {
    let state: S = shallow;
    for (let i = 0; i < 10; i++) state = patch(state, { a: i });
  });
  bench("merge-patch (RFC 7396)", () => {
    let state: S = shallow;
    for (let i = 0; i < 10; i++) state = mergePatch(state, { a: i });
  });
  bench("json-patch (RFC 6902)", () => {
    let state: S = shallow;
    for (let i = 0; i < 10; i++)
      state = jsonPatchApply(state, [{ op: "replace", path: "/a", value: i }]);
  });
});
