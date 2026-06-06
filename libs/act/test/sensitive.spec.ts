import { describe, expect, it } from "vitest";
import { z } from "zod";
import { getSensitiveFields, sensitive } from "../src/sensitive.js";

describe("sensitive()", () => {
  it("returns the same schema instance", () => {
    const inner = z.string();
    expect(sensitive(inner)).toBe(inner);
  });

  it("preserves the static type at runtime — wrapping doesn't change parse behavior", () => {
    const schema = sensitive(z.email());
    expect(schema.parse("a@b.com")).toBe("a@b.com");
    expect(() => schema.parse("not-an-email")).toThrow();
  });

  it("is idempotent — re-wrapping is a no-op", () => {
    const schema = z.string();
    expect(sensitive(sensitive(schema))).toBe(schema);
    expect(sensitive(sensitive(sensitive(schema)))).toBe(schema);
  });

  it("marks each call's schema independently — separate instances aren't conflated", () => {
    const a = z.string();
    const b = z.string();
    sensitive(a);
    // b was never marked — getSensitiveFields treats it as non-sensitive
    expect(getSensitiveFields(z.object({ a, b }))).toEqual(["a"]);
  });
});

describe("getSensitiveFields()", () => {
  it("returns the keys whose schema was marked sensitive", () => {
    const schema = z.object({
      email: sensitive(z.string()),
      name: sensitive(z.string()),
      plan: z.enum(["free", "pro"]),
    });
    expect(getSensitiveFields(schema)).toEqual(["email", "name"]);
  });

  it("returns an empty array when no field is sensitive", () => {
    const schema = z.object({
      plan: z.enum(["free", "pro"]),
      count: z.number(),
    });
    expect(getSensitiveFields(schema)).toEqual([]);
  });

  it("returns an empty array for non-object schemas (zero-cost path)", () => {
    expect(getSensitiveFields(z.string())).toEqual([]);
    expect(getSensitiveFields(z.number())).toEqual([]);
    expect(getSensitiveFields(z.array(z.string()))).toEqual([]);
  });

  it("sees through .optional() — sensitive(x).optional() is still sensitive", () => {
    const schema = z.object({
      email: sensitive(z.string()).optional(),
      plan: z.enum(["free", "pro"]),
    });
    expect(getSensitiveFields(schema)).toEqual(["email"]);
  });

  it("sees through .nullable() — sensitive(x).nullable() is still sensitive", () => {
    const schema = z.object({
      ssn: sensitive(z.string()).nullable(),
    });
    expect(getSensitiveFields(schema)).toEqual(["ssn"]);
  });

  it("sees through .default() — sensitive(x).default() is still sensitive", () => {
    const schema = z.object({
      nickname: sensitive(z.string()).default(""),
    });
    expect(getSensitiveFields(schema)).toEqual(["nickname"]);
  });

  it("sees through chained wrappers — .nullable().optional() composes", () => {
    const schema = z.object({
      middleName: sensitive(z.string()).nullable().optional(),
    });
    expect(getSensitiveFields(schema)).toEqual(["middleName"]);
  });

  it("does NOT descend into nested object fields — only top-level shape walked", () => {
    // Nested sensitivity is deferred until a real callsite needs it; this test
    // pins the current contract so a future change to recursive descent is an
    // intentional design move, not a silent broadening.
    const schema = z.object({
      profile: z.object({
        email: sensitive(z.string()),
      }),
    });
    expect(getSensitiveFields(schema)).toEqual([]);
  });
});
