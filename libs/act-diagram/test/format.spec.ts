import { describe, expect, it } from "vitest";
import {
  build_contract_index,
  type IndexEntry,
} from "../src/cli/contract-index.js";
import {
  format_action,
  format_detail,
  format_event,
  format_matches,
  format_projection,
  format_reaction,
  format_slice,
  format_state,
  format_summary,
} from "../src/cli/format.js";
import type { DomainModel } from "../src/client/types/index.js";

function build_model(): DomainModel {
  return {
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
            schema: "z.object({ id: z.string() })",
          },
          {
            name: "OrderPlaced_v2",
            hasCustomPatch: false,
            line: 14,
            schema: "z.object({ id: z.string(), total: z.number() })",
          },
        ],
        actions: [
          {
            name: "placeOrder",
            emits: ["OrderPlaced", "OrderPlaced_v2"],
            invariants: ["fresh-cart"],
            line: 30,
          },
        ],
      },
      {
        name: "Empty",
        varName: "Empty:1",
        file: "src/empty.ts",
        events: [],
        actions: [],
      },
    ],
    slices: [
      {
        name: "Fulfillment",
        states: ["Order:0"],
        stateVars: ["Order:0"],
        projections: ["OrdersByCustomer"],
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
      {
        name: "Broken",
        states: [],
        stateVars: [],
        projections: [],
        reactions: [],
        error: "could not parse",
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
        handlerName: "auditOldEvent",
        dispatches: [],
      },
    ],
  };
}

const idx = build_contract_index(build_model());

const findEntry = (kind: IndexEntry["kind"], name: string): IndexEntry => {
  const e = idx.entries.find((x) => x.kind === kind && x.name === name);
  if (!e) throw new Error(`no ${kind} ${name}`);
  return e;
};

describe("format_matches", () => {
  it("shows match list with kinds and locations", () => {
    const out = format_matches("order", [
      findEntry("event", "OrderPlaced"),
      findEntry("action", "placeOrder"),
    ]);
    expect(out).toContain("matches (2)");
    expect(out).toContain("event");
    expect(out).toContain("action");
    expect(out).toContain("OrderPlaced");
    expect(out).toContain("src/order.ts:12");
  });

  it("falls back to a no-match message", () => {
    const out = format_matches("nope", []);
    expect(out).toContain('no matches for "nope"');
  });

  it("renders entries without qualifier or location, and unknown kinds", () => {
    const out = format_matches("x", [
      { kind: "bogus" as never, name: "noFrills" },
    ]);
    expect(out).toContain("noFrills");
    // No file path, no `(qualifier)` parens on the entry line.
    expect(out.split("\n").slice(1).join("\n")).not.toContain("(");
  });
});

