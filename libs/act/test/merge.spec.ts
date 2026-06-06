import { merge_event_register } from "../src/internal/merge.js";

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

  it("uses last-write-wins for same reaction name on the same event", () => {
    const target = {
      E: { reactions: new Map<string, unknown>([["dup", "old"]]) },
    };
    const source = {
      E: { reactions: new Map<string, unknown>([["dup", "new"]]) },
    };
    merge_event_register(target, source);
    expect(target.E.reactions.get("dup")).toBe("new");
  });
});
