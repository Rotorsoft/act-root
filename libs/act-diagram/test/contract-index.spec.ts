import { describe, expect, it } from "vitest";
import {
  buildContractIndex,
  CATEGORY_KEYWORDS,
  decomposeEventName,
  eventStatus,
  listByKind,
  search,
} from "../src/cli/contract-index.js";
import type { DomainModel } from "../src/client/types/index.js";

const model: DomainModel = {
  entries: [],
  states: [
    {
      name: "Order",
      varName: "Order:0",
      file: "src/order.ts",
      line: 1,
      events: [
        {
          name: "OrderPlaced",
          hasCustomPatch: true,
          line: 12,
          schema: "z.object({})",
        },
        { name: "OrderPlaced_v2", hasCustomPatch: false, line: 14 },
        { name: "OrderShipped", hasCustomPatch: false, line: 16 },
      ],
      actions: [
        {
          name: "placeOrder",
          emits: ["OrderPlaced_v2"],
          invariants: [],
          line: 30,
        },
        {
          name: "shipOrder",
          emits: ["OrderShipped"],
          invariants: ["paid"],
          line: 40,
        },
      ],
    },
  ],
  slices: [
    {
      name: "Fulfillment",
      states: ["Order:0"],
      stateVars: ["Order:0"],
      projections: [],
      file: "src/fulfillment.ts",
      line: 5,
      reactions: [
        {
          event: "OrderPlaced_v2",
          handlerName: "reserveStock",
          dispatches: ["reserve"],
          line: 18,
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
      event: "OrderShipped",
      handlerName: "notifyShipped",
      dispatches: [],
    },
  ],
};

describe("decomposeEventName", () => {
  it("treats bare names as version 1", () => {
    expect(decomposeEventName("Foo")).toEqual({ base: "Foo", version: 1 });
  });
  it("decomposes _v<digits> suffix", () => {
    expect(decomposeEventName("Foo_v3")).toEqual({ base: "Foo", version: 3 });
  });
  it("ignores _v without digits", () => {
    expect(decomposeEventName("Foo_vNext")).toEqual({
      base: "Foo_vNext",
      version: 1,
    });
  });
});

describe("eventStatus", () => {
  const all = new Set(["Foo", "Foo_v2", "Foo_v3", "Bar"]);
  it("marks the latest version active", () => {
    expect(eventStatus("Foo_v3", all)).toEqual({ status: "active" });
  });
  it("marks earlier versions deprecated and points to the latest", () => {
    expect(eventStatus("Foo", all)).toEqual({
      status: "deprecated",
      supersededBy: "Foo_v3",
    });
    expect(eventStatus("Foo_v2", all)).toEqual({
      status: "deprecated",
      supersededBy: "Foo_v3",
    });
  });
  it("marks an isolated bare name active", () => {
    expect(eventStatus("Bar", all)).toEqual({ status: "active" });
  });
});

describe("buildContractIndex", () => {
  const idx = buildContractIndex(model);

  it("collects entries for every kind", () => {
    const kinds = new Set(idx.entries.map((e) => e.kind));
    expect(kinds).toEqual(
      new Set(["state", "event", "action", "slice", "reaction", "projection"])
    );
  });

  it("collects every event name into allEventNames", () => {
    expect(idx.allEventNames).toEqual(
      new Set(["OrderPlaced", "OrderPlaced_v2", "OrderShipped"])
    );
  });

  it("attaches qualifiers and file:line metadata", () => {
    const action = idx.entries.find((e) => e.kind === "action");
    expect(action?.qualifier).toBe("Order");
    expect(action?.file).toBe("src/order.ts");
    expect(action?.line).toBe(30);
  });

  it("handles empty models without crashing", () => {
    const empty = buildContractIndex({
      entries: [],
      states: [],
      slices: [],
      projections: [],
      reactions: [],
    });
    expect(empty.entries).toHaveLength(0);
    expect(empty.allEventNames.size).toBe(0);
  });
});

describe("search", () => {
  const idx = buildContractIndex(model);

  it("returns empty for empty query", () => {
    expect(search(idx, "")).toEqual([]);
    expect(search(idx, "   ")).toEqual([]);
  });

  it("matches case-insensitively", () => {
    const results = search(idx, "order");
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.name.toLowerCase().includes("order"))).toBe(
      true
    );
  });

  it("ranks exact > prefix > substring", () => {
    const results = search(idx, "OrderPlaced");
    expect(results[0].name).toBe("OrderPlaced");
    expect(results[1].name).toBe("OrderPlaced_v2");
  });

  it("returns no matches for missing names", () => {
    expect(search(idx, "noSuchThing")).toEqual([]);
  });

  it("respects the limit argument", () => {
    const results = search(idx, "o", 2);
    expect(results).toHaveLength(2);
  });
});

describe("listByKind", () => {
  const idx = buildContractIndex(model);

  it("returns entries of the requested kind, sorted by name", () => {
    const events = listByKind(idx, "event");
    expect(events.map((e) => e.name)).toEqual([
      "OrderPlaced",
      "OrderPlaced_v2",
      "OrderShipped",
    ]);
    expect(listByKind(idx, "slice").map((e) => e.name)).toEqual([
      "Fulfillment",
    ]);
  });

  it("returns an empty array for kinds with no entries", () => {
    const empty = buildContractIndex({
      entries: [],
      states: [],
      slices: [],
      projections: [],
      reactions: [],
    });
    expect(listByKind(empty, "projection")).toEqual([]);
  });
});

describe("CATEGORY_KEYWORDS", () => {
  it("maps singular and plural forms to a Kind", () => {
    expect(CATEGORY_KEYWORDS.event).toBe("event");
    expect(CATEGORY_KEYWORDS.events).toBe("event");
    expect(CATEGORY_KEYWORDS.slice).toBe("slice");
    expect(CATEGORY_KEYWORDS.slices).toBe("slice");
  });
});
