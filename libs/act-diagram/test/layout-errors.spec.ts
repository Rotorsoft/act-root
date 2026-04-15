import { describe, expect, it } from "vitest";
import {
  computeLayout,
  H,
  type Layout,
  type N,
} from "../src/client/lib/layout.js";
import type { DomainModel } from "../src/client/types/domain-model.js";

// -- Helpers ------------------------------------------------------------------

function emptyModel(overrides?: Partial<DomainModel>): DomainModel {
  return {
    entries: [],
    states: [],
    slices: [],
    projections: [],
    reactions: [],
    ...overrides,
  };
}

function find(layout: Layout, type: N["type"], label: string) {
  return layout.ns.find((n) => n.type === type && n.label === label);
}

// -- Tests --------------------------------------------------------------------

describe("error slice box", () => {
  it("creates a box with error field for a slice with error and empty states", () => {
    const model = emptyModel({
      slices: [
        {
          name: "BrokenSlice",
          states: [],
          stateVars: [],
          projections: [],
          reactions: [],
          error: "Failed to build this slice due to syntax error",
        },
      ],
    });
    const layout = computeLayout(model);
    expect(layout.boxes).toHaveLength(1);
    expect(layout.boxes[0].label).toBe("BrokenSlice");
    expect(layout.boxes[0].error).toBe(
      "Failed to build this slice due to syntax error"
    );
    expect(layout.boxes[0].w).toBeGreaterThanOrEqual(300);
    expect(layout.boxes[0].h).toBeGreaterThan(0);
    expect(layout.ns).toHaveLength(0);
  });

  it("error slice followed by normal slice stacks vertically", () => {
    const model = emptyModel({
      states: [
        {
          name: "S",
          varName: "S",
          events: [{ name: "Evt", hasCustomPatch: false }],
          actions: [{ name: "a", emits: ["Evt"], invariants: [] }],
        },
      ],
      slices: [
        {
          name: "ErrorFirst",
          states: [],
          stateVars: [],
          projections: [],
          reactions: [],
          error: "broken",
        },
        {
          name: "GoodSlice",
          states: ["S"],
          stateVars: ["S"],
          projections: [],
          reactions: [],
        },
      ],
    });
    const layout = computeLayout(model);
    expect(layout.boxes).toHaveLength(2);
    expect(layout.boxes[0].error).toBe("broken");
    expect(layout.boxes[1].y).toBeGreaterThan(layout.boxes[0].y);
  });
});

describe("projection nodes below events", () => {
  it("places projection nodes below the events column", () => {
    const model = emptyModel({
      states: [
        {
          name: "Ticket",
          varName: "Ticket",
          events: [
            { name: "TicketOpened", hasCustomPatch: false },
            { name: "TicketClosed", hasCustomPatch: false },
          ],
          actions: [
            {
              name: "OpenTicket",
              emits: ["TicketOpened"],
              invariants: [],
            },
            {
              name: "CloseTicket",
              emits: ["TicketClosed"],
              invariants: [],
            },
          ],
        },
      ],
      slices: [
        {
          name: "TicketSlice",
          states: ["Ticket"],
          stateVars: ["Ticket"],
          projections: ["tickets"],
          reactions: [],
        },
      ],
      projections: [
        {
          name: "tickets",
          varName: "tickets",
          handles: ["TicketOpened"],
        },
      ],
    });
    const layout = computeLayout(model);
    const projNode = layout.ns.find((n) => n.type === "projection");
    expect(projNode).toBeDefined();
    expect(projNode!.label).toBe("tickets");

    const eventNodes = layout.ns.filter((n) => n.type === "event");
    expect(eventNodes.length).toBeGreaterThan(0);
    const maxEventBottom = Math.max(...eventNodes.map((n) => n.pos.y + H));
    expect(projNode!.pos.y).toBeGreaterThanOrEqual(maxEventBottom);
  });

  it("places multiple projections when events map to different projections", () => {
    const model = emptyModel({
      states: [
        {
          name: "S",
          varName: "S",
          events: [
            { name: "E1", hasCustomPatch: false },
            { name: "E2", hasCustomPatch: false },
          ],
          actions: [
            { name: "a1", emits: ["E1"], invariants: [] },
            { name: "a2", emits: ["E2"], invariants: [] },
          ],
        },
      ],
      slices: [
        {
          name: "Sl",
          states: ["S"],
          stateVars: ["S"],
          projections: ["projA", "projB"],
          reactions: [],
        },
      ],
      projections: [
        { name: "projA", varName: "projA", handles: ["E1"] },
        { name: "projB", varName: "projB", handles: ["E2"] },
      ],
    });
    const layout = computeLayout(model);
    const projNodes = layout.ns.filter((n) => n.type === "projection");
    expect(projNodes).toHaveLength(2);
    expect(projNodes.map((n) => n.label).sort()).toEqual(["projA", "projB"]);
  });
});

describe("projection and reaction metadata on event nodes", () => {
  it("attaches projection names to event nodes", () => {
    const model = emptyModel({
      states: [
        {
          name: "S",
          varName: "S",
          events: [{ name: "Evt", hasCustomPatch: false }],
          actions: [{ name: "doIt", emits: ["Evt"], invariants: [] }],
        },
      ],
      projections: [{ name: "myProj", varName: "myProj", handles: ["Evt"] }],
    });
    const layout = computeLayout(model);
    const evt = find(layout, "event", "Evt")!;
    expect(evt.projections).toEqual(["myProj"]);
  });

  it("attaches reaction handler names to event nodes", () => {
    const model = emptyModel({
      states: [
        {
          name: "S",
          varName: "S",
          events: [{ name: "Evt", hasCustomPatch: false }],
          actions: [{ name: "doIt", emits: ["Evt"], invariants: [] }],
        },
      ],
      reactions: [
        {
          event: "Evt",
          handlerName: "onEvt",
          dispatches: [],
        },
      ],
    });
    const layout = computeLayout(model);
    const evt = find(layout, "event", "Evt")!;
    expect(evt.reactions).toEqual(["onEvt"]);
  });
});
