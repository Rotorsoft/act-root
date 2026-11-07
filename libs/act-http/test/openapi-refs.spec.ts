import { act, state } from "@rotorsoft/act";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { openapi } from "../src/openapi/index.js";

const document_of = (schema: z.ZodObject) => {
  const S = state({ S: z.object({}) })
    .init(() => ({}))
    .emits({ E: z.object({}) })
    .on({ A: schema })
    .emit(() => ["E", {}])
    .build();
  return openapi(act().withState(S).build(), {
    info: { title: "t", version: "1" },
  });
};

const dangling = (doc: unknown) => {
  const bad: string[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") {
        let at: unknown = doc;
        for (const part of value
          .replace(/^#\/?/, "")
          .split("/")
          .filter(Boolean))
          at = (at as Record<string, unknown> | undefined)?.[part];
        if (at === undefined || value === "#") bad.push(value);
      } else walk(value);
    }
  };
  walk(doc);
  return bad;
};

describe("generated OpenAPI refs", () => {
  it("resolves every ref", () => {
    const Node: z.ZodType = z.lazy(() => z.object({ kids: z.array(Node) }));
    const Root: z.ZodObject = z.object({
      get kids() {
        return z.array(Root);
      },
    });
    const Shared = z.object({ x: z.number() }).meta({ id: "Shared" });
    for (const schema of [
      z.object({ root: Node }),
      z.object({ a: Node, b: Node }),
      z.object({ one: Shared, two: Shared }),
      Root,
    ])
      expect(dangling(document_of(schema))).toEqual([]);
  });

  it("keeps two schemas' definitions apart", () => {
    const Tree: z.ZodType = z.lazy(() => z.object({ kids: z.array(Tree) }));
    const List: z.ZodType = z.lazy(() =>
      z.object({ next: List.optional(), v: z.string() })
    );
    const S = state({ S: z.object({}) })
      .init(() => ({}))
      .emits({ E: z.object({}) })
      .on({ A: z.object({ t: Tree }) })
      .emit(() => ["E", {}])
      .on({ B: z.object({ l: List }) })
      .emit(() => ["E", {}])
      .build();
    const doc = openapi(act().withState(S).build(), {
      info: { title: "t", version: "1" },
    });
    expect(dangling(doc)).toEqual([]);
    expect(Object.keys(doc.components.schemas).length).toBeGreaterThan(3);
  });
});
