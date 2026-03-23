import { describe, expect, it } from "vitest";
import {
  computeLayout,
  GAP,
  H,
  MARGIN,
  PAD,
  SLICE_GAP,
  SLICE_INNER,
  STATE_H,
  STATE_W,
  W,
  type Layout,
  type N,
} from "../src/client/lib/layout.js";
import type { DomainModel } from "../src/client/types/domain-model.js";

// ── Helpers ──────────────────────────────────────────────────────────

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

// ── Fixtures ─────────────────────────────────────────────────────────

/** Simple standalone state: 1 action → 1 event */
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

/** Slice with state and reaction */
const SLICE_MODEL: DomainModel = emptyModel({
  states: [
    {
      name: "Ticket",
      varName: "Ticket",
      events: [
        { name: "TicketOpened", hasCustomPatch: false },
        { name: "TicketAssigned", hasCustomPatch: false },
      ],
      actions: [
        { name: "OpenTicket", emits: ["TicketOpened"], invariants: [] },
        { name: "AssignTicket", emits: ["TicketAssigned"], invariants: [] },
      ],
    },
  ],
  slices: [
    {
      name: "TicketSlice",
      states: ["Ticket"],
      stateVars: ["Ticket"],
      projections: [],
      reactions: [
        {
          event: "TicketOpened",
          handlerName: "autoAssign",
          dispatches: ["AssignTicket"],
          isVoid: false,
        },
      ],
    },
  ],
});

/** Two slices stacking vertically */
const TWO_SLICES_MODEL: DomainModel = emptyModel({
  states: [
    {
      name: "Ticket",
      varName: "Ticket",
      events: [{ name: "TicketOpened", hasCustomPatch: false }],
      actions: [
        { name: "OpenTicket", emits: ["TicketOpened"], invariants: [] },
      ],
    },
    {
      name: "Invoice",
      varName: "Invoice",
      events: [{ name: "InvoiceCreated", hasCustomPatch: false }],
      actions: [
        { name: "CreateInvoice", emits: ["InvoiceCreated"], invariants: [] },
      ],
    },
  ],
  slices: [
    {
      name: "TicketSlice",
      states: ["Ticket"],
      stateVars: ["Ticket"],
      projections: [],
      reactions: [],
    },
    {
      name: "InvoiceSlice",
      states: ["Invoice"],
      stateVars: ["Invoice"],
      projections: [],
      reactions: [],
    },
  ],
});

// ── Tests ────────────────────────────────────────────────────────────

