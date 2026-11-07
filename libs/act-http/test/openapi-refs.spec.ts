import { act, sensitive, state } from "@rotorsoft/act";
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

describe("openapi on unusual schemas", () => {
  const request_of = (doc: ReturnType<typeof document_of>) =>
    Object.values<any>(doc.paths)[0].post.requestBody.content[
      "application/json"
    ].schema;

  it("marks a sensitive field on a recursive action", () => {
    const R: z.ZodObject = z.object({
      get kids() {
        return z.array(R);
      },
      ssn: sensitive(z.string()),
    });
    const doc = document_of(R);
    expect(dangling(doc)).toEqual([]);
    const moved = Object.values<any>(doc.components.schemas).find(
      (schema) => schema.properties?.ssn
    );
    expect(moved.properties.ssn.writeOnly).toBe(true);
  });

  it("resolves a .meta id with a slash or a tilde", () => {
    for (const id of ["a/b", "a~b"]) {
      const shared = z.object({ x: z.number() }).meta({ id });
      const doc = document_of(z.object({ one: shared, two: shared }));
      expect(dangling(doc)).toEqual([]);
      expect(JSON.stringify(request_of(doc))).not.toContain("$defs");
    }
  });

  it("gives every .meta id a legal component name", () => {
    const shared = z.object({ x: z.number() }).meta({ id: "My Type#1" });
    const doc = document_of(z.object({ one: shared, two: shared }));
    expect(dangling(doc)).toEqual([]);
    for (const name of Object.keys(doc.components.schemas))
      expect(name).toMatch(/^[a-zA-Z0-9._-]+$/);
  });

  it("leaves a field named $defs as a field", () => {
    const doc = document_of(
      z.object({ $defs: z.object({ q: z.string() }), other: z.string() })
    );
    expect(Object.keys(request_of(doc).properties)).toContain("$defs");
  });
});
