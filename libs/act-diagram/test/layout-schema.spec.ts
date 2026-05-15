import { describe, expect, it } from "vitest";
import { computeLayout } from "../src/client/lib/layout.js";
import type { DomainModel } from "../src/client/types/domain-model.js";

/**
 * Coverage for the eventSchemas plumbing added in ACT-402: layout must
 * forward each event node's captured Zod text so the diagram tooltip
 * surface can render it.
 */
describe("computeLayout — schema propagation", () => {
  it("attaches captured schemas to event nodes", () => {
    const model: DomainModel = {
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
              schema: "z.object({ id: z.string() })",
            },
            { name: "OrderShipped", hasCustomPatch: false },
          ],
          actions: [
            {
              name: "placeOrder",
              emits: ["OrderPlaced", "OrderShipped"],
              invariants: [],
            },
          ],
        },
      ],
      slices: [],
      projections: [],
      reactions: [],
    };
    const layout = computeLayout(model);
    const placed = layout.ns.find(
      (n) => n.type === "event" && n.label === "OrderPlaced"
    );
    const unplaced = layout.ns.find(
      (n) => n.type === "event" && n.label === "OrderShipped"
    );
    expect(placed?.schema).toBe("z.object({ id: z.string() })");
    expect(unplaced?.schema).toBeUndefined();
  });

  it("keeps the first-seen schema when the same event is declared twice", () => {
    const model: DomainModel = {
      entries: [],
      states: [
        {
          name: "A",
          varName: "A:0",
          events: [{ name: "Shared", hasCustomPatch: false, schema: "first" }],
          actions: [],
        },
        {
          name: "B",
          varName: "B:1",
          events: [{ name: "Shared", hasCustomPatch: false, schema: "second" }],
          actions: [],
        },
      ],
      slices: [],
      projections: [],
      reactions: [],
    };
    const layout = computeLayout(model);
    const nodes = layout.ns.filter(
      (n) => n.type === "event" && n.label === "Shared"
    );
    // The de-dup map keeps the first schema text; every event node for
    // "Shared" should resolve to it.
    expect(nodes.every((n) => n.schema === "first")).toBe(true);
  });
});
