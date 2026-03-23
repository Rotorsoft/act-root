import { describe, expect, it } from "vitest";
import {
  computeLayout,
  GAP,
  H,
  MARGIN,
  STATE_H,
  STATE_W,
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

/** Get the bounding box of a node (accounting for state vs regular dimensions) */
function nodeBBox(n: N) {
  const nw = n.type === "state" ? STATE_W : W;
  const nh = n.type === "state" ? STATE_H : H;
  return {
    left: n.pos.x,
    top: n.pos.y,
    right: n.pos.x + nw,
    bottom: n.pos.y + nh,
    centerX: n.pos.x + nw / 2,
    centerY: n.pos.y + nh / 2,
  };
}

/** Check whether two bounding boxes overlap */
function overlaps(
  a: ReturnType<typeof nodeBBox>,
  b: ReturnType<typeof nodeBBox>
) {
  return (
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
  );
}

function find(layout: Layout, type: N["type"], label: string) {
  return layout.ns.find((n) => n.type === type && n.label === label);
}

function assertNoOverlaps(layout: Layout) {
  for (let i = 0; i < layout.ns.length; i++) {
    const a = nodeBBox(layout.ns[i]);
    for (let j = i + 1; j < layout.ns.length; j++) {
      const b = nodeBBox(layout.ns[j]);
      if (overlaps(a, b)) {
        throw new Error(
          `Overlap: "${layout.ns[i].label}" (${layout.ns[i].type}) at [${a.left},${a.top}]-[${a.right},${a.bottom}] ` +
            `overlaps "${layout.ns[j].label}" (${layout.ns[j].type}) at [${b.left},${b.top}]-[${b.right},${b.bottom}]`
        );
      }
    }
  }
}

// -- Fixtures -----------------------------------------------------------------

/** Simple standalone state: 1 action -> 1 event */
const SIMPLE_MODEL: DomainModel = emptyModel({
  states: [
    {
      name: "Counter",
      varName: "Counter",
      events: [{ name: "Incremented", hasCustomPatch: true }],
      actions: [{ name: "increment", emits: ["Incremented"], invariants: [] }],
    },
  ],
});

/** Two standalone states side-by-side */
const TWO_STATES_MODEL: DomainModel = emptyModel({
  states: [
    {
      name: "Counter",
      varName: "Counter",
      events: [{ name: "Incremented", hasCustomPatch: false }],
      actions: [{ name: "increment", emits: ["Incremented"], invariants: [] }],
    },
    {
      name: "Timer",
      varName: "Timer",
      events: [{ name: "Started", hasCustomPatch: false }],
      actions: [{ name: "start", emits: ["Started"], invariants: [] }],
    },
  ],
});

/** State with multiple actions and events */
const MULTI_ACTION_MODEL: DomainModel = emptyModel({
  states: [
    {
      name: "Ticket",
      varName: "Ticket",
      events: [
        { name: "TicketOpened", hasCustomPatch: false },
        { name: "TicketClosed", hasCustomPatch: false },
        { name: "TicketAssigned", hasCustomPatch: false },
      ],
      actions: [
        { name: "OpenTicket", emits: ["TicketOpened"], invariants: [] },
        {
          name: "CloseTicket",
          emits: ["TicketClosed"],
          invariants: ["must be open"],
        },
        { name: "AssignTicket", emits: ["TicketAssigned"], invariants: [] },
      ],
    },
  ],
});

// -- Tests --------------------------------------------------------------------

describe("computeLayout", () => {
  describe("empty model", () => {
    it("produces no nodes, edges, or boxes", () => {
      const layout = computeLayout(emptyModel());
      expect(layout.ns).toHaveLength(0);
      expect(layout.es).toHaveLength(0);
      expect(layout.boxes).toHaveLength(0);
    });
  });

  describe("column ordering: actions -> state -> events", () => {
    it("places action left of state, state left of event (standalone)", () => {
      const layout = computeLayout(SIMPLE_MODEL);
      const action = find(layout, "action", "increment")!;
      const state = find(layout, "state", "Counter")!;
      const event = find(layout, "event", "Incremented")!;

      expect(action).toBeDefined();
      expect(state).toBeDefined();
      expect(event).toBeDefined();

      // Action column is to the left of state column
      expect(action.pos.x + W).toBeLessThanOrEqual(state.pos.x);
      // State column is to the left of event column
      expect(state.pos.x + STATE_W).toBeLessThanOrEqual(event.pos.x);
    });
  });

  describe("gap enforcement", () => {
    it("standalone state placed at stateColX (same as slice layout)", () => {
      const layout = computeLayout(SIMPLE_MODEL);
      const action = find(layout, "action", "increment")!;
      const state = find(layout, "state", "Counter")!;

      // State column starts at action.x + W + GAP
      const stateColX = action.pos.x + W + GAP;
      expect(state.pos.x).toBe(stateColX);
    });

    it("maintains GAP/2 vertical spacing between stacked actions", () => {
      const layout = computeLayout(MULTI_ACTION_MODEL);
      const actions = layout.ns.filter((n) => n.type === "action");
      actions.sort((a, b) => a.pos.y - b.pos.y);

      for (let i = 1; i < actions.length; i++) {
        const gap = actions[i].pos.y - (actions[i - 1].pos.y + H);
        expect(gap).toBe(GAP / 2);
      }
    });

    it("maintains GAP/2 vertical spacing between stacked events", () => {
      const layout = computeLayout(MULTI_ACTION_MODEL);
      const events = layout.ns.filter((n) => n.type === "event");
      events.sort((a, b) => a.pos.y - b.pos.y);

      for (let i = 1; i < events.length; i++) {
        const gap = events[i].pos.y - (events[i - 1].pos.y + H);
        expect(gap).toBe(GAP / 2);
      }
    });
  });

  describe("vertical centering", () => {
    it("centers state vertically relative to its action/event block (standalone, many actions)", () => {
      const layout = computeLayout(MULTI_ACTION_MODEL);
      const state = find(layout, "state", "Ticket")!;
      const actions = layout.ns.filter((n) => n.type === "action");
      const events = layout.ns.filter((n) => n.type === "event");

      const stBBox = nodeBBox(state);

      // Actions block center should align with state center
      const actTop = Math.min(...actions.map((n) => n.pos.y));
      const actBottom = Math.max(...actions.map((n) => n.pos.y + H));
      const actCenter = (actTop + actBottom) / 2;
      expect(Math.abs(stBBox.centerY - actCenter)).toBeLessThan(1);

      // Events block center should align with state center
      const evtTop = Math.min(...events.map((n) => n.pos.y));
      const evtBottom = Math.max(...events.map((n) => n.pos.y + H));
      const evtCenter = (evtTop + evtBottom) / 2;
      expect(Math.abs(stBBox.centerY - evtCenter)).toBeLessThan(1);
    });

    it("centers state vertically when 1 action -> 1 event (standalone)", () => {
      const layout = computeLayout(SIMPLE_MODEL);
      const state = find(layout, "state", "Counter")!;
      const action = find(layout, "action", "increment")!;
      const event = find(layout, "event", "Incremented")!;

      const stCenter = nodeBBox(state).centerY;
      const actCenter = action.pos.y + H / 2;
      const evtCenter = event.pos.y + H / 2;

      expect(Math.abs(stCenter - actCenter)).toBeLessThan(1);
      expect(Math.abs(stCenter - evtCenter)).toBeLessThan(1);
    });
  });

  describe("no overlapping nodes", () => {
    it("has no overlapping nodes in a simple model", () => {
      const layout = computeLayout(SIMPLE_MODEL);
      assertNoOverlaps(layout);
    });

    it("has no overlapping nodes in a multi-action model", () => {
      const layout = computeLayout(MULTI_ACTION_MODEL);
      assertNoOverlaps(layout);
    });

    it("has no overlapping nodes with two standalone states", () => {
      const layout = computeLayout(TWO_STATES_MODEL);
      const actions = layout.ns.filter((n) => n.type === "action");
      for (let i = 0; i < actions.length; i++) {
        for (let j = i + 1; j < actions.length; j++) {
          expect(overlaps(nodeBBox(actions[i]), nodeBBox(actions[j]))).toBe(
            false
          );
        }
      }
    });

    it("has no overlapping nodes with three independent standalone states", () => {
      const model = emptyModel({
        states: [
          {
            name: "Calculator",
            varName: "Calculator",
            events: [
              { name: "DigitPressed", hasCustomPatch: false },
              { name: "OperatorPressed", hasCustomPatch: false },
              { name: "DotPressed", hasCustomPatch: false },
              { name: "EqualsPressed", hasCustomPatch: false },
              { name: "Cleared", hasCustomPatch: false },
            ],
            actions: [
              {
                name: "PressKey",
                emits: [
                  "DigitPressed",
                  "OperatorPressed",
                  "DotPressed",
                  "EqualsPressed",
                ],
                invariants: [],
              },
              { name: "Clear", emits: ["Cleared"], invariants: [] },
            ],
          },
          {
            name: "DigitBoard",
            varName: "DigitBoard",
            events: [{ name: "DigitCounted", hasCustomPatch: false }],
            actions: [
              { name: "CountDigit", emits: ["DigitCounted"], invariants: [] },
            ],
          },
          {
            name: "CalculatorResult",
            varName: "CalculatorResult",
            events: [{ name: "ResultProjected", hasCustomPatch: false }],
            actions: [
              {
                name: "ProjectResult",
                emits: ["ResultProjected"],
                invariants: [],
              },
            ],
          },
        ],
      });
      const layout = computeLayout(model);
      assertNoOverlaps(layout);
    });
  });

  describe("canvas dimensions", () => {
    it("width and height encompass all nodes with MARGIN padding", () => {
      const layout = computeLayout(MULTI_ACTION_MODEL);
      for (const n of layout.ns) {
        const bb = nodeBBox(n);
        expect(bb.left).toBeGreaterThanOrEqual(layout.minX + MARGIN);
        expect(bb.top).toBeGreaterThanOrEqual(layout.minY + MARGIN);
        expect(bb.right).toBeLessThanOrEqual(
          layout.minX + layout.width - MARGIN
        );
        expect(bb.bottom).toBeLessThanOrEqual(
          layout.minY + layout.height - MARGIN
        );
      }
    });

    it("minX/minY account for nodes at negative coordinates", () => {
      const layout = computeLayout(SIMPLE_MODEL);
      const state = find(layout, "state", "Counter")!;
      if (state.pos.y < 0) {
        expect(layout.minY).toBeLessThanOrEqual(state.pos.y - MARGIN);
      }
    });

    it("returns positive dimensions even for empty model", () => {
      const layout = computeLayout(emptyModel());
      expect(layout.width).toBe(MARGIN * 2);
      expect(layout.height).toBe(MARGIN * 2);
    });
  });

  describe("edges", () => {
    it("creates an edge from each action to its emitted events (standalone)", () => {
      const layout = computeLayout(SIMPLE_MODEL);
      expect(layout.es.length).toBeGreaterThanOrEqual(1);
      const edge = layout.es[0];
      // Edge goes left-to-right (from.x < to.x)
      expect(edge.from.x).toBeLessThan(edge.to.x);
      // Non-dashed for action->event
      expect(edge.dash).toBe(false);
    });

    it("action->event edges start at action right edge and end at event left edge", () => {
      const layout = computeLayout(SIMPLE_MODEL);
      const action = find(layout, "action", "increment")!;
      const event = find(layout, "event", "Incremented")!;
      const edge = layout.es.find((e) => !e.dash)!;

      expect(edge.from.x).toBe(action.pos.x + W);
      expect(edge.from.y).toBe(action.pos.y + H / 2);
      expect(edge.to.x).toBe(event.pos.x);
      expect(edge.to.y).toBe(event.pos.y + H / 2);
    });
  });

  describe("node dimensions", () => {
    it("uses W x H for action and event nodes", () => {
      const layout = computeLayout(SIMPLE_MODEL);
      const action = find(layout, "action", "increment")!;
      const event = find(layout, "event", "Incremented")!;

      const aBB = nodeBBox(action);
      expect(aBB.right - aBB.left).toBe(W);
      expect(aBB.bottom - aBB.top).toBe(H);

      const eBB = nodeBBox(event);
      expect(eBB.right - eBB.left).toBe(W);
      expect(eBB.bottom - eBB.top).toBe(H);
    });

    it("uses STATE_W x STATE_H for state nodes with few actions", () => {
      const layout = computeLayout(SIMPLE_MODEL);
      const state = find(layout, "state", "Counter")!;

      const bb = nodeBBox(state);
      expect(bb.right - bb.left).toBe(STATE_W);
      expect(bb.bottom - bb.top).toBe(STATE_H);
    });

    it("state stays square (STATE_W x STATE_H) even with many actions", () => {
      const layout = computeLayout(MULTI_ACTION_MODEL);
      const state = find(layout, "state", "Ticket")!;

      const bb = nodeBBox(state);
      expect(bb.right - bb.left).toBe(STATE_W);
      expect(bb.bottom - bb.top).toBe(STATE_H);
    });
  });

  describe("guards / invariants metadata", () => {
    it("annotates guarded actions with sub='guarded' and guards array", () => {
      const layout = computeLayout(MULTI_ACTION_MODEL);
      const close = find(layout, "action", "CloseTicket")!;
      expect(close.sub).toBe("guarded");
      expect(close.guards).toEqual(["must be open"]);
    });

    it("non-guarded actions have no sub or guards", () => {
      const layout = computeLayout(MULTI_ACTION_MODEL);
      const open = find(layout, "action", "OpenTicket")!;
      expect(open.sub).toBeUndefined();
      expect(open.guards).toBeUndefined();
    });
  });
});
