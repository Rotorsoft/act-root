import { z } from "zod";
import { merge_event_register, register_state } from "../src/builders/merge.js";
import { state, ZodEmpty } from "../src/index.js";
import type { State } from "../src/types/index.js";

describe("merge_event_register", () => {
  it("merges reactions from source into target for matching event names", () => {
    const target = {
      Incremented: { reactions: new Map<string, unknown>([["a", "fn-a"]]) },
    };
    const source = {
      Incremented: { reactions: new Map<string, unknown>([["b", "fn-b"]]) },
    };
    merge_event_register(target, source);
    expect([...target.Incremented.reactions.entries()]).toEqual([
      ["a", "fn-a"],
      ["b", "fn-b"],
    ]);
  });

  it("skips events from source that aren't registered in target", () => {
    const target = {
      Known: { reactions: new Map<string, unknown>() },
    };
    const source = {
      Known: { reactions: new Map<string, unknown>([["x", "fn-x"]]) },
      Unknown: { reactions: new Map<string, unknown>([["y", "fn-y"]]) },
    };
    merge_event_register(target, source);
    // Known got the reaction
    expect(target.Known.reactions.get("x")).toBe("fn-x");
    // Unknown was skipped — not added to target
    expect("Unknown" in target).toBe(false);
  });

  it("throws on two distinct reactions sharing a name on the same event (ACT-979)", () => {
    const target = {
      E: { reactions: new Map<string, unknown>([["dup", "old"]]) },
    };
    const source = {
      E: { reactions: new Map<string, unknown>([["dup", "new"]]) },
    };
    expect(() => merge_event_register(target, source)).toThrow(
      'Duplicate reaction "dup" for event "E"'
    );
  });

  it("is idempotent when the identical reaction object is re-merged", () => {
    const same = { handler: () => {} };
    const target = {
      E: { reactions: new Map<string, unknown>([["r", same]]) },
    };
    const source = {
      E: { reactions: new Map<string, unknown>([["r", same]]) },
    };
    expect(() => merge_event_register(target, source)).not.toThrow();
    expect(target.E.reactions.get("r")).toBe(same);
  });
});

/**
 * `merge_into_existing` spreads `existing` then re-lists what it merges, so a
 * field missing from that list silently kept the first partial's value (#1645).
 * `register_state` is the entry point, so these drive the merge directly and
 * inspect the resulting `State` — including the `.autocloses(...)` triple,
 * whose two day fields are read off the state by the synthesized reaction and
 * are not exposed on the public registry.
 */
describe("register_state — single-declaration policies (#1645)", () => {
  const Tkt = z.object({ open: z.boolean() });

  const plain = () =>
    state({ Tkt })
      .init(() => ({ open: false }))
      .emits({ Opened: ZodEmpty })
      .patch({ Opened: () => ({ open: true }) })
      .on({ open: ZodEmpty })
      .emit(() => ["Opened", {}])
      .build();

  const plain2 = () =>
    state({ Tkt })
      .init(() => ({ open: false }))
      .emits({ Touched: ZodEmpty })
      .patch({ Touched: () => ({}) })
      .on({ touch: ZodEmpty })
      .emit(() => ["Touched", {}])
      .build();

  const closing = () =>
    state({ Tkt })
      .init(() => ({ open: false }))
      .emits({ Resolved: ZodEmpty })
      .patch({ Resolved: () => ({ open: false }) })
      .on({ resolve: ZodEmpty })
      .emit(() => ["Resolved", {}])
      .snap(() => true)
      .autocloses({ keep: { days: 7 } })
      .build();

  /** Runs the real registration path over two partials, in order. */
  const merge_two = (
    first: State<any, any, any>,
    second: State<any, any, any>
  ): State<any, any, any> => {
    const states = new Map<string, State<any, any, any>>();
    const actions: Record<string, any> = {};
    const events: Record<string, any> = {};
    register_state(first, states, actions, events);
    register_state(second, states, actions, events);
    return states.get("Tkt")!;
  };

  it("keeps the autoclose triple together when the policy is declared second", () => {
    const merged = merge_two(plain(), closing());
    expect(merged.autoclose).toBeTypeOf("function");
    expect(merged.autoclose_keep_days).toBe(7);
  });

  it("keeps the autoclose triple together when the policy is declared first", () => {
    const merged = merge_two(closing(), plain());
    expect(merged.autoclose).toBeTypeOf("function");
    expect(merged.autoclose_keep_days).toBe(7);
  });

  it("leaves the triple undefined when neither partial declared a policy", () => {
    const merged = merge_two(plain(), plain2());
    expect(merged.autoclose).toBeUndefined();
    expect(merged.autoclose_after_days).toBeUndefined();
    expect(merged.autoclose_keep_days).toBeUndefined();
  });

  it("leaves options undefined when neither partial declared any", () => {
    expect(merge_two(plain(), plain2()).options).toBeUndefined();
  });

  it("keeps the same declaration when both partials share one instance", () => {
    // Re-registering the SAME partial (the documented multi-slice case) is
    // not a conflict — `pick_declared` compares by reference.
    const shared = closing();
    const merged = merge_two(shared, shared);
    expect(merged.autoclose_keep_days).toBe(7);
  });
});
