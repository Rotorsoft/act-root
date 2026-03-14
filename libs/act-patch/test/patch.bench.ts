import { bench, describe } from "vitest";
import { patch } from "../src/index.js";

type S = Record<string, any>;

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

describe("core patch", () => {
  bench("no-op (empty patch)", () => {
    patch(shallow, {});
  });

  bench("shallow single-key patch (5 keys)", () => {
    patch(shallow, { a: 2 });
  });

  bench("deep 3-level patch", () => {
    patch(deep, { l1: { l2: { l3: { val: "new" } } } });
  });

  bench("wide object (100 keys) single patch", () => {
    patch(wide, { k50: 999 });
  });

  bench("large state (1000 keys) sparse 10-key patch", () => {
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

  bench("delete via null", () => {
    patch(shallow, { b: null });
  });

  bench("delete via undefined", () => {
    patch(shallow, { b: undefined });
  });

  bench("array replacement", () => {
    patch({ items: [1, 2, 3, 4, 5] } as S, { items: [6, 7, 8] });
  });

  bench("sequential 10 patches", () => {
    let state: S = shallow;
    for (let i = 0; i < 10; i++) {
      state = patch(state, { a: i });
    }
  });
});