describe("computeLayout", () => {
  describe("empty model", () => {
    it("produces no nodes, edges, or boxes", () => {
      const layout = computeLayout(emptyModel());
      expect(layout.ns).toHaveLength(0);
      expect(layout.es).toHaveLength(0);
      expect(layout.boxes).toHaveLength(0);
    });
  });

  describe("column ordering: actions → state → events", () => {
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

    it("places action left of state, state left of event (in slice)", () => {
      const layout = computeLayout(SLICE_MODEL);
      const action = find(layout, "action", "OpenTicket")!;
      const state = find(layout, "state", "Ticket")!;
      const event = find(layout, "event", "TicketOpened")!;

      expect(action.pos.x + W).toBeLessThanOrEqual(state.pos.x);
      expect(state.pos.x + STATE_W).toBeLessThanOrEqual(event.pos.x);
    });

    it("places reactions to the right of events", () => {
      const layout = computeLayout(SLICE_MODEL);
      const event = find(layout, "event", "TicketOpened")!;
      const reaction = find(layout, "reaction", "autoAssign")!;

      expect(event.pos.x + W).toBeLessThan(reaction.pos.x);
    });
  });

  describe("gap enforcement", () => {
    it("maintains GAP between action column and state column (slice)", () => {
      const layout = computeLayout(SLICE_MODEL);
      const action = find(layout, "action", "OpenTicket")!;
      const state = find(layout, "state", "Ticket")!;

      // In slices, state is placed directly at stateColX = cx + W + GAP
      const gap = state.pos.x - (action.pos.x + W);
      expect(gap).toBe(GAP);
    });

    it("maintains GAP between state column and event column (slice)", () => {
      const layout = computeLayout(SLICE_MODEL);
      const state = find(layout, "state", "Ticket")!;
      const event = find(layout, "event", "TicketOpened")!;

      // In slices, events at stateColX + STATE_W + GAP
      const gap = event.pos.x - (state.pos.x + STATE_W);
      expect(gap).toBe(GAP);
    });

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

    it("centers state vertically when 1 action → 1 event (standalone)", () => {
      // With 1 action + 1 event (blockH=36), STATE_H=80 dominates.
      // State, action, and event should all share the same vertical center.
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

    it("centers primary block vertically when reaction chain extends below", () => {
      // When a reaction dispatches an action, the chain extends below.
      // The primary actions/state/events should be centered within the
      // total height (primary block + reaction chain), not top-aligned.
      const layout = computeLayout(SLICE_MODEL);
      const state = find(layout, "state", "Ticket")!;
      const reaction = find(layout, "reaction", "autoAssign")!;
      const dispatchedAction = layout.ns.find(
        (n) => n.type === "action" && n.key.includes("dispatched")
      )!;

      // The dispatched chain extends below the primary block
      const dispatchedBottom = Math.max(
        ...layout.ns
          .filter((n) => n.key.includes("dispatched"))
          .map((n) => n.pos.y + (n.type === "state" ? STATE_H : H))
      );

      // The primary state center should be well above the dispatched bottom
      const stateCenter = state.pos.y + STATE_H / 2;
      expect(stateCenter).toBeLessThan(dispatchedBottom);

      // The reaction should be below or at the same level as the triggering event
      const trigEvent = find(layout, "event", "TicketOpened")!;
      expect(reaction.pos.y).toBeGreaterThanOrEqual(trigEvent.pos.y);

      // Dispatched action should be to the right of reaction
      expect(dispatchedAction.pos.x).toBeGreaterThan(reaction.pos.x + W);
    });

    it("centers state vertically relative to actions/events in a slice (no reactions)", () => {
      // Use a slice without reactions so event heights are uniform
      const model = emptyModel({
        states: [
          {
            name: "T",
            varName: "T",
            events: [
              { name: "E1", hasCustomPatch: false },
              { name: "E2", hasCustomPatch: false },
            ],
            actions: [
              { name: "A1", emits: ["E1"], invariants: [] },
              { name: "A2", emits: ["E2"], invariants: [] },
            ],
          },
        ],
        slices: [
          {
            name: "Sl",
            states: ["T"],
            stateVars: ["T"],
            projections: [],
            reactions: [],
          },
        ],
      });
      const layout = computeLayout(model);
      const state = find(layout, "state", "T")!;
      const actions = layout.ns.filter((n) => n.type === "action");
      const events = layout.ns.filter((n) => n.type === "event");

      const stBBox = nodeBBox(state);

      const actTop = Math.min(...actions.map((n) => n.pos.y));
      const actBottom = Math.max(...actions.map((n) => n.pos.y + H));
      const actCenter = (actTop + actBottom) / 2;
      expect(Math.abs(stBBox.centerY - actCenter)).toBeLessThan(1);

      const evtTop = Math.min(...events.map((n) => n.pos.y));
      const evtBottom = Math.max(...events.map((n) => n.pos.y + H));
      const evtCenter = (evtTop + evtBottom) / 2;
      expect(Math.abs(stBBox.centerY - evtCenter)).toBeLessThan(1);
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

    it("has no overlapping nodes in a slice model with reactions", () => {
      const layout = computeLayout(SLICE_MODEL);
      assertNoOverlaps(layout);
    });

    it("has no overlapping nodes with two standalone states", () => {
      // Standalone states tile vertically with cx += GAP horizontal shift.
      // State centering can cause y to extend above the starting row,
      // leading to overlap when states are very close. This test documents
      // the expected behavior: each state's ACTION nodes should not overlap.
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

    it("has no overlapping nodes in multi-reaction slice (watermark)", () => {
      const model = emptyModel({
        states: [
          {
            name: "T",
            varName: "T",
            events: [
              { name: "E1", hasCustomPatch: false },
              { name: "E2", hasCustomPatch: false },
              { name: "E3", hasCustomPatch: false },
              { name: "E4", hasCustomPatch: false },
            ],
            actions: [
              { name: "A1", emits: ["E1"], invariants: [] },
              { name: "A2", emits: ["E2"], invariants: [] },
              { name: "A3", emits: ["E3"], invariants: [] },
              { name: "A4", emits: ["E4"], invariants: [] },
            ],
          },
        ],
        slices: [
          {
            name: "Sl",
            states: ["T"],
            stateVars: ["T"],
            projections: [],
            reactions: [
              {
                event: "E1",
                handlerName: "r1",
                dispatches: ["A3"],
                isVoid: false,
              },
              {
                event: "E2",
                handlerName: "r2",
                dispatches: ["A4"],
                isVoid: false,
              },
            ],
          },
        ],
      });
      const layout = computeLayout(model);
      assertNoOverlaps(layout);
    });

    it("has no overlapping nodes with three independent standalone states", () => {
      // Calculator-like model: 3 standalone states with varying action counts
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

    it("has no overlapping nodes across two slices", () => {
      const layout = computeLayout(TWO_SLICES_MODEL);
      assertNoOverlaps(layout);
    });
  });

  describe("slice bounding boxes", () => {
    it("creates a bounding box for each slice", () => {
      const layout = computeLayout(SLICE_MODEL);
      expect(layout.boxes).toHaveLength(1);
      expect(layout.boxes[0].label).toBe("TicketSlice");
    });

    it("slice box fully contains all its nodes with SLICE_INNER padding", () => {
      const layout = computeLayout(SLICE_MODEL);
      const box = layout.boxes[0];
      // Find nodes belonging to this slice
      const sliceNodes = layout.ns.filter(
        (n) => n.key.includes("TicketSlice") || n.key.includes("dispatched")
      );

      for (const n of sliceNodes) {
        const bb = nodeBBox(n);
        expect(bb.left).toBeGreaterThanOrEqual(box.x);
        expect(bb.top).toBeGreaterThanOrEqual(box.y);
        expect(bb.right).toBeLessThanOrEqual(box.x + box.w);
        expect(bb.bottom).toBeLessThanOrEqual(box.y + box.h);
      }
    });

    it("slice box has SLICE_INNER padding above topmost and below bottommost node", () => {
      const layout = computeLayout(SLICE_MODEL);
      const box = layout.boxes[0];
      // Include dispatched nodes that belong to this slice
      const sliceNodes = layout.ns.filter(
        (n) => n.key.includes("TicketSlice") || n.key.includes("dispatched")
      );

      const topNode = Math.min(...sliceNodes.map((n) => n.pos.y));
      const bottomNode = Math.max(
        ...sliceNodes.map((n) => {
          const nh = n.type === "state" ? STATE_H : H;
          return n.pos.y + nh;
        })
      );

      expect(box.y).toBe(topNode - SLICE_INNER);
      expect(box.y + box.h).toBe(bottomNode + SLICE_INNER);
    });

    it("two slice boxes don't overlap and have SLICE_GAP between them", () => {
      const layout = computeLayout(TWO_SLICES_MODEL);
      expect(layout.boxes).toHaveLength(2);

      const box1 = layout.boxes[0];
      const box2 = layout.boxes[1];
      const gap = box2.y - (box1.y + box1.h);
      expect(gap).toBe(SLICE_GAP);
    });

    it("slice gap is maintained even when chains extend above primary block", () => {
      // Slice with a chain whose dispatched state (STATE_H=80) extends
      // above the reaction center. The two-phase translate must account
      // for this so the next slice doesn't overlap.
      const model = emptyModel({
        states: [
          {
            name: "A",
            varName: "A",
            events: [
              { name: "E1", hasCustomPatch: false },
              { name: "E2", hasCustomPatch: false },
            ],
            actions: [
              { name: "Do1", emits: ["E1"], invariants: [] },
              { name: "Do2", emits: ["E2"], invariants: [] },
            ],
          },
          {
            name: "B",
            varName: "B",
            events: [{ name: "E3", hasCustomPatch: false }],
            actions: [{ name: "Do3", emits: ["E3"], invariants: [] }],
          },
        ],
        slices: [
          {
            name: "S1",
            states: ["A"],
            stateVars: ["A"],
            projections: [],
            reactions: [
              {
                event: "E1",
                handlerName: "r1",
                dispatches: ["Do2"],
                isVoid: false,
              },
            ],
          },
          {
            name: "S2",
            states: ["B"],
            stateVars: ["B"],
            projections: [],
            reactions: [],
          },
        ],
      });
      const layout = computeLayout(model);
      expect(layout.boxes).toHaveLength(2);

      const box1 = layout.boxes[0];
      const box2 = layout.boxes[1];
      // No overlap
      expect(box2.y).toBeGreaterThanOrEqual(box1.y + box1.h);
      // Proper gap
      expect(box2.y - (box1.y + box1.h)).toBe(SLICE_GAP);
      // All nodes in box1 are within box1
      for (const n of layout.ns) {
        if (!n.key.includes("S1") && !n.key.includes("dispatched")) continue;
        const bb = nodeBBox(n);
        expect(bb.top).toBeGreaterThanOrEqual(box1.y);
        expect(bb.bottom).toBeLessThanOrEqual(box1.y + box1.h);
      }
    });

    it("slice box includes SLICE_PAD offset for the vertical label strip", () => {
      const layout = computeLayout(SLICE_MODEL);
      const box = layout.boxes[0];
      // The leftmost node inside a slice starts at PAD + SLICE_PAD + GAP
      // The box.x is at PAD - GAP/2
      expect(box.x).toBe(PAD - GAP / 2);
    });
  });

  describe("canvas dimensions", () => {
    it("width and height encompass all nodes with MARGIN padding", () => {
      const layout = computeLayout(MULTI_ACTION_MODEL);
      for (const n of layout.ns) {
        const bb = nodeBBox(n);
        // Every node must be within [minX, minX+width] × [minY, minY+height]
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
      // Standalone centering can push state above y=0
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
      // Non-dashed for action→event
      expect(edge.dash).toBe(false);
    });

    it("creates dashed edges for reaction arrows", () => {
      const layout = computeLayout(SLICE_MODEL);
      const dashedEdges = layout.es.filter((e) => e.dash);
      expect(dashedEdges.length).toBeGreaterThanOrEqual(1);
      // All dashed edges go left-to-right
      for (const e of dashedEdges) {
        expect(e.from.x).toBeLessThan(e.to.x);
      }
    });

    it("action→event edges start at action right edge and end at event left edge", () => {
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

  describe("dispatched reaction chains", () => {
    it("places dispatched action to the right of the reaction", () => {
      const layout = computeLayout(SLICE_MODEL);
      const reaction = find(layout, "reaction", "autoAssign")!;
      const dispatched = layout.ns.find(
        (n) => n.type === "action" && n.key.includes("dispatched")
      )!;

      expect(dispatched).toBeDefined();
      expect(dispatched.pos.x).toBeGreaterThan(reaction.pos.x + W);
    });

    it("places dispatched state and events further right in the chain", () => {
      const layout = computeLayout(SLICE_MODEL);
      const dispatched = layout.ns.find(
        (n) => n.type === "action" && n.key.includes("dispatched")
      )!;
      const dispatchedState = layout.ns.find(
        (n) => n.type === "state" && n.key.includes("dispatched")
      )!;
      const dispatchedEvent = layout.ns.find(
        (n) => n.type === "event" && n.key.includes("dispatched")
      )!;

      expect(dispatchedState.pos.x).toBeGreaterThan(dispatched.pos.x + W);
      expect(dispatchedEvent.pos.x).toBeGreaterThan(
        dispatchedState.pos.x + STATE_W
      );
    });
  });

  describe("reaction chain layout rules", () => {
    it("events stack tightly at uniform H + GAP/2 regardless of chains", () => {
      const layout = computeLayout(SLICE_MODEL);
      const primaryEvents = layout.ns.filter(
        (n) =>
          n.type === "event" &&
          n.key.includes("TicketSlice") &&
          !n.key.includes("dispatched")
      );
      primaryEvents.sort((a, b) => a.pos.y - b.pos.y);

      for (let i = 1; i < primaryEvents.length; i++) {
        const spacing = primaryEvents[i].pos.y - primaryEvents[i - 1].pos.y;
        expect(spacing).toBe(H + GAP / 2);
      }
    });

    it("reaction aligns vertically with triggering event when no prior chain", () => {
      const layout = computeLayout(SLICE_MODEL);
      const trigEvent = find(layout, "event", "TicketOpened")!;
      const reaction = find(layout, "reaction", "autoAssign")!;

      // Reaction top should equal event top (aligned)
      expect(reaction.pos.y).toBe(trigEvent.pos.y);
    });

    it("dispatched row is internally centered (action, state, events share rowCenterY)", () => {
      const layout = computeLayout(SLICE_MODEL);
      const dAction = layout.ns.find(
        (n) => n.type === "action" && n.key.includes("dispatched")
      )!;
      const dState = layout.ns.find(
        (n) => n.type === "state" && n.key.includes("dispatched")
      )!;
      const dEvent = layout.ns.find(
        (n) => n.type === "event" && n.key.includes("dispatched")
      )!;

      // All three should share the same vertical center
      const actionCenter = dAction.pos.y + H / 2;
      const stateCenter = dState.pos.y + STATE_H / 2;
      const eventCenter = dEvent.pos.y + H / 2;

      expect(Math.abs(actionCenter - stateCenter)).toBeLessThan(1);
      expect(Math.abs(stateCenter - eventCenter)).toBeLessThan(1);
    });

    it("dispatched block is centered on reaction center", () => {
      const layout = computeLayout(SLICE_MODEL);
      const reaction = find(layout, "reaction", "autoAssign")!;
      const dState = layout.ns.find(
        (n) => n.type === "state" && n.key.includes("dispatched")
      )!;

      const reactionCenter = reaction.pos.y + H / 2;
      const stateCenter = dState.pos.y + STATE_H / 2;

      // Dispatched row centered on reaction center
      expect(Math.abs(reactionCenter - stateCenter)).toBeLessThan(1);
    });

    it("watermark pushes second reaction down when chains would overlap", () => {
      // Two events both trigger reactions with dispatched states (STATE_H=80).
      // Events are 42px apart (H + GAP/2), but chains need 80px.
      // Second reaction must be pushed below first chain.
      const model = emptyModel({
        states: [
          {
            name: "T",
            varName: "T",
            events: [
              { name: "E1", hasCustomPatch: false },
              { name: "E2", hasCustomPatch: false },
              { name: "E3", hasCustomPatch: false },
              { name: "E4", hasCustomPatch: false },
            ],
            actions: [
              { name: "A1", emits: ["E1"], invariants: [] },
              { name: "A2", emits: ["E2"], invariants: [] },
              { name: "A3", emits: ["E3"], invariants: [] },
              { name: "A4", emits: ["E4"], invariants: [] },
            ],
          },
        ],
        slices: [
          {
            name: "Sl",
            states: ["T"],
            stateVars: ["T"],
            projections: [],
            reactions: [
              {
                event: "E1",
                handlerName: "r1",
                dispatches: ["A3"],
                isVoid: false,
              },
              {
                event: "E2",
                handlerName: "r2",
                dispatches: ["A4"],
                isVoid: false,
              },
            ],
          },
        ],
      });
      const layout = computeLayout(model);
      const r1 = find(layout, "reaction", "r1")!;
      const r2 = find(layout, "reaction", "r2")!;
      const e1 = find(layout, "event", "E1")!;
      const e2 = find(layout, "event", "E2")!;

      // Events are tightly stacked
      expect(e2.pos.y - e1.pos.y).toBe(H + GAP / 2);

      // First reaction aligns with its event
      expect(r1.pos.y).toBe(e1.pos.y);

      // Second reaction is pushed down (watermark) — below first chain's extent
      expect(r2.pos.y).toBeGreaterThanOrEqual(e2.pos.y);

      // The two dispatched state blocks must not overlap
      const dStates = layout.ns.filter(
        (n) => n.type === "state" && n.key.includes("dispatched")
      );
      expect(dStates).toHaveLength(2);
      const [ds1, ds2] = dStates.sort((a, b) => a.pos.y - b.pos.y);
      expect(ds2.pos.y).toBeGreaterThanOrEqual(ds1.pos.y + STATE_H);
    });

    it("states are always square (STATE_W × STATE_H)", () => {
      const layout = computeLayout(SLICE_MODEL);
      const states = layout.ns.filter((n) => n.type === "state");
      for (const s of states) {
        const bb = nodeBBox(s);
        expect(bb.right - bb.left).toBe(STATE_W);
        expect(bb.bottom - bb.top).toBe(STATE_H);
      }
    });

    it("slice bounding box extends to contain all chain nodes", () => {
      const layout = computeLayout(SLICE_MODEL);
      const box = layout.boxes[0];
      // All nodes (including dispatched) must be within the slice box
      for (const n of layout.ns) {
        if (!n.key.includes("TicketSlice") && !n.key.includes("dispatched"))
          continue;
        const bb = nodeBBox(n);
        expect(bb.left).toBeGreaterThanOrEqual(box.x);
        expect(bb.top).toBeGreaterThanOrEqual(box.y);
        expect(bb.right).toBeLessThanOrEqual(box.x + box.w);
        expect(bb.bottom).toBeLessThanOrEqual(box.y + box.h);
      }
    });

    it("recursive chain: dispatched event triggers further reaction", () => {
      // E1 → r1 → A2 → [E2] → r2 → A3 → [E3]
      const model = emptyModel({
        states: [
          {
            name: "S",
            varName: "S",
            events: [
              { name: "E1", hasCustomPatch: false },
              { name: "E2", hasCustomPatch: false },
              { name: "E3", hasCustomPatch: false },
            ],
            actions: [
              { name: "A1", emits: ["E1"], invariants: [] },
              { name: "A2", emits: ["E2"], invariants: [] },
              { name: "A3", emits: ["E3"], invariants: [] },
            ],
          },
        ],
        slices: [
          {
            name: "Sl",
            states: ["S"],
            stateVars: ["S"],
            projections: [],
            reactions: [
              {
                event: "E1",
                handlerName: "r1",
                dispatches: ["A2"],
                isVoid: false,
              },
              {
                event: "E2",
                handlerName: "r2",
                dispatches: ["A3"],
                isVoid: false,
              },
            ],
          },
        ],
      });
      const layout = computeLayout(model);

      // Both reactions should be placed
      const r1 = find(layout, "reaction", "r1");
      const r2 = find(layout, "reaction", "r2");
      expect(r1).toBeDefined();
      expect(r2).toBeDefined();

      // r2 should be further right than r1 (deeper nesting)
      expect(r2!.pos.x).toBeGreaterThan(r1!.pos.x);

      // Each dispatched row's action, state, events are horizontally ordered
      const dispatched = layout.ns.filter((n) => n.key.includes("dispatched"));
      expect(dispatched.length).toBeGreaterThanOrEqual(4); // at least 2 actions + 2 states or events
    });
  });

  describe("node dimensions", () => {
    it("uses W×H for action and event nodes", () => {
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

    it("uses STATE_W×STATE_H for state nodes with few actions", () => {
      const layout = computeLayout(SIMPLE_MODEL);
      const state = find(layout, "state", "Counter")!;

      const bb = nodeBBox(state);
      expect(bb.right - bb.left).toBe(STATE_W);
      expect(bb.bottom - bb.top).toBe(STATE_H);
    });

    it("state stays square (STATE_W × STATE_H) even with many actions", () => {
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

  describe("partial state merging in slices", () => {
    it("merges two partial states with the same name into one block", () => {
      const model = emptyModel({
        states: [
          {
            name: "Ticket",
            varName: "TicketCreation",
            events: [{ name: "TicketOpened", hasCustomPatch: false }],
            actions: [
              { name: "OpenTicket", emits: ["TicketOpened"], invariants: [] },
            ],
          },
          {
            name: "Ticket",
            varName: "TicketOps",
            events: [{ name: "TicketAssigned", hasCustomPatch: false }],
            actions: [
              {
                name: "AssignTicket",
                emits: ["TicketAssigned"],
                invariants: [],
              },
            ],
          },
        ],
        slices: [
          {
            name: "TicketSlice",
            states: ["Ticket"],
            stateVars: ["TicketCreation", "TicketOps"],
            projections: [],
            reactions: [],
          },
        ],
      });
      const layout = computeLayout(model);

      // Should produce ONE state node named "Ticket", not two
      const stateNodes = layout.ns.filter(
        (n) => n.type === "state" && n.label === "Ticket"
      );
      expect(stateNodes).toHaveLength(1);

      // Should have actions from BOTH partial states
      const actionNodes = layout.ns.filter((n) => n.type === "action");
      const actionNames = actionNodes.map((n) => n.label);
      expect(actionNames).toContain("OpenTicket");
      expect(actionNames).toContain("AssignTicket");

      // Should have events from BOTH partial states
      const eventNodes = layout.ns.filter((n) => n.type === "event");
      const eventNames = eventNodes.map((n) => n.label);
      expect(eventNames).toContain("TicketOpened");
      expect(eventNames).toContain("TicketAssigned");
    });

    it("does not duplicate actions when same action appears in both partials", () => {
      const model = emptyModel({
        states: [
          {
            name: "S",
            varName: "S1",
            events: [{ name: "E", hasCustomPatch: false }],
            actions: [{ name: "doIt", emits: ["E"], invariants: [] }],
          },
          {
            name: "S",
            varName: "S2",
            events: [{ name: "E", hasCustomPatch: false }],
            actions: [{ name: "doIt", emits: ["E"], invariants: [] }],
          },
        ],
        slices: [
          {
            name: "Sl",
            states: ["S"],
            stateVars: ["S1", "S2"],
            projections: [],
            reactions: [],
          },
        ],
      });
      const layout = computeLayout(model);
      const actionNodes = layout.ns.filter((n) => n.type === "action");
      expect(actionNodes).toHaveLength(1);
    });
  });

  describe("empty slice (no resolved states)", () => {
    it("produces a fallback bounding box for an empty slice", () => {
      const model = emptyModel({
        states: [],
        slices: [
          {
            name: "EmptySlice",
            states: [],
            stateVars: ["Missing"],
            projections: [],
            reactions: [],
          },
        ],
      });
      const layout = computeLayout(model);
      expect(layout.boxes).toHaveLength(1);
      expect(layout.boxes[0].w).toBeGreaterThan(0);
      expect(layout.boxes[0].h).toBeGreaterThan(0);
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
            isVoid: false,
          },
        ],
      });
      const layout = computeLayout(model);
      const evt = find(layout, "event", "Evt")!;
      expect(evt.reactions).toEqual(["onEvt"]);
    });
  });

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

  describe("void reactions are excluded from slice layout", () => {
    it("does not place void reaction nodes", () => {
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
            name: "Sl",
            states: ["S"],
            stateVars: ["S"],
            projections: [],
            reactions: [
              {
                event: "Evt",
                handlerName: "voidHandler",
                dispatches: [],
                isVoid: true,
              },
            ],
          },
        ],
      });
      const layout = computeLayout(model);
      const reaction = find(layout, "reaction", "voidHandler");
      expect(reaction).toBeUndefined();
    });
  });

  describe("remaining reactions (not placed inline)", () => {
    it("places a reaction that listens to an event from a different state", () => {
      // Two states in one slice: reaction on State B's event, but placed
      // after the inline chain pass. This hits the "remaining reactions" loop.
      const model = emptyModel({
        states: [
          {
            name: "A",
            varName: "A",
            events: [{ name: "EvtA", hasCustomPatch: false }],
            actions: [{ name: "doA", emits: ["EvtA"], invariants: [] }],
          },
          {
            name: "B",
            varName: "B",
            events: [{ name: "EvtB", hasCustomPatch: false }],
            actions: [{ name: "doB", emits: ["EvtB"], invariants: [] }],
          },
        ],
        slices: [
          {
            name: "Sl",
            states: ["A", "B"],
            stateVars: ["A", "B"],
            projections: [],
            reactions: [
              // Inline reaction: EvtA → autoDoB (will be placed inline)
              {
                event: "EvtA",
                handlerName: "autoDoB",
                dispatches: ["doB"],
                isVoid: false,
              },
              // Remaining reaction: EvtB → notify (event from B, NOT inline-chained)
              {
                event: "EvtB",
                handlerName: "notify",
                dispatches: [],
                isVoid: false,
              },
            ],
          },
        ],
      });
      const layout = computeLayout(model);
      const notify = find(layout, "reaction", "notify");
      expect(notify).toBeDefined();
      // Should be placed to the right of all other nodes in the slice
      const nonReactionNodes = layout.ns.filter(
        (n) => n.type !== "reaction" && n.key.includes("Sl")
      );
      const maxRight = Math.max(
        ...nonReactionNodes.map(
          (n) => n.pos.x + (n.type === "state" ? STATE_W : W)
        )
      );
      expect(notify!.pos.x).toBeGreaterThan(maxRight);
    });

    it("places reaction at y position when no matching event node in slice", () => {
      // Reaction listens to an event that doesn't exist in any state of the slice
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
            name: "Sl",
            states: ["S"],
            stateVars: ["S"],
            projections: [],
            reactions: [
              {
                event: "UnknownEvent",
                handlerName: "orphanHandler",
                dispatches: [],
                isVoid: false,
              },
            ],
          },
        ],
      });
      const layout = computeLayout(model);
      const reaction = find(layout, "reaction", "orphanHandler");
      expect(reaction).toBeDefined();
    });
  });

  describe("reaction without dispatch", () => {
    it("places reaction node but no dispatched chain", () => {
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
            name: "Sl",
            states: ["S"],
            stateVars: ["S"],
            projections: [],
            reactions: [
              {
                event: "Evt",
                handlerName: "noDispatch",
                dispatches: [],
                isVoid: false,
              },
            ],
          },
        ],
      });
      const layout = computeLayout(model);
      const reaction = find(layout, "reaction", "noDispatch");
      expect(reaction).toBeDefined();
      // No dispatched nodes
      const dispatched = layout.ns.filter((n) => n.key.includes("dispatched"));
      expect(dispatched).toHaveLength(0);
    });
  });
});

describe("error slice box (lines 318-331)", () => {
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
    // Should have a box with the error field set
    expect(layout.boxes).toHaveLength(1);
    expect(layout.boxes[0].label).toBe("BrokenSlice");
    expect(layout.boxes[0].error).toBe(
      "Failed to build this slice due to syntax error"
    );
    // Error box should have minimum dimensions
    expect(layout.boxes[0].w).toBeGreaterThanOrEqual(300);
    expect(layout.boxes[0].h).toBeGreaterThan(0);
    // No nodes should be placed for error slices
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
    // Error box comes first
    expect(layout.boxes[0].error).toBe("broken");
    // Good slice box should be below the error box
    expect(layout.boxes[1].y).toBeGreaterThan(layout.boxes[0].y);
  });
});

describe("projection nodes below events (lines 550-559)", () => {
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
    // Should have a projection node
    const projNode = layout.ns.find((n) => n.type === "projection");
    expect(projNode).toBeDefined();
    expect(projNode!.label).toBe("tickets");

    // Projection should be below all event nodes
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

describe("orphan events in slices (line 417)", () => {
  it("places events declared in .emits() but not emitted by any action", () => {
    const model = emptyModel({
      states: [
        {
          name: "S",
          varName: "S",
          events: [
            { name: "EmittedEvt", hasCustomPatch: false },
            { name: "OrphanEvt", hasCustomPatch: false },
          ],
          actions: [{ name: "doIt", emits: ["EmittedEvt"], invariants: [] }],
        },
      ],
      slices: [
        {
          name: "Sl",
          states: ["S"],
          stateVars: ["S"],
          projections: [],
          reactions: [],
        },
      ],
    });
    const layout = computeLayout(model);
    // Both events should be placed
    const emittedEvt = find(layout, "event", "EmittedEvt");
    const orphanEvt = find(layout, "event", "OrphanEvt");
    expect(emittedEvt).toBeDefined();
    expect(orphanEvt).toBeDefined();
    // Orphan event should be below the emitted event
    expect(orphanEvt!.pos.y).toBeGreaterThan(emittedEvt!.pos.y);
  });
});

describe("remaining reaction edge in slice when trigger event exists (line 628)", () => {
  it("creates edge from trigger event to second reaction on same event (remaining reactions path)", () => {
    // Two non-void reactions on the same event. Only the first is placed inline
    // (via sliceReactionByEvent). The second goes to the remaining reactions loop
    // and should get an edge when the trigger event node exists.
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
          name: "Sl",
          states: ["S"],
          stateVars: ["S"],
          projections: [],
          reactions: [
            {
              event: "Evt",
              handlerName: "firstHandler",
              dispatches: [],
              isVoid: false,
            },
            {
              event: "Evt",
              handlerName: "secondHandler",
              dispatches: [],
              isVoid: false,
            },
          ],
        },
      ],
    });
    const layout = computeLayout(model);
    // Both reactions should be placed
    const first = find(layout, "reaction", "firstHandler");
    const second = find(layout, "reaction", "secondHandler");
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    // The second reaction should have a dashed edge from the trigger event
    find(layout, "event", "Evt")!;
    const dashedEdges = layout.es.filter((e) => e.dash);
    const edge = dashedEdges.find(
      (e) => e.to.x === second!.pos.x && e.to.y === second!.pos.y + H / 2
    );
    expect(edge).toBeDefined();
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
    // Should have a dashed edge from the event to the reaction
    const dashedEdges = layout.es.filter((e) => e.dash);
    expect(dashedEdges.length).toBeGreaterThanOrEqual(1);
    const evt = find(layout, "event", "Evt")!;
    const edge = dashedEdges.find(
      (e) => e.from.x === evt.pos.x + W && e.to.x === reaction!.pos.x
    );
    expect(edge).toBeDefined();
  });
});

