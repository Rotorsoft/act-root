import { describe, expect, it } from "vitest";
import {
  compute_layout,
  type Layout,
  type N,
  W,
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
          var_name: "Empty",
          events: [],
          actions: [],
        },
      ],
    });
    const layout = compute_layout(model);
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
          var_name: "S",
          events: [{ name: "Evt", has_custom_patch: false }],
          actions: [{ name: "a", emits: ["Evt"], invariants: [] }],
        },
      ],
      reactions: [
        {
          event: "Evt",
          handler_name: "onEvt",
          dispatches: [],
        },
      ],
    });
    const layout = compute_layout(model);
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

describe("standalone reactions", () => {
  it("renders all standalone reactions", () => {
    const model = emptyModel({
      states: [
        {
          name: "S",
          var_name: "S",
          events: [{ name: "Evt", has_custom_patch: false }],
          actions: [{ name: "a", emits: ["Evt"], invariants: [] }],
        },
      ],
      reactions: [
        {
          event: "Evt",
          handler_name: "reactionA",
          dispatches: [],
        },
        {
          event: "Evt",
          handler_name: "reactionB",
          dispatches: [],
        },
      ],
    });
    const layout = compute_layout(model);
    expect(find(layout, "reaction", "reactionA")).toBeDefined();
    expect(find(layout, "reaction", "reactionB")).toBeDefined();
  });
});

describe("standalone action->event edge when ey not found", () => {
  it("skips edge when event Y position not found", () => {
    const model = emptyModel({
      states: [
        {
          name: "S",
          var_name: "S",
          events: [{ name: "Known", has_custom_patch: false }],
          actions: [
            {
              name: "a",
              emits: ["Known", "Unknown"], // Unknown not in events -> not in event_y_map
              invariants: [],
            },
          ],
        },
      ],
    });
    const layout = compute_layout(model);
    const action = find(layout, "action", "a");
    expect(action).toBeDefined();
  });
});

describe("standalone reaction without trig_node", () => {
  it("places standalone reaction when trigger event not found", () => {
    const model = emptyModel({
      states: [
        {
          name: "S",
          var_name: "S",
          events: [{ name: "Evt", has_custom_patch: false }],
          actions: [{ name: "a", emits: ["Evt"], invariants: [] }],
        },
      ],
      reactions: [
        {
          event: "NoSuchEvent", // event not in any state
          handler_name: "orphanReaction",
          dispatches: [],
        },
      ],
    });
    const layout = compute_layout(model);
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
          var_name: "S",
          events: [{ name: "Evt", has_custom_patch: false }],
          actions: [{ name: "a", emits: ["Evt"], invariants: [] }],
        },
      ],
      reactions: [
        {
          event: "Evt",
          handler_name: "r1",
          dispatches: [],
        },
        {
          event: "Evt",
          handler_name: "r2",
          dispatches: [],
        },
      ],
    });
    const layout = compute_layout(model);
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
          var_name: "S",
          events: [{ name: "Evt", has_custom_patch: false }],
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
    const layout = compute_layout(model);
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
          var_name: "S",
          events: [
            { name: "ActionEvt", has_custom_patch: false },
            { name: "OrphanEvt", has_custom_patch: false },
          ],
          actions: [{ name: "doIt", emits: ["ActionEvt"], invariants: [] }],
        },
      ],
    });
    const layout = compute_layout(model);
    const actionEvt = find(layout, "event", "ActionEvt");
    const orphanEvt = find(layout, "event", "OrphanEvt");
    expect(actionEvt).toBeDefined();
    expect(orphanEvt).toBeDefined();
    expect(orphanEvt!.pos.y).toBeGreaterThan(actionEvt!.pos.y);
  });
});