describe("format_event", () => {
  it("renders schema, producers, consumers, and deprecation", () => {
    const out = format_event(idx, findEntry("event", "OrderPlaced"));
    expect(out).toContain("OrderPlaced");
    expect(out).toContain("z.object({ id: z.string() })");
    expect(out).toContain("status:  deprecated (superseded by OrderPlaced_v2)");
    expect(out).toContain("producers:");
    expect(out).toContain("placeOrder");
    expect(out).toContain("auditOldEvent");
  });

  it("renders the active status for the latest version", () => {
    const out = format_event(idx, findEntry("event", "OrderPlaced_v2"));
    expect(out).toContain("status:  active");
    expect(out).toContain("Fulfillment::reserveStock");
    expect(out).toContain("→ reserve");
    expect(out).toContain("OrdersByCustomer");
  });

  it("omits the on-state line when entry name matches the owner state", () => {
    const m: DomainModel = {
      entries: [],
      states: [
        {
          name: "Same",
          varName: "Same:0",
          file: "s.ts",
          events: [{ name: "Same", hasCustomPatch: false }],
          actions: [],
        },
      ],
      slices: [],
      projections: [],
      reactions: [],
    };
    const i = build_contract_index(m);
    const entry = i.entries.find((e) => e.kind === "event")!;
    const out = format_event(i, entry);
    expect(out).not.toContain("on state: Same");
  });

  it("renders producer file location when state file is present", () => {
    const m: DomainModel = {
      entries: [],
      states: [
        {
          name: "S",
          varName: "S:0",
          file: "src/s.ts",
          events: [{ name: "E", hasCustomPatch: false }],
          actions: [{ name: "a", emits: ["E"], invariants: [], line: 7 }],
        },
      ],
      slices: [],
      projections: [],
      reactions: [],
    };
    const i = build_contract_index(m);
    const entry = i.entries.find((e) => e.kind === "event" && e.name === "E")!;
    const out = format_event(i, entry);
    expect(out).toContain("src/s.ts:7");
  });

  it("omits defined: when entry.file and owning state.file are both absent", () => {
    const m: DomainModel = {
      entries: [],
      states: [
        {
          name: "S",
          varName: "S:0",
          events: [{ name: "Bare", hasCustomPatch: false }],
          actions: [],
        },
      ],
      slices: [],
      projections: [],
      reactions: [],
    };
    const i = build_contract_index(m);
    const entry = i.entries.find((e) => e.kind === "event")!;
    // Wipe entry.file so the `entry.file ?? owning_state?.file` chain falls through.
    const out = format_event(i, { ...entry, file: undefined });
    expect(out).not.toContain("defined:");
  });

  it("renders producers without a file when the state has none", () => {
    const m: DomainModel = {
      entries: [],
      states: [
        {
          name: "S",
          varName: "S:0",
          events: [{ name: "E", hasCustomPatch: false }],
          actions: [{ name: "a", emits: ["E"], invariants: [] }],
        },
      ],
      slices: [],
      projections: [],
      reactions: [],
    };
    const i = build_contract_index(m);
    const entry = i.entries.find((e) => e.kind === "event")!;
    const out = format_event(i, entry);
    // Producer line uses `(on State)` and has no trailing file location.
    expect(out).toMatch(/- a\s+\(on S\)\s*$/m);
  });

  it("renders an event entry that doesn't match any state in the model", () => {
    const out = format_event(idx, {
      kind: "event",
      name: "PhantomEvent",
    });
    // No owning state found → no schema, no producers/consumers — just the
    // header, status, and (none) lines.
    expect(out).toContain("PhantomEvent");
    expect(out).toContain("(not captured)");
    expect(out).toContain("status:  active");
    expect(out).toContain("producers: (none)");
    expect(out).toContain("consumers: (none)");
  });

  it("notes when neither schema nor consumers/producers exist", () => {
    const lonely: DomainModel = {
      entries: [],
      states: [
        {
          name: "Lonely",
          varName: "Lonely:0",
          file: "src/l.ts",
          events: [{ name: "Lone", hasCustomPatch: false }],
          actions: [],
        },
      ],
      slices: [],
      projections: [],
      reactions: [],
    };
    const lonelyIdx = build_contract_index(lonely);
    const entry = lonelyIdx.entries.find((e) => e.name === "Lone")!;
    const out = format_event(lonelyIdx, entry);
    expect(out).toContain("(not captured)");
    expect(out).toContain("producers: (none)");
    expect(out).toContain("consumers: (none)");
  });
});

describe("format_action", () => {
  it("shows owning state, invariants, and emits", () => {
    const out = format_action(idx, findEntry("action", "placeOrder"));
    expect(out).toContain("placeOrder");
    expect(out).toContain("on:      Order");
    expect(out).toContain("- fresh-cart");
    expect(out).toContain("OrderPlaced");
    expect(out).toContain("OrderPlaced_v2");
  });

  it("formats an action even when its qualifier doesn't match any state", () => {
    const out = format_action(idx, {
      kind: "action",
      name: "placeOrder",
      qualifier: "Nonexistent",
    });
    // Loop short-circuits via `continue`, action stays undefined,
    // header still renders.
    expect(out).toContain("placeOrder");
    expect(out).toContain("on:      Nonexistent");
  });

  it("renders bare action header when state lookup misses", () => {
    const out = format_action(idx, { kind: "action", name: "ghost" });
    expect(out).toBe("ghost");
  });

  it("finds an action with no owner qualifier by scanning every state", () => {
    const m: DomainModel = {
      entries: [],
      states: [
        {
          name: "First",
          varName: "First:0",
          file: "a.ts",
          events: [],
          actions: [],
        },
        {
          name: "Second",
          varName: "Second:1",
          file: "b.ts",
          events: [],
          actions: [{ name: "act1", emits: [], invariants: [] }],
        },
      ],
      slices: [],
      projections: [],
      reactions: [],
    };
    const i = build_contract_index(m);
    // Strip qualifier so the formatter falls through the every-state loop.
    const entry = {
      ...i.entries.find((e) => e.kind === "action")!,
      qualifier: undefined,
    };
    const out = format_action(i, entry);
    expect(out).toContain("act1");
    expect(out).toContain("b.ts");
    expect(out).not.toContain("on state:");
  });

  it("falls back to entry.line when action.line is missing", () => {
    const m: DomainModel = {
      entries: [],
      states: [
        {
          name: "S",
          varName: "S:0",
          file: "src/s.ts",
          events: [],
          actions: [{ name: "actNoLine", emits: [], invariants: [] }],
        },
      ],
      slices: [],
      projections: [],
      reactions: [],
    };
    const i = build_contract_index(m);
    const entry = { ...i.entries.find((e) => e.kind === "action")!, line: 42 };
    const out = format_action(i, entry);
    expect(out).toContain("src/s.ts:42");
  });

  it("handles actions with no emits", () => {
    const noEmit: DomainModel = {
      entries: [],
      states: [
        {
          name: "S",
          varName: "S:0",
          file: "s.ts",
          events: [],
          actions: [{ name: "noop", emits: [], invariants: [] }],
        },
      ],
      slices: [],
      projections: [],
      reactions: [],
    };
    const i = build_contract_index(noEmit);
    const entry = i.entries.find((e) => e.name === "noop")!;
    const out = format_action(i, entry);
    expect(out).toContain("emits:   (none)");
  });
});

