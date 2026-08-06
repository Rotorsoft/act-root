import { describe, expect, it } from "vitest";
import {
  build_contract_index,
  CATEGORY_KEYWORDS,
  decompose_event_name,
  event_names_for,
  event_status,
  list_by_kind,
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

describe("decompose_event_name", () => {
  it("treats bare names as version 1", () => {
    expect(decompose_event_name("Foo")).toEqual({ base: "Foo", version: 1 });
  });
  it("decomposes _v<digits> suffix", () => {
    expect(decompose_event_name("Foo_v3")).toEqual({ base: "Foo", version: 3 });
  });
  // #1395 — the framework requires v >= 2 (`event-versions.ts`): the base
  // `Foo` is implicitly v1, so `Foo_v1` is a literal event name. Stripping
  // it made the CLI call a current, emittable event deprecated.
  it("treats _v1 as a literal name, not a version", () => {
    expect(decompose_event_name("Foo_v1")).toEqual({
      base: "Foo_v1",
      version: 1,
    });
  });
  it("ignores _v without digits", () => {
    expect(decompose_event_name("Foo_vNext")).toEqual({
      base: "Foo_vNext",
      version: 1,
    });
  });
});

describe("event_status", () => {
  const all = new Set(["Foo", "Foo_v2", "Foo_v3", "Bar"]);
  it("marks the latest version active", () => {
    expect(event_status("Foo_v3", all)).toEqual({ status: "active" });
  });
  it("marks earlier versions deprecated and points to the latest", () => {
    expect(event_status("Foo", all)).toEqual({
      status: "deprecated",
      superseded_by: "Foo_v3",
    });
    expect(event_status("Foo_v2", all)).toEqual({
      status: "deprecated",
      superseded_by: "Foo_v3",
    });
  });
  it("marks an isolated bare name active", () => {
    expect(event_status("Bar", all)).toEqual({ status: "active" });
  });
  it("does not deprecate _v1 in favour of _v2 (#1395)", () => {
    // To the framework these are two unrelated base names, both current;
    // a static .emit("Shipped_v1") is legal and the app builds.
    const names = new Set(["Shipped_v1", "Shipped_v2"]);
    expect(event_status("Shipped_v1", names)).toEqual({ status: "active" });
    expect(event_status("Shipped_v2", names)).toEqual({ status: "active" });
  });
});

describe("build_contract_index", () => {
  const idx = build_contract_index(model);

  it("collects entries for every kind", () => {
    const kinds = new Set(idx.entries.map((e) => e.kind));
    expect(kinds).toEqual(
      new Set(["state", "event", "action", "slice", "reaction", "projection"])
    );
  });

  it("collects every event name into all_event_names", () => {
    expect(idx.all_event_names).toEqual(
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
    const empty = build_contract_index({
      entries: [],
      states: [],
      slices: [],
      projections: [],
      reactions: [],
    });
    expect(empty.entries).toHaveLength(0);
    expect(empty.all_event_names.size).toBe(0);
  });
});

describe("search", () => {
  const idx = build_contract_index(model);

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

describe("list_by_kind", () => {
  const idx = build_contract_index(model);

  it("returns entries of the requested kind, sorted by name", () => {
    const events = list_by_kind(idx, "event");
    expect(events.map((e) => e.name)).toEqual([
      "OrderPlaced",
      "OrderPlaced_v2",
      "OrderShipped",
    ]);
    expect(list_by_kind(idx, "slice").map((e) => e.name)).toEqual([
      "Fulfillment",
    ]);
  });

  it("returns an empty array for kinds with no entries", () => {
    const empty = build_contract_index({
      entries: [],
      states: [],
      slices: [],
      projections: [],
      reactions: [],
    });
    expect(list_by_kind(empty, "projection")).toEqual([]);
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

// #1393 — the CLI twin of #1310. Event names are per-state-namespaced, so
// two unrelated states may legally share a base name (`register_new_state`
// only rejects identical names across differently-named states). Pooling
// them into one global set reported one state's current event as
// superseded by an unrelated state's.
describe("per-state deprecation scoping (#1393)", () => {
  const model: DomainModel = {
    entries: [],
    states: [
      {
        name: "AStar",
        varName: "AStar:0",
        file: "src/a.ts",
        events: [{ name: "Approved", hasCustomPatch: false }],
        actions: [],
      },
      {
        name: "BStar",
        varName: "BStar:0",
        file: "src/b.ts",
        events: [{ name: "Approved_v2", hasCustomPatch: false }],
        actions: [],
      },
    ],
    slices: [],
    projections: [],
    reactions: [],
  };

  it("keeps each state's events in their own namespace", () => {
    const idx = build_contract_index(model);
    expect([...event_names_for(idx, "AStar")]).toEqual(["Approved"]);
    expect([...event_names_for(idx, "BStar")]).toEqual(["Approved_v2"]);
    // Both remain active — neither supersedes the other.
    expect(event_status("Approved", event_names_for(idx, "AStar"))).toEqual({
      status: "active",
    });
  });

  it("falls back to the global set for an event with no owning state", () => {
    const idx = build_contract_index(model);
    expect(event_names_for(idx, undefined)).toBe(idx.all_event_names);
    expect(event_names_for(idx, "Unknown")).toBe(idx.all_event_names);
  });

  it("unions same-name partials into one state's event set", () => {
    const idx = build_contract_index({
      ...model,
      states: [
        {
          name: "Split",
          varName: "Split:0",
          file: "src/x.ts",
          events: [{ name: "One", hasCustomPatch: false }],
          actions: [],
        },
        {
          name: "Split",
          varName: "Split:1",
          file: "src/y.ts",
          events: [{ name: "Two", hasCustomPatch: false }],
          actions: [],
        },
      ],
    });
    expect([...event_names_for(idx, "Split")].sort()).toEqual(["One", "Two"]);
  });
});
