import { describe, expect, it } from "vitest";
import { z } from "zod";
import { extract_model } from "../src/client/lib/evaluate.js";
import { schema_rules, schema_text } from "../src/client/lib/schema-text.js";

describe("schema_text", () => {
  it("prints an object's fields one per line, with the constraints", () => {
    const text = schema_text(
      z.object({
        id: z.uuid(),
        status: z.enum(["open", "closed"]),
        kind: z.literal("ticket"),
        closedBy: z.string().optional(),
        armies: z.number().int().min(1),
        count: z.number().int(),
        ratio: z.number().gt(0).lt(1),
        score: z.number().min(-5).max(5),
        title: z.string().min(1).max(80),
        code: z.string().length(3),
        tags: z
          .array(z.enum(["a", "b"]))
          .min(1)
          .max(3),
        exact: z.array(z.string()).length(2),
        pair: z.tuple([z.string(), z.number()]),
        due: z.date(),
        note: z.string().nullable(),
        anything: z.any(),
        owner: z.union([z.string(), z.number()]),
        bag: z.record(z.string(), z.number()),
        loose: z.record(z.string(), z.any()),
        nested: z.object({ a: z.boolean() }),
        optionals: z.object({ b: z.boolean().optional() }),
        empty: z.object({}),
      })
    );
    expect(text).toBe(
      [
        "id: uuid",
        'status: "open" | "closed"',
        'kind: "ticket"',
        "closedBy?: string",
        "armies: integer ≥ 1",
        "count: integer",
        "ratio: number > 0, < 1",
        "score: number ≥ -5, ≤ 5",
        "title: string ≥ 1 chars, ≤ 80 chars",
        "code: string 3 chars",
        'tags: ("a" | "b")[] ≥ 1 items, ≤ 3 items',
        "exact: string[] 2 items",
        "pair: [string, number]",
        "due: date",
        "note: string | null",
        "anything: unknown",
        "owner: string | number",
        "bag: Record<string, number>",
        "loose: Record<string, unknown>",
        "nested: {",
        "  a: boolean",
        "}",
        "optionals: {",
        "  b?: boolean",
        "}",
        "empty: {}",
      ].join("\n")
    );
  });

  it("prints an intersection of objects as one object", () => {
    const Fields = z.object({ title: z.string() });
    expect(schema_text(Fields.and(z.object({ userId: z.uuid() })))).toBe(
      "title: string\nuserId: uuid"
    );
  });

  it("joins an intersection that isn't all objects with &", () => {
    expect(schema_text(z.string().and(z.string().min(1)))).toBe(
      "string & string ≥ 1 chars"
    );
  });

  it("prints a schema that isn't an object as one type", () => {
    expect(
      schema_text(
        z.discriminatedUnion("k", [
          z.object({ k: z.literal("a") }),
          z.object({ k: z.literal("b") }),
        ])
      )
    ).toBe('{\n  k: "a"\n} | {\n  k: "b"\n}');
  });

  it("merges the partial states that share a name, the first one winning a field", () => {
    const text = schema_text([
      z.object({ title: z.string(), shared: z.string() }),
      z.object({ shared: z.number(), agentId: z.uuid().optional() }),
    ]);
    expect(text).toBe("title: string\nshared: string\nagentId?: uuid");
  });

  it("prints an object without fields as {}", () => {
    expect(schema_text(z.object({}))).toBe("{}");
    expect(schema_text([z.object({}), z.record(z.string(), z.number())])).toBe(
      "{}"
    );
  });

  it("merges partials whose fields are all optional", () => {
    expect(schema_text([z.object({ a: z.string().optional() })])).toBe(
      "a?: string"
    );
  });

  it("is undefined when nothing can be read", () => {
    expect(schema_text(undefined)).toBeUndefined();
    expect(schema_text([])).toBeUndefined();
    expect(schema_text({})).toBeUndefined();
  });
});

describe("schema_rules", () => {
  it("lists refinement messages in order, nested ones included, once each", () => {
    const Item = z.object({ n: z.number() }).refine(() => true, "item rule");
    const State = z
      .object({
        status: z.enum(["open", "closed"]),
        closedBy: z.string().min(1).optional(),
        items: z.array(Item),
        byId: z.record(z.string(), Item),
        either: z.union([z.string(), Item]),
        both: z.object({}).and(z.object({}).refine(() => true, "right rule")),
      })
      .refine(
        (t) => t.status !== "closed" || !!t.closedBy,
        "A closed ticket has a closer"
      )
      .refine(() => true, { message: "second rule" })
      .superRefine(() => {});
    expect(schema_rules(State)).toEqual([
      "A closed ticket has a closer",
      "second rule",
      "item rule",
      "right rule",
    ]);
  });

  it("merges the rules of several schemas", () => {
    const a = z.object({}).refine(() => true, "a");
    const b = z.object({}).refine(() => true, "b");
    expect(schema_rules([a, b, a])).toEqual(["a", "b"]);
  });

  it("is empty for a schema without refinements or no schema", () => {
    expect(schema_rules(z.object({ n: z.number() }))).toEqual([]);
    expect(schema_rules(undefined)).toEqual([]);
  });
});

describe("the model carries the runtime schemas", () => {
  it("of a state and its actions", () => {
    const { model, error } = extract_model([
      {
        path: "src/ticket.ts",
        content: `
import { state } from "@rotorsoft/act";
import { z } from "zod";

export const Ticket = state({
  Ticket: z
    .object({ status: z.string(), closedBy: z.string().optional() })
    .refine((t) => t.status !== "closed" || !!t.closedBy, "A closed ticket has a closer"),
})
  .init(() => ({ status: "open" }))
  .emits({ Closed: z.object({ by: z.string() }) })
  .on({ Close: z.object({ by: z.string().min(1) }) })
    .emit((data) => ["Closed", data])
  .build();
`,
      },
    ]);
    expect(error).toBeUndefined();
    const st = model.states[0];
    expect(schema_text(st.zod)).toBe("status: string\nclosedBy?: string");
    expect(schema_rules(st.zod)).toEqual(["A closed ticket has a closer"]);
    expect(schema_text(st.actions[0].zod)).toBe("by: string ≥ 1 chars");
  });
});