describe("format_state", () => {
  it("lists actions and events with schemas", () => {
    const out = format_state(idx, findEntry("state", "Order"));
    expect(out).toContain("Order");
    expect(out).toContain("placeOrder → OrderPlaced, OrderPlaced_v2");
    expect(out).toContain("z.object({ id: z.string(), total: z.number() })");
  });

  it("handles a state with no actions or events", () => {
    const out = format_state(idx, findEntry("state", "Empty"));
    expect(out).toContain("Empty");
    expect(out).not.toContain("actions:");
  });

  it("renders only the header when state lookup misses", () => {
    const out = format_state(idx, { kind: "state", name: "Phantom" });
    expect(out).toBe("Phantom");
  });

  it("lists actions with no emits and events with no schema", () => {
    const m: DomainModel = {
      entries: [],
      states: [
        {
          name: "S",
          varName: "S:0",
          file: "src/s.ts",
          line: 1,
          events: [{ name: "EvA", hasCustomPatch: false }],
          actions: [{ name: "act1", emits: [], invariants: [] }],
        },
      ],
      slices: [],
      projections: [],
      reactions: [],
    };
    const i = build_contract_index(m);
    const entry = i.entries.find((e) => e.kind === "state")!;
    const out = format_state(i, entry);
    expect(out).toContain("- act1");
    expect(out).not.toContain("act1 →");
    expect(out).toContain("- EvA");
  });
});

describe("format_slice", () => {
  it("shows states, projections, and reactions", () => {
    const out = format_slice(idx, findEntry("slice", "Fulfillment"));
    expect(out).toContain("Fulfillment");
    expect(out).toContain("- Order:0");
    expect(out).toContain("- OrdersByCustomer");
    expect(out).toContain("- OrderPlaced_v2 → reserveStock → reserve");
  });

  it("surfaces slice errors", () => {
    const out = format_slice(idx, findEntry("slice", "Broken"));
    expect(out).toContain("error: could not parse");
  });

  it("renders only the header when the slice lookup misses", () => {
    const out = format_slice(idx, { kind: "slice", name: "ghost" });
    expect(out).toBe("ghost");
  });

  it("renders slice reactions without trigger arrow when dispatches is empty", () => {
    const m: DomainModel = {
      entries: [],
      states: [],
      slices: [
        {
          name: "S",
          states: [],
          stateVars: [],
          projections: [],
          reactions: [{ event: "E", handlerName: "h", dispatches: [] }],
        },
      ],
      projections: [],
      reactions: [],
    };
    const i = build_contract_index(m);
    const entry = i.entries.find((e) => e.kind === "slice")!;
    const out = format_slice(i, entry);
    // The event → handler arrow is always present in slice reactions;
    // only the dispatch arrow (` → ${actions.join}`) goes away.
    expect(out).toContain("- E → h");
    // Exactly one arrow on the reaction line (the event→handler one).
    const reactionLine = out.split("\n").find((l) => l.includes("- E → h"))!;
    expect(reactionLine.match(/→/g)).toHaveLength(1);
  });
});

describe("format_projection", () => {
  it("lists handled events", () => {
    const out = format_projection(
      idx,
      findEntry("projection", "OrdersByCustomer")
    );
    expect(out).toContain("OrdersByCustomer");
    expect(out).toContain("OrderPlaced_v2");
  });

  it("renders just the header when the projection lookup misses", () => {
    const out = format_projection(idx, {
      kind: "projection",
      name: "Unknown",
    });
    expect(out).toBe("Unknown");
  });

  it("renders the header alone when handles is empty", () => {
    const empty: DomainModel = {
      entries: [],
      states: [],
      slices: [],
      projections: [{ name: "P", varName: "P", handles: [] }],
      reactions: [],
    };
    const i = build_contract_index(empty);
    const entry = i.entries.find((e) => e.kind === "projection")!;
    const out = format_projection(i, entry);
    expect(out.trim()).toBe("P");
  });
});