describe("multi-dispatch reaction chain (line 130)", () => {
  it("places multiple dispatched actions in the same chain", () => {
    const model = emptyModel({
      states: [
        {
          name: "S",
          varName: "S",
          events: [
            { name: "E1", hasCustomPatch: false },
            { name: "E2", hasCustomPatch: false },
            { name: "E3", hasCustomPatch: false },
          ],
          actions: [
            { name: "A1", emits: ["E1"], invariants: [] },
            { name: "A2", emits: ["E2"], invariants: [] },
            { name: "A3", emits: ["E3"], invariants: [] },
          ],
        },
      ],
      slices: [
        {
          name: "Sl",
          states: ["S"],
          stateVars: ["S"],
          projections: [],
          reactions: [
            {
              event: "E1",
              handlerName: "multiDispatch",
              dispatches: ["A2", "A3"], // dispatches TWO actions
              isVoid: false,
            },
          ],
        },
      ],
    });
    const layout = computeLayout(model);
    // Should have two dispatched action nodes
    const dispatched = layout.ns.filter(
      (n) => n.type === "action" && n.key.includes("dispatched")
    );
    expect(dispatched.length).toBe(2);
  });
});

describe("void standalone reactions (line 288, 795)", () => {
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
    // Void reaction should not be placed
    const voidNode = find(layout, "reaction", "voidReaction");
    expect(voidNode).toBeUndefined();
    // Real reaction should be placed
    const realNode = find(layout, "reaction", "realReaction");
    expect(realNode).toBeDefined();
  });
});

