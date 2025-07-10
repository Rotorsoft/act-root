import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  config,
  extend,
  patch,
  validate,
  ValidationError,
} from "../src/index.js";

describe("utils", () => {
  describe("config", () => {
    it("should be configured as test", () => {
      expect(config().env).toBe("test");
    });
  });

  describe("patch", () => {
    it("should patch state correctly", () => {
      const prevState = { a: 1, b: 2, c: { d: 10 } };
      const currState = { b: 3, c: { e: 4 } };
      // @ts-expect-error invalid currState
      const patchedState = patch(prevState, currState);
      expect(patchedState).toEqual({
        a: 1,
        b: 3,
        c: {
          d: 10,
          e: 4,
        },
      });
    });

    it("should delete keys with undefined or null values", () => {
      const prevState = { a: 1, b: 2, c: 10 };
      const currState = { b: undefined, c: null, d: null };
      // @ts-expect-error invalid currState
      const patchedState = patch(prevState, currState);
      expect(patchedState).toEqual({ a: 1 });
    });

    it("should test unmergeable using maps", () => {
      const prevState = { a: new Map([["a", 1]]), b: 2 };
      const currState = { b: 3, c: new Map([["c", 4]]), d: new Map() };
      const patchedState = patch(prevState, currState);
      expect(patchedState).toEqual({
        a: new Map([["a", 1]]),
        b: 3,
        c: new Map([["c", 4]]),
        d: new Map(),
      });
    });

    describe("patch edge cases", () => {
      it("should patch deeply nested objects", () => {
        const prev = { a: { b: { c: 1 } } };
        const curr = { a: { b: { d: 2 } } };
        // @ts-expect-error patch accepts any object shape for deep merge test
        const patched = patch(prev, curr);
        expect(patched).toEqual({ a: { b: { c: 1, d: 2 } } });
      });
      it("should not deep merge unmergeable types (Date, Map, ArrayBuffer)", () => {
        const prev = {
          d: new Date(1),
          m: new Map([["a", 1]]),
          b: new ArrayBuffer(8),
        };
        const curr = {
          d: new Date(2),
          m: new Map([["b", 2]]),
          b: new ArrayBuffer(16),
        };
        const patched = patch(prev, curr);
        expect(patched.d.getTime()).toBe(curr.d.getTime());
        expect([...patched.m.entries()]).toEqual([...curr.m.entries()]);
        expect(patched.b.byteLength).toBe(curr.b.byteLength);
      });
      it("should delete root keys with undefined/null", () => {
        const prev = { a: 1, b: 2 };
        // Deliberately cast curr to any to test deletion logic; this is safe for test coverage
        const curr: any = { a: undefined, b: null };
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        const patched = patch(prev, curr);
        expect(patched).toEqual({});
      });
      it("should patch arrays and typed arrays as unmergeable", () => {
        const prev = { arr: [1, 2], buf: new Uint8Array([1, 2]) };
        const curr = { arr: [3, 4], buf: new Uint8Array([3, 4]) };
        const patched = patch(prev, curr);
        expect(patched.arr).toEqual([3, 4]);
        expect([...patched.buf]).toEqual([3, 4]);
      });
    });
  });

  describe("validate", () => {
    const schema = z.object({
      key: z.string(),
    });

    it("should validate payload correctly", () => {
      const payload = { key: "value" };
      const validated = validate("test", payload, schema);
      expect(validated).toEqual(payload);
    });

    it("should throw ValidationError on invalid payload", () => {
      const payload = { key: 123 };
      // @ts-expect-error invalid payload
      expect(() => validate("test", payload, schema)).toThrow(ValidationError);
    });

    describe("validate edge cases", () => {
      it("should throw ValidationError for non-Zod error", () => {
        const fakeSchema = {
          parse: () => {
            throw new Error("not zod");
          },
        };
        // Intentionally using any to simulate a non-Zod schema for coverage; this is safe for test coverage
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        expect(() => validate("test", { foo: 1 }, fakeSchema as any)).toThrow(
          ValidationError
        );
      });

      it("should return payload when no schema is provided", () => {
        const payload = { key: "value" };
        const validated = validate("test", payload);
        expect(validated).toEqual(payload);
      });
    });
  });

  describe("extend", () => {
    const schema = z.object({
      key: z.string(),
    });

    it("should extend target with validated source", () => {
      const source = { key: "value" };
      const target = { otherKey: 123 };
      const extended = extend(source, schema, target);
      expect(extended).toEqual({ otherKey: 123, key: "value" });
    });

    it("should throw ValidationError on invalid source", () => {
      const source = { key: 123 };
      const target = { otherKey: 123 };
      // @ts-expect-error invalid source
      expect(() => extend(source, schema, target)).toThrow(ValidationError);
    });

    describe("extend edge cases", () => {
      it("should extend with no target", () => {
        const schema = z.object({ key: z.string() });
        const source = { key: "value" };
        const extended = extend(source, schema);
        expect(extended).toEqual({ key: "value" });
      });
    });
  });

  it("should resolve sleep with and without ms", async () => {
    const { sleep } = await import("../src/utils.js");
    await expect(sleep(1)).resolves.toBeUndefined();
    await expect(sleep()).resolves.toBeUndefined();
  });
});