describe("format_reaction", () => {
  it("links the reaction to its slice and triggers", () => {
    const reaction = idx.entries.find((e) => e.kind === "reaction")!;
    const out = format_reaction(idx, reaction);
    expect(out).toContain("reserveStock");
    expect(out).toContain("(in Fulfillment)");
    expect(out).toContain("on:      OrderPlaced_v2");
    expect(out).toContain("action reserve");
  });

  it("renders bare reaction details when slice and qualifier are missing", () => {
    const out = format_reaction(idx, {
      kind: "reaction",
      name: "orphan",
    });
    expect(out).toContain("orphan");
    expect(out).not.toContain("in slice:");
    expect(out).not.toContain("on:");
  });

  it("renders defined: line when entry.file is present", () => {
    const out = format_reaction(idx, {
      kind: "reaction",
      name: "alone",
      qualifier: "Slice::Event",
      file: "src/x.ts",
      line: 9,
    });
    expect(out).toContain("in:      src/x.ts:9");
  });

  it("finds an orchestrator-level reaction (model.reactions, not in any slice)", () => {
    const m: DomainModel = {
      entries: [],
      states: [
        {
          name: "S",
          varName: "S:0",
          events: [{ name: "E", hasCustomPatch: false }],
          actions: [{ name: "act1", emits: ["E"], invariants: [] }],
        },
      ],
      slices: [],
      projections: [],
      reactions: [
        {
          event: "E",
          handlerName: "orchHandler",
          dispatches: ["act1"],
          file: "src/orch.ts",
        },
      ],
    };
    const i = build_contract_index(m);
    const entry = i.entries.find((e) => e.kind === "reaction")!;
    const out = format_reaction(i, entry);
    expect(out).toContain("orchHandler");
    expect(out).toContain("on:      E");
    expect(out).toContain("producers (of triggering event)");
    expect(out).toContain("triggers:");
    expect(out).toContain("act1");
  });

  it("omits triggers when reaction has no dispatches", () => {
    const noDispatch: DomainModel = {
      entries: [],
      states: [],
      slices: [
        {
          name: "S",
          states: [],
          stateVars: [],
          projections: [],
          reactions: [{ event: "E", handlerName: "h", dispatches: [] }],
        },
      ],
      projections: [],
      reactions: [],
    };
    const i = build_contract_index(noDispatch);
    const entry = i.entries.find((e) => e.kind === "reaction")!;
    const out = format_reaction(i, entry);
    expect(out).not.toContain("triggers:");
  });
});

describe("format_detail dispatch", () => {
  it("routes to the right formatter per kind", () => {
    const e = findEntry("event", "OrderPlaced");
    const a = findEntry("action", "placeOrder");
    expect(format_detail(idx, e)).toContain("OrderPlaced");
    expect(format_detail(idx, a)).toContain("placeOrder");
  });

  it("returns empty for unknown kinds", () => {
    expect(
      format_detail(idx, { kind: "bogus" as never, name: "x" } as IndexEntry)
    ).toBe("");
  });
});

describe("format_summary", () => {
  it("summarizes counts", () => {
    expect(format_summary(idx)).toContain("2 states");
    expect(format_summary(idx)).toContain("2 slices");
    expect(format_summary(idx)).toContain("2 events");
  });

  it("uses plural forms for zero or many", () => {
    // The main `idx` has 2 states, 2 slices, 1 projection, 2 events —
    // every length is either 0 or 2+ except projections. Add a model
    // that exercises the plural arm for projections specifically.
    const many: DomainModel = {
      entries: [],
      states: [],
      slices: [],
      projections: [
        { name: "A", varName: "A", handles: [] },
        { name: "B", varName: "B", handles: [] },
      ],
      reactions: [],
    };
    const i = build_contract_index(many);
    expect(format_summary(i)).toContain("2 projections");
  });

  it("singularizes counts of 1", () => {
    const tiny: DomainModel = {
      entries: [],
      states: [
        {
          name: "S",
          varName: "S:0",
          events: [{ name: "E", hasCustomPatch: false }],
          actions: [],
        },
      ],
      slices: [
        {
          name: "OnlySlice",
          states: [],
          stateVars: [],
          projections: [],
          reactions: [],
        },
      ],
      projections: [{ name: "P", varName: "P", handles: [] }],
      reactions: [],
    };
    const i = build_contract_index(tiny);
    const out = format_summary(i);
    expect(out).toContain("1 state,");
    expect(out).toContain("1 slice,");
    expect(out).toContain("1 projection,");
    expect(out).toContain("1 event");
  });
});