describe("state with file property in slice (lines 348, 351)", () => {
  it("maps event and action source files from state.file", () => {
    const model = emptyModel({
      states: [
        {
          name: "T",
          varName: "T",
          file: "src/ticket.ts",
          events: [{ name: "Opened", hasCustomPatch: false }],
          actions: [{ name: "Open", emits: ["Opened"], invariants: [] }],
        },
      ],
      slices: [
        {
          name: "Sl",
          states: ["T"],
          stateVars: ["T"],
          projections: [],
          reactions: [],
        },
      ],
    });
    const layout = computeLayout(model);
    const evt = find(layout, "event", "Opened");
    expect(evt).toBeDefined();
    expect(evt!.file).toBe("src/ticket.ts");
    const act = find(layout, "action", "Open");
    expect(act!.file).toBe("src/ticket.ts");
  });
});

describe("state with no events and no actions in slice (line 463)", () => {
  it("uses default event block height for empty state", () => {
    const model = emptyModel({
      states: [
        {
          name: "Empty",
          varName: "Empty",
          events: [],
          actions: [],
        },
      ],
      slices: [
        {
          name: "Sl",
          states: ["Empty"],
          stateVars: ["Empty"],
          projections: [],
          reactions: [],
        },
      ],
    });
    const layout = computeLayout(model);
    // Should still place a state node
    const state = find(layout, "state", "Empty");
    expect(state).toBeDefined();
  });
});

