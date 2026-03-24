import { describe, expect, it } from "vitest";
import {
  computeLayout,
  GAP,
  H,
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

// -- Tests --------------------------------------------------------------------

describe("computeLayout — slices", () => {
  describe("column ordering in slices", () => {
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

  describe("gap enforcement in slices", () => {
    it("maintains GAP between action column and state column (slice)", () => {
      const layout = computeLayout(SLICE_MODEL);
      const action = find(layout, "action", "OpenTicket")!;
      const state = find(layout, "state", "Ticket")!;

      const gap = state.pos.x - (action.pos.x + W);
      expect(gap).toBe(GAP);
    });

    it("maintains GAP between state column and event column (slice)", () => {
      const layout = computeLayout(SLICE_MODEL);
      const state = find(layout, "state", "Ticket")!;
      const event = find(layout, "event", "TicketOpened")!;

      const gap = event.pos.x - (state.pos.x + STATE_W);
      expect(gap).toBe(GAP);
    });
  });

  describe("vertical centering in slices", () => {
    it("centers primary block vertically when reaction chain extends below", () => {
      const layout = computeLayout(SLICE_MODEL);
      const state = find(layout, "state", "Ticket")!;
      const reaction = find(layout, "reaction", "autoAssign")!;
      const dispatchedAction = layout.ns.find(
        (n) => n.type === "action" && n.key.includes("dispatched")
      )!;

      const dispatchedBottom = Math.max(
        ...layout.ns
          .filter((n) => n.key.includes("dispatched"))
          .map((n) => n.pos.y + (n.type === "state" ? STATE_H : H))
      );

      const stateCenter = state.pos.y + STATE_H / 2;
      expect(stateCenter).toBeLessThan(dispatchedBottom);

      const trigEvent = find(layout, "event", "TicketOpened")!;
      expect(reaction.pos.y).toBeGreaterThanOrEqual(trigEvent.pos.y);

      expect(dispatchedAction.pos.x).toBeGreaterThan(reaction.pos.x + W);
    });

    it("centers state vertically relative to actions/events in a slice (no reactions)", () => {
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

  describe("no overlapping nodes in slices", () => {
    it("has no overlapping nodes in a slice model with reactions", () => {
      const layout = computeLayout(SLICE_MODEL);
      assertNoOverlaps(layout);
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
      expect(box.x).toBe(PAD - GAP / 2);
    });
  });

  describe("dashed edges for reactions", () => {
    it("creates dashed edges for reaction arrows", () => {
      const layout = computeLayout(SLICE_MODEL);
      const dashedEdges = layout.es.filter((e) => e.dash);
      expect(dashedEdges.length).toBeGreaterThanOrEqual(1);
      for (const e of dashedEdges) {
        expect(e.from.x).toBeLessThan(e.to.x);
      }
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

      expect(Math.abs(reactionCenter - stateCenter)).toBeLessThan(1);
    });

    it("watermark pushes second reaction down when chains would overlap", () => {
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

      // Second reaction is pushed down (watermark)
      expect(r2.pos.y).toBeGreaterThanOrEqual(e2.pos.y);

      // The two dispatched state blocks must not overlap
      const dStates = layout.ns.filter(
        (n) => n.type === "state" && n.key.includes("dispatched")
      );
      expect(dStates).toHaveLength(2);
      const [ds1, ds2] = dStates.sort((a, b) => a.pos.y - b.pos.y);
      expect(ds2.pos.y).toBeGreaterThanOrEqual(ds1.pos.y + STATE_H);
    });

    it("states are always square (STATE_W x STATE_H)", () => {
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

      const r1 = find(layout, "reaction", "r1");
      const r2 = find(layout, "reaction", "r2");
      expect(r1).toBeDefined();
      expect(r2).toBeDefined();

      // r2 should be further right than r1 (deeper nesting)
      expect(r2!.pos.x).toBeGreaterThan(r1!.pos.x);

      const dispatched = layout.ns.filter((n) => n.key.includes("dispatched"));
      expect(dispatched.length).toBeGreaterThanOrEqual(4);
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

      const stateNodes = layout.ns.filter(
        (n) => n.type === "state" && n.label === "Ticket"
      );
      expect(stateNodes).toHaveLength(1);

      const actionNodes = layout.ns.filter((n) => n.type === "action");
      const actionNames = actionNodes.map((n) => n.label);
      expect(actionNames).toContain("OpenTicket");
      expect(actionNames).toContain("AssignTicket");

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
              {
                event: "EvtA",
                handlerName: "autoDoB",
                dispatches: ["doB"],
                isVoid: false,
              },
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
      const dispatched = layout.ns.filter((n) => n.key.includes("dispatched"));
      expect(dispatched).toHaveLength(0);
    });
  });

  describe("multi-dispatch reaction chain", () => {
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
                dispatches: ["A2", "A3"],
                isVoid: false,
              },
            ],
          },
        ],
      });
      const layout = computeLayout(model);
      const dispatched = layout.ns.filter(
        (n) => n.type === "action" && n.key.includes("dispatched")
      );
      expect(dispatched.length).toBe(2);
    });
  });

  describe("dispatched action with invariants", () => {
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

  describe("dispatched chain without target state", () => {
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
                dispatches: ["UnknownAction"],
                isVoid: false,
              },
            ],
          },
        ],
      });
      const layout = computeLayout(model);
      const reaction = find(layout, "reaction", "r1");
      expect(reaction).toBeDefined();
      const dispatched = layout.ns.find(
        (n) => n.type === "action" && n.key.includes("dispatched")
      );
      expect(dispatched).toBeDefined();
      const dispatchedState = layout.ns.find(
        (n) => n.type === "state" && n.key.includes("dispatched")
      );
      expect(dispatchedState).toBeUndefined();
    });
  });

  describe("state with file property in slice", () => {
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

  describe("state with no events and no actions in slice", () => {
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
      const state = find(layout, "state", "Empty");
      expect(state).toBeDefined();
    });
  });

  describe("orphan events in slices", () => {
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
      const emittedEvt = find(layout, "event", "EmittedEvt");
      const orphanEvt = find(layout, "event", "OrphanEvt");
      expect(emittedEvt).toBeDefined();
      expect(orphanEvt).toBeDefined();
      expect(orphanEvt!.pos.y).toBeGreaterThan(emittedEvt!.pos.y);
    });
  });

  describe("remaining reaction edge when trigger event exists", () => {
    it("creates edge from trigger event to both inline reactions on same event", () => {
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
      const first = find(layout, "reaction", "firstHandler");
      const second = find(layout, "reaction", "secondHandler");
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      // Both reactions should have dashed edges from the event
      const dashedEdges = layout.es.filter((e) => e.dash);
      const edgeToFirst = dashedEdges.find(
        (e) => e.to.x === first!.pos.x && e.to.y === first!.pos.y + H / 2
      );
      const edgeToSecond = dashedEdges.find(
        (e) => e.to.x === second!.pos.x && e.to.y === second!.pos.y + H / 2
      );
      expect(edgeToFirst).toBeDefined();
      expect(edgeToSecond).toBeDefined();
    });

    it("places remaining reaction without edge when event is not in any state", () => {
      // Reaction triggers on "UnknownEvt" which is not declared in any state.
      // No event node exists, so trigNode is null and no edge is created.
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
                event: "UnknownEvt",
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
      // No event node for UnknownEvt, so no dashed edge to reaction
      const dashedToReaction = layout.es.filter(
        (e) =>
          e.dash &&
          e.to.x === reaction!.pos.x &&
          e.to.y === reaction!.pos.y + H / 2
      );
      expect(dashedToReaction).toHaveLength(0);
    });
  });

  describe("multiple reactions with dispatches on same event", () => {
    it("places all dispatched actions inline for multi-reaction events", () => {
      const model = emptyModel({
        states: [
          {
            name: "S",
            varName: "S",
            events: [
              { name: "Archived", hasCustomPatch: false },
              { name: "Reviewed", hasCustomPatch: false },
              { name: "Notified", hasCustomPatch: false },
              { name: "Logged", hasCustomPatch: false },
            ],
            actions: [
              { name: "Archive", emits: ["Archived"], invariants: [] },
              { name: "Review", emits: ["Reviewed"], invariants: [] },
              { name: "Notify", emits: ["Notified"], invariants: [] },
              { name: "Log", emits: ["Logged"], invariants: [] },
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
                event: "Archived",
                handlerName: "autoReview",
                dispatches: ["Review"],
                isVoid: false,
              },
              {
                event: "Archived",
                handlerName: "notifyOnArchive",
                dispatches: ["Notify"],
                isVoid: false,
              },
              {
                event: "Archived",
                handlerName: "logOnArchive",
                dispatches: ["Log"],
                isVoid: false,
              },
            ],
          },
        ],
      });
      const layout = computeLayout(model);

      // All three reactions should be placed
      const r1 = find(layout, "reaction", "autoReview");
      const r2 = find(layout, "reaction", "notifyOnArchive");
      const r3 = find(layout, "reaction", "logOnArchive");
      expect(r1).toBeDefined();
      expect(r2).toBeDefined();
      expect(r3).toBeDefined();

      // All three dispatched actions should be placed inline (as dispatched copies)
      const dispatched = layout.ns.filter(
        (n) => n.type === "action" && n.key.includes("dispatched")
      );
      const dispatchedNames = dispatched.map((n) => n.label);
      expect(dispatchedNames).toContain("Review");
      expect(dispatchedNames).toContain("Notify");
      expect(dispatchedNames).toContain("Log");

      // Reactions should not overlap each other
      for (const [a, b] of [
        [r1!, r2!],
        [r2!, r3!],
        [r1!, r3!],
      ]) {
        expect(overlaps(nodeBBox(a), nodeBBox(b))).toBe(false);
      }
    });
  });

  describe("shared event emitted by multiple actions", () => {
    it("measures reactions only once when event appears in multiple action rows", () => {
      const model = emptyModel({
        states: [
          {
            name: "S",
            varName: "S",
            events: [{ name: "Evt", hasCustomPatch: false }],
            actions: [
              { name: "a1", emits: ["Evt"], invariants: [] },
              { name: "a2", emits: ["Evt"], invariants: [] },
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
                event: "Evt",
                handlerName: "handler",
                dispatches: [],
                isVoid: false,
              },
            ],
          },
        ],
      });
      const layout = computeLayout(model);
      // Reaction should appear exactly once even though Evt is in two action rows
      const reactions = layout.ns.filter(
        (n) => n.type === "reaction" && n.label === "handler"
      );
      expect(reactions).toHaveLength(1);
    });
  });

  describe("duplicate projection dedup in slice", () => {
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
            handles: ["E1", "E2"],
          },
        ],
      });
      const layout = computeLayout(model);
      const projNodes = layout.ns.filter((n) => n.type === "projection");
      expect(projNodes).toHaveLength(1);
      expect(projNodes[0].label).toBe("shared");
    });
  });
});
