import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildContractIndex } from "../src/cli/contract-index.js";
import { formatJsonSchema, toJsonSchemaSafe } from "../src/cli/json-schema.js";
import type { DomainModel } from "../src/client/types/index.js";

const OrderPlacedSchema = z.object({
  orderId: z.string(),
  total: z.number(),
});
const OrderPlacedV2Schema = z.object({
  orderId: z.string(),
  total: z.number(),
  currency: z.string(),
});

function modelWithRealSchemas(): DomainModel {
  return {
    entries: [],
    states: [
      {
        name: "Order",
        varName: "Order:0",
        file: "src/order.ts",
        events: [
          {
            name: "OrderPlaced",
            hasCustomPatch: false,
            schema: "z.object({ orderId: z.string(), total: z.number() })",
            zod: OrderPlacedSchema,
          },
          {
            name: "OrderPlaced_v2",
            hasCustomPatch: false,
            schema: "...",
            zod: OrderPlacedV2Schema,
          },
        ],
        actions: [{ name: "place", emits: ["OrderPlaced_v2"], invariants: [] }],
      },
    ],
    slices: [
      {
        name: "Fulfillment",
        states: ["Order:0"],
        stateVars: ["Order:0"],
        projections: ["OrdersByCustomer"],
        file: "src/f.ts",
        reactions: [
          {
            event: "OrderPlaced_v2",
            handlerName: "reserveStock",
            dispatches: ["reserve"],
          },
        ],
      },
    ],
    projections: [
      {
        name: "OrdersByCustomer",
        varName: "OrdersByCustomer",
        handles: ["OrderPlaced_v2"],
      },
    ],
    reactions: [
      {
        event: "OrderPlaced",
        handlerName: "audit",
        dispatches: [],
      },
    ],
  };
}

describe("toJsonSchemaSafe", () => {
  it("converts a real zod schema to JSON Schema", () => {
    const result = toJsonSchemaSafe(z.object({ id: z.string() }));
    if ("error" in result) throw new Error("expected success");
    expect(result.schema).toMatchObject({
      type: "object",
      properties: { id: { type: "string" } },
    });
  });

  it("returns an error when given undefined", () => {
    const result = toJsonSchemaSafe(undefined);
    expect(result).toEqual({ error: "no zod schema captured" });
  });

  it("returns an error when given a primitive", () => {
    const result = toJsonSchemaSafe("not a schema");
    expect(result).toEqual({ error: "no zod schema captured" });
  });

  it("returns an error when conversion throws", () => {
    // A plain object isn't a Zod schema; z.toJSONSchema rejects it.
    const result = toJsonSchemaSafe({ not: "a zod" });
    expect("error" in result).toBe(true);
  });
});

describe("formatJsonSchema", () => {
  const idx = buildContractIndex(modelWithRealSchemas());
  const text = formatJsonSchema(idx);
  const parsed = JSON.parse(text);

  it("emits valid JSON with metadata header", () => {
    expect(parsed.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(parsed.generator).toBe("act-diagram/act-contracts");
    expect(typeof parsed.generatedAt).toBe("string");
    expect(parsed.counts).toEqual({
      states: 1,
      slices: 1,
      projections: 1,
      events: 2,
    });
  });

  it("converts each event's Zod schema to JSON Schema", () => {
    expect(parsed.events.OrderPlaced.schema).toMatchObject({
      type: "object",
      properties: {
        orderId: { type: "string" },
        total: { type: "number" },
      },
    });
    expect(parsed.events.OrderPlaced_v2.schema.properties).toHaveProperty(
      "currency"
    );
  });

  it("includes deprecation status with supersededBy", () => {
    expect(parsed.events.OrderPlaced.status).toBe("deprecated");
    expect(parsed.events.OrderPlaced.supersededBy).toBe("OrderPlaced_v2");
    expect(parsed.events.OrderPlaced_v2.status).toBe("active");
  });

  it("includes producers and consumers per event", () => {
    expect(parsed.events.OrderPlaced_v2.producers).toEqual([
      expect.objectContaining({ action: "place", state: "Order" }),
    ]);
    const consumers = parsed.events.OrderPlaced_v2.consumers;
    expect(consumers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "reaction",
          slice: "Fulfillment",
          handler: "reserveStock",
        }),
        expect.objectContaining({
          type: "projection",
          name: "OrdersByCustomer",
        }),
      ])
    );
  });

  it("includes the orchestrator-level reaction as a consumer", () => {
    const consumers = parsed.events.OrderPlaced.consumers;
    expect(consumers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "reaction", handler: "audit" }),
      ])
    );
  });

  it("falls back to schemaError when conversion fails", () => {
    const model: DomainModel = {
      entries: [],
      states: [
        {
          name: "S",
          varName: "S:0",
          events: [
            {
              name: "Broken",
              hasCustomPatch: false,
              zod: { not: "a real zod schema" } as unknown,
            },
          ],
          actions: [],
        },
      ],
      slices: [],
      projections: [],
      reactions: [],
    };
    const idx2 = buildContractIndex(model);
    const out = JSON.parse(formatJsonSchema(idx2));
    expect(out.events.Broken.schemaError).toBeDefined();
    expect(out.events.Broken.schema).toBeUndefined();
  });
});