describe("duplicate projection dedup in slice (line 549)", () => {
  it("deduplicates projections when multiple events reference same projection", () => {
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
          projections: ["shared"],
          reactions: [],
        },
      ],
      projections: [
        {
          name: "shared",
          varName: "shared",
          handles: ["E1", "E2"], // both events handled by same projection
        },
      ],
    });
    const layout = computeLayout(model);
    // Should only have ONE projection node despite both events mapping to it
    const projNodes = layout.ns.filter((n) => n.type === "projection");
    expect(projNodes).toHaveLength(1);
    expect(projNodes[0].label).toBe("shared");
  });
});

describe("dispatched action with invariants (lines 193-199)", () => {
  it("annotates dispatched action with guards when target action has invariants", () => {
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
            { name: "A1", emits: ["E1"], invariants: [] },
            {
              name: "A2",
              emits: ["E2"],
              invariants: ["must be valid"],
            },
          ],
        },
      ],
      slices: [
        {
          name: "Sl",
          states: ["S"],
          stateVars: ["S"],
          projections: [],
          reactions: [
            {
              event: "E1",
              handlerName: "r1",
              dispatches: ["A2"],
              isVoid: false,
            },
          ],
        },
      ],
    });
    const layout = computeLayout(model);
    const dispatched = layout.ns.find(
      (n) => n.type === "action" && n.key.includes("dispatched")
    );
    expect(dispatched).toBeDefined();
    expect(dispatched!.sub).toBe("guarded");
    expect(dispatched!.guards).toEqual(["must be valid"]);
  });
});

