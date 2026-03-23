import { describe, expect, it } from "vitest";
import {
  computeLayout,
  W,
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

describe("state with no actions (edge case)", () => {
  it("still places a state node", () => {
    const model = emptyModel({
      states: [
        {
          name: "Empty",
          varName: "Empty",
          events: [],
          actions: [],
        },
      ],
    });
    const layout = computeLayout(model);
    const state = find(layout, "state", "Empty");
    expect(state).toBeDefined();
  });
});

describe("standalone reaction edges", () => {
  it("creates edge from trigger event to standalone reaction when event exists", () => {
    const model = emptyModel({
      states: [
        {
          name: "S",
          varName: "S",
          events: [{ name: "Evt", hasCustomPatch: false }],
          actions: [{ name: "a", emits: ["Evt"], invariants: [] }],
        },
      ],
      reactions: [
        {
          event: "Evt",
          handlerName: "onEvt",
          dispatches: [],
          isVoid: false,
        },
      ],
    });
    const layout = computeLayout(model);
    const reaction = find(layout, "reaction", "onEvt");
    expect(reaction).toBeDefined();
    const dashedEdges = layout.es.filter((e) => e.dash);
    expect(dashedEdges.length).toBeGreaterThanOrEqual(1);
    const evt = find(layout, "event", "Evt")!;
    const edge = dashedEdges.find(
      (e) => e.from.x === evt.pos.x + W && e.to.x === reaction!.pos.x
    );
    expect(edge).toBeDefined();
  });
});

describe("void standalone reactions", () => {
  it("skips void reactions in standalone reactions", () => {
    const model = emptyModel({
      states: [
        {
          name: "S",
          varName: "S",
          events: [{ name: "Evt", hasCustomPatch: false }],
          actions: [{ name: "a", emits: ["Evt"], invariants: [] }],
        },
      ],
      reactions: [
        {
          event: "Evt",
          handlerName: "voidReaction",
          dispatches: [],
          isVoid: true,
        },
        {
          event: "Evt",
          handlerName: "realReaction",
          dispatches: [],
          isVoid: false,
        },
      ],
    });
    const layout = computeLayout(model);
    const voidNode = find(layout, "reaction", "voidReaction");
    expect(voidNode).toBeUndefined();
    const realNode = find(layout, "reaction", "realReaction");
    expect(realNode).toBeDefined();
  });
});

describe("standalone action->event edge when ey not found", () => {
  it("skips edge when event Y position not found", () => {
    const model = emptyModel({
      states: [
        {
          name: "S",
          varName: "S",
          events: [{ name: "Known", hasCustomPatch: false }],
          actions: [
            {
              name: "a",
              emits: ["Known", "Unknown"], // Unknown not in events -> not in eventYMap
              invariants: [],
            },
          ],
        },
      ],
    });
    const layout = computeLayout(model);
    const action = find(layout, "action", "a");
    expect(action).toBeDefined();
  });
});

describe("standalone reaction without trigNode", () => {
  it("places standalone reaction when trigger event not found", () => {
    const model = emptyModel({
      states: [
        {
          name: "S",
          varName: "S",
          events: [{ name: "Evt", hasCustomPatch: false }],
          actions: [{ name: "a", emits: ["Evt"], invariants: [] }],
        },
      ],
      reactions: [
        {
          event: "NoSuchEvent", // event not in any state
          handlerName: "orphanReaction",
          dispatches: [],
          isVoid: false,
        },
      ],
    });
    const layout = computeLayout(model);
    const reaction = find(layout, "reaction", "orphanReaction");
    expect(reaction).toBeDefined();
  });
});

describe("standalone reactions with multiple events stacking", () => {
  it("stacks multiple standalone reactions on same event vertically", () => {
    const model = emptyModel({
      states: [
        {
          name: "S",
          varName: "S",
          events: [{ name: "Evt", hasCustomPatch: false }],
          actions: [{ name: "a", emits: ["Evt"], invariants: [] }],
        },
      ],
      reactions: [
        {
          event: "Evt",
          handlerName: "r1",
          dispatches: [],
          isVoid: false,
        },
        {
          event: "Evt",
          handlerName: "r2",
          dispatches: [],
          isVoid: false,
        },
      ],
    });
    const layout = computeLayout(model);
    const r1 = find(layout, "reaction", "r1")!;
    const r2 = find(layout, "reaction", "r2")!;
    expect(r1).toBeDefined();
    expect(r2).toBeDefined();
    expect(r2.pos.y).toBeGreaterThan(r1.pos.y);
  });
});

describe("guarded standalone action", () => {
  it("annotates standalone action with guards", () => {
    const model = emptyModel({
      states: [
        {
          name: "S",
          varName: "S",
          events: [{ name: "Evt", hasCustomPatch: false }],
          actions: [
            {
              name: "guardedAction",
              emits: ["Evt"],
              invariants: ["must be active"],
            },
          ],
        },
      ],
    });
    const layout = computeLayout(model);
    const action = find(layout, "action", "guardedAction");
    expect(action).toBeDefined();
    expect(action!.sub).toBe("guarded");
    expect(action!.guards).toEqual(["must be active"]);
  });
});

describe("orphan events in standalone states", () => {
  it("places events declared in .emits() but not emitted by any action in standalone states", () => {
    const model = emptyModel({
      states: [
        {
          name: "S",
          varName: "S",
          events: [
            { name: "ActionEvt", hasCustomPatch: false },
            { name: "OrphanEvt", hasCustomPatch: false },
          ],
          actions: [{ name: "doIt", emits: ["ActionEvt"], invariants: [] }],
        },
      ],
    });
    const layout = computeLayout(model);
    const actionEvt = find(layout, "event", "ActionEvt");
    const orphanEvt = find(layout, "event", "OrphanEvt");
    expect(actionEvt).toBeDefined();
    expect(orphanEvt).toBeDefined();
    expect(orphanEvt!.pos.y).toBeGreaterThan(actionEvt!.pos.y);
  });
});
