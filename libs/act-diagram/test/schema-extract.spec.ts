import { describe, expect, it } from "vitest";
import { extractSchemasFromSource } from "../src/client/lib/schema-extract.js";

describe("extractSchemasFromSource", () => {
  it("captures plain identifier and z.object values", () => {
    const src = `
      state({Foo: FooSchema}).init(()=>({})).emits({
        OrderPlaced: z.object({ orderId: z.string(), total: z.number() }),
        OrderShipped: OrderShippedSchema,
      })`;
    const out = extractSchemasFromSource(
      src,
      new Set(["OrderPlaced", "OrderShipped"])
    );
    expect(out.get("OrderPlaced")).toBe(
      "z.object({ orderId: z.string(), total: z.number() })"
    );
    expect(out.get("OrderShipped")).toBe("OrderShippedSchema");
  });

  it("ignores events not requested in the name set", () => {
    const src = `.emits({ A: z.string(), B: z.number() })`;
    const out = extractSchemasFromSource(src, new Set(["A"]));
    expect(out.get("A")).toBe("z.string()");
    expect(out.has("B")).toBe(false);
  });

  it("handles quoted keys and trailing commas", () => {
    const src = `.emits({ "Some-Event": z.object({}), 'Other': z.never(), })`;
    const out = extractSchemasFromSource(src, new Set(["Some-Event", "Other"]));
    expect(out.get("Some-Event")).toBe("z.object({})");
    expect(out.get("Other")).toBe("z.never()");
  });

  it("skips commas, braces, brackets, parens inside strings and templates", () => {
    const src =
      ".emits({\n" +
      '  A: z.string().describe("with, commas, and }}}"),\n' +
      "  B: z.string().describe(`tmpl ${nested.call()} done, fine`),\n" +
      "})";
    const out = extractSchemasFromSource(src, new Set(["A", "B"]));
    expect(out.get("A")).toBe('z.string().describe("with, commas, and }}}")');
    expect(out.get("B")).toBe(
      "z.string().describe(`tmpl ${nested.call()} done, fine`)"
    );
  });

  it("handles escaped chars inside strings and templates", () => {
    const src =
      ".emits({ A: z.string().describe('it\\'s safe, ok'), B: `a\\` ${x.y}`,})";
    const out = extractSchemasFromSource(src, new Set(["A", "B"]));
    expect(out.get("A")).toBe("z.string().describe('it\\'s safe, ok')");
    expect(out.get("B")).toBe("`a\\` ${x.y}`");
  });

  it("handles multiple .emits blocks in the same file", () => {
    const src = `
      .emits({ A: z.string() })
      // unrelated
      const x = 1;
      .emits({ B: z.number() })
    `;
    const out = extractSchemasFromSource(src, new Set(["A", "B"]));
    expect(out.get("A")).toBe("z.string()");
    expect(out.get("B")).toBe("z.number()");
  });

  it("strips leading comments but preserves internal comments", () => {
    const src = `.emits({
      // leading
      A: z.string(), /* mid */
      B: /* hop */ z.number(),
      C: z./* inline */string(),
    })`;
    const out = extractSchemasFromSource(src, new Set(["A", "B", "C"]));
    expect(out.get("A")).toBe("z.string()");
    // Leading comment before the value is consumed by skipTrivia.
    expect(out.get("B")).toBe("z.number()");
    // A comment mid-expression is part of the captured slice.
    expect(out.get("C")?.replace(/\s+/g, " ").trim()).toBe(
      "z./* inline */string()"
    );
  });

  it("returns empty for empty input or empty name set", () => {
    expect(extractSchemasFromSource("", new Set(["A"])).size).toBe(0);
    expect(
      extractSchemasFromSource(".emits({A:z.string()})", new Set()).size
    ).toBe(0);
  });

  it("skips when no { follows .emits(", () => {
    const src = ".emits(schema).whatever()";
    expect(extractSchemasFromSource(src, new Set(["A"])).size).toBe(0);
  });

  it("returns nothing for malformed (unclosed) blocks", () => {
    const src = ".emits({ A: z.string(";
    const out = extractSchemasFromSource(src, new Set(["A"]));
    expect(out.size).toBe(0);
  });

  it("returns nothing for malformed key tokens", () => {
    const src = ".emits({ @@@: z.string() })";
    expect(extractSchemasFromSource(src, new Set(["A"])).size).toBe(0);
  });

  it("captures shorthand keys as references to the matching identifier", () => {
    const src = ".emits({ TicketOpened, B: z.number() })";
    const out = extractSchemasFromSource(src, new Set(["TicketOpened", "B"]));
    expect(out.get("TicketOpened")).toBe("TicketOpened");
    expect(out.get("B")).toBe("z.number()");
  });

  it("does not capture shorthand for quoted keys (no implicit binding)", () => {
    const src = `.emits({ "A" })`;
    const out = extractSchemasFromSource(src, new Set(["A"]));
    expect(out.has("A")).toBe(false);
  });

  it("ignores empty values (key with nothing after the colon)", () => {
    const src = ".emits({ A:, B: z.number() })";
    const out = extractSchemasFromSource(src, new Set(["A", "B"]));
    expect(out.has("A")).toBe(false);
    expect(out.get("B")).toBe("z.number()");
  });

  it("captures values that span multiple lines and call chains", () => {
    const src = `.emits({
      A: z.object({
        nested: z.array(z.union([z.string(), z.number()])),
      }).describe("multi-line"),
    })`;
    const out = extractSchemasFromSource(src, new Set(["A"]));
    expect(out.get("A")).toContain("z.array(z.union(");
    expect(out.get("A")).toContain('describe("multi-line")');
  });

  it("walks past a line comment encountered mid-expression", () => {
    const src = `.emits({
      A: z.string() // trailing note
        .optional(),
      B: z.number(),
    })`;
    const out = extractSchemasFromSource(src, new Set(["A", "B"]));
    expect(out.get("A")?.replace(/\s+/g, " ")).toBe(
      "z.string() // trailing note .optional()"
    );
    expect(out.get("B")).toBe("z.number()");
  });

  it("handles escaped characters inside quoted keys", () => {
    const src = `.emits({ "Some\\"Event": z.string() })`;
    const out = extractSchemasFromSource(src, new Set([`Some\\"Event`]));
    expect(out.get(`Some\\"Event`)).toBe("z.string()");
  });

  it("walks nested braces inside template-literal interpolations", () => {
    const src =
      ".emits({ A: z.string().describe(`outer ${ ({ a: 1 }).a } end`), })";
    const out = extractSchemasFromSource(src, new Set(["A"]));
    expect(out.get("A")).toContain("describe(");
    expect(out.get("A")).toContain("`outer ${");
  });

  it("captures trailing shorthand without comma", () => {
    const src = ".emits({ A })";
    const out = extractSchemasFromSource(src, new Set(["A"]));
    expect(out.get("A")).toBe("A");
  });

  it("recovers when shorthand is followed by stray tokens", () => {
    // After reading `A`, the next char is the stray `B`. We're not at
    // `:`, `,`, or `}`, so the shorthand-recovery while-loop walks past
    // `B` until it finds the closing brace.
    const src = ".emits({ A B, C: z.string() })";
    const out = extractSchemasFromSource(src, new Set(["A", "B", "C"]));
    // A still captured as shorthand; the stray `B` is consumed.
    expect(out.get("A")).toBe("A");
    expect(out.get("C")).toBe("z.string()");
  });

  it("captures common regex-literal Zod patterns", () => {
    const src = `.emits({ A: z.string().regex(/abc/), B: z.string().regex(/\\w+/g), })`;
    const out = extractSchemasFromSource(src, new Set(["A", "B"]));
    expect(out.get("A")).toBe("z.string().regex(/abc/)");
    expect(out.get("B")).toBe("z.string().regex(/\\w+/g)");
  });

  it("resolves `.emits(IDENT)` by chasing the const definition", () => {
    const src = `
      const Events = {
        Foo: z.object({ id: z.string() }),
        Bar: z.number(),
      };
      const state = something().emits(Events).build();
    `;
    const out = extractSchemasFromSource(src, new Set(["Foo", "Bar"]));
    expect(out.get("Foo")).toBe("z.object({ id: z.string() })");
    expect(out.get("Bar")).toBe("z.number()");
  });

  it("resolves identifiers declared with let or var", () => {
    expect(
      extractSchemasFromSource(
        `let Events = { A: z.string() };\n.emits(Events)`,
        new Set(["A"])
      ).get("A")
    ).toBe("z.string()");
    expect(
      extractSchemasFromSource(
        `var Events = { B: z.boolean() };\n.emits(Events)`,
        new Set(["B"])
      ).get("B")
    ).toBe("z.boolean()");
  });

  it("resolves identifiers with TypeScript type annotations", () => {
    const src = `
      const Events: Record<string, z.ZodType> = {
        A: z.string(),
      };
      .emits(Events)
    `;
    expect(extractSchemasFromSource(src, new Set(["A"])).get("A")).toBe(
      "z.string()"
    );
  });

  it("preserves multi-line method chains (z.object().describe())", () => {
    const src = `
      const Events = {
        Foo: z
          .object({ id: z.string() })
          .describe("with a doc"),
      };
      .emits(Events)
    `;
    const out = extractSchemasFromSource(src, new Set(["Foo"]));
    expect(out.get("Foo")?.replace(/\s+/g, " ")).toBe(
      'z .object({ id: z.string() }) .describe("with a doc")'
    );
  });

  it("skips `.emits(IDENT)` when the identifier can't be resolved", () => {
    const src = `.emits(MissingIdentifier)`;
    const out = extractSchemasFromSource(src, new Set(["X"]));
    expect(out.size).toBe(0);
  });

  it("skips when an identifier resolves to a non-object value", () => {
    const src = `
      const NotAnObject = somethingElse;
      .emits(NotAnObject)
    `;
    const out = extractSchemasFromSource(src, new Set(["X"]));
    expect(out.size).toBe(0);
  });

  it("skips `.emits()` with no argument or a non-object literal", () => {
    expect(extractSchemasFromSource(".emits()", new Set(["X"])).size).toBe(0);
    expect(
      extractSchemasFromSource('.emits("nope")', new Set(["X"])).size
    ).toBe(0);
  });
});