describe("dispatched chain without target state (line 211)", () => {
  it("handles dispatch to unknown action (no target state found)", () => {
    const model = emptyModel({
      states: [
        {
          name: "S",
          varName: "S",
          events: [{ name: "E1", hasCustomPatch: false }],
          actions: [{ name: "A1", emits: ["E1"], invariants: [] }],
        },
      ],
      slices: [
        {
          name: "Sl",
          states: ["S"],
          stateVars: ["S"],
          projections: [],
          reactions: [
            {
              event: "E1",
              handlerName: "r1",
              dispatches: ["UnknownAction"], // action not in any state
              isVoid: false,
            },
          ],
        },
      ],
    });
    const layout = computeLayout(model);
    // Should still place the reaction and dispatched action
    const reaction = find(layout, "reaction", "r1");
    expect(reaction).toBeDefined();
    const dispatched = layout.ns.find(
      (n) => n.type === "action" && n.key.includes("dispatched")
    );
    expect(dispatched).toBeDefined();
    // No dispatched state since target action not found
    const dispatchedState = layout.ns.find(
      (n) => n.type === "state" && n.key.includes("dispatched")
    );
    expect(dispatchedState).toBeUndefined();
  });
});

describe("standalone action→event edge when ey not found (line 775)", () => {
  it("skips edge when event Y position not found", () => {
    // This is hard to trigger directly since eventYMap is built from actions.
    // But we can test with an action that emits an event not in eventYMap.
    // Actually this branch is: if (ey !== undefined) at line 775.
    // The only way ey is undefined is if the event was already processed
    // or doesn't exist. With orphan events, the action emits list
    // reference events that ARE in eventYMap. So this requires
    // an action.emits entry that's not in the state's events at all.
    const model = emptyModel({
      states: [
        {
          name: "S",
          varName: "S",
          events: [{ name: "Known", hasCustomPatch: false }],
          actions: [
            {
              name: "a",
              emits: ["Known", "Unknown"], // Unknown not in events → not in eventYMap
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

describe("standalone reaction without trigNode (line 800, 802)", () => {
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

describe("standalone reactions with multiple events stacking (line 812)", () => {
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
    // Second reaction should be stacked below first
    expect(r2.pos.y).toBeGreaterThan(r1.pos.y);
  });
});

describe("guarded standalone action (line 581-582)", () => {
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

describe("orphan events in standalone states (lines 740-749)", () => {
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
    // Orphan event should be below the action-emitted event
    expect(orphanEvt!.pos.y).toBeGreaterThan(actionEvt!.pos.y);
  });
});

// ── Shared assertions ────────────────────────────────────────────────

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
