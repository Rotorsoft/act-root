import { z } from "zod";
import { config, extend, patch, validate, ValidationError } from "../src";

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
      const patchedState = patch(prevState, currState);
      expect(patchedState).toEqual({
        a: 1,
        b: 3,
        c: {
          d: 10,
          e: 4
        }
      });
    });

    it("should delete keys with undefined or null values", () => {
      const prevState = { a: 1, b: 2, c: 10 };
      const currState = { b: undefined, c: null, d: null };
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
        d: new Map()
      });
    });
  });

  describe("validate", () => {
    const schema = z.object({
      key: z.string()
    });

    it("should validate payload correctly", () => {
      const payload = { key: "value" };
      const validated = validate(payload, schema);
      expect(validated).toEqual(payload);
    });

    it("should throw ValidationError on invalid payload", () => {
      const payload = { key: 123 };
      // @ts-expect-error invalid payload
      expect(() => validate(payload, schema)).toThrow(ValidationError);
    });
  });

  describe("extend", () => {
    const schema = z.object({
      key: z.string()
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
  });
});
