import { describe, expect, it } from "vitest";
import { z } from "zod";
import { date_reviver_schema } from "../src/internal/date-reviver.js";
import { output_of, some_layer, wrapped } from "../src/internal/zod.js";
import { _mark_sensitive, pii_fields } from "../src/sensitive.js";
import { sensitive } from "../src/types/schemas.js";

/**
 * Every feature that looks inside a field's schema sees through the same
 * wrappers, because they all ask `internal/zod.ts`. Each row places a schema
 * behind one wrapper and checks the three things features ask of it.
 */
const placements: Record<string, (inner: () => z.ZodType) => z.ZodType> = {
  plain: (s) => s(),
  optional: (s) => s().optional(),
  "nullable and default": (s) => s().nullable().default(null),
  readonly: (s) => s().readonly(),
  catch: (s) => s().catch(undefined as never),
  "pipe after": (s) => s().pipe(z.any()),
  preprocess: (s) => z.preprocess((v) => v, s()),
  "pipe into": (s) => z.any().pipe(s()),
  lazy: (s) => z.lazy(() => s()),
};

const is_sensitive = (field: z.ZodType) =>
  pii_fields(z.object({ f: field })).length === 1;

describe("seeing through Zod wrappers", () => {
  for (const [name, place] of Object.entries(placements)) {
    it(`finds sensitive() ${name}`, () => {
      expect(is_sensitive(place(() => sensitive(z.string())))).toBe(true);
    });
  }

  it("finds sensitive() before a transform, and not on a plain field", () => {
    expect(is_sensitive(sensitive(z.string()).transform((s) => s.trim()))).toBe(
      true
    );
    expect(is_sensitive(z.string().transform((s) => s.trim()))).toBe(false);
  });

  for (const [name, place] of Object.entries(placements)) {
    // The reviver doesn't follow lazy, and a pipe revives its output side:
    // both have their own tests below.
    if (name === "lazy" || name === "pipe after") continue;
    it(`revives a date ${name}`, () => {
      const reviver = date_reviver_schema(place(() => z.date()));
      expect(reviver?.parse("2026-11-01T00:00:00.000Z")).toBeInstanceOf(Date);
    });
  }

  it("revives a pipe's output side, which is what's stored", () => {
    const at = "2026-11-01T00:00:00.000Z";
    expect(
      date_reviver_schema(z.string().pipe(z.coerce.date()))?.parse(at)
    ).toBeInstanceOf(Date);
    expect(date_reviver_schema(z.date().pipe(z.any()))).toBeUndefined();
  });

  it("revives no date inside z.lazy, so a recursive schema ends", () => {
    type Node = { at: Date; children: Node[] };
    const node: z.ZodType<Node> = z.object({
      at: z.date(),
      children: z.lazy(() => z.array(node)),
    });
    expect(date_reviver_schema(z.lazy(() => z.date()))).toBeUndefined();
    expect(date_reviver_schema(node)).toBeDefined(); // `at` still revives
  });

  it("reads the output side of a pipe, and stops at a transform", () => {
    const type = (s: z.ZodType) =>
      (output_of(s) as { _zod: { def: { type: string } } })._zod.def.type;
    expect(type(z.preprocess((v) => v, z.number()))).toBe("number");
    expect(type(z.string().transform(Number))).toBe("transform");
    expect(type(z.lazy(() => z.string().optional()))).toBe("string");
  });

  it("visits each layer once, so a lazy schema that returns itself ends", () => {
    const self: z.ZodType = z.lazy(() => self);
    expect(some_layer(self, () => false)).toBe(false);
    expect(output_of(self)).toBe(self);
  });

  it("finds no layers in a schema without a definition", () => {
    expect(wrapped({})).toEqual([]);
    expect(some_layer({}, () => true)).toBe(false);
    expect(output_of({})).toEqual({});
  });

  it("refuses to mark a schema without a Zod 4 definition", () => {
    expect(() => _mark_sensitive({} as z.ZodType)).toThrow(
      "sensitive() takes a Zod 4 schema"
    );
  });
});
