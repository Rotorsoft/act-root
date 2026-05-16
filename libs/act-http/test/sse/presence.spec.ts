import { describe, expect, it } from "vitest";
import { PresenceTracker } from "../../src/sse/presence.js";

describe("PresenceTracker", () => {
  it("tracks online identities", () => {
    const p = new PresenceTracker();
    expect(p.getOnline("g1").size).toBe(0);
    expect(p.isOnline("g1", "p1")).toBe(false);

    p.add("g1", "p1");
    expect(p.isOnline("g1", "p1")).toBe(true);
    expect(p.getOnline("g1")).toEqual(new Set(["p1"]));

    p.remove("g1", "p1");
    expect(p.isOnline("g1", "p1")).toBe(false);
  });

  it("ref-counts for multi-tab", () => {
    const p = new PresenceTracker();
    p.add("g1", "p1");
    p.add("g1", "p1");

    p.remove("g1", "p1");
    expect(p.isOnline("g1", "p1")).toBe(true);

    p.remove("g1", "p1");
    expect(p.isOnline("g1", "p1")).toBe(false);
  });

  it("isolates streams", () => {
    const p = new PresenceTracker();
    p.add("g1", "p1");
    p.add("g2", "p2");

    expect(p.getOnline("g1")).toEqual(new Set(["p1"]));
    expect(p.getOnline("g2")).toEqual(new Set(["p2"]));
  });

  it("handles remove on empty stream gracefully", () => {
    const p = new PresenceTracker();
    expect(() => p.remove("nope", "nope")).not.toThrow();
  });

  it("handles remove of unknown identity on existing stream", () => {
    const p = new PresenceTracker();
    p.add("g1", "p1");
    p.remove("g1", "p2");
    expect(p.isOnline("g1", "p1")).toBe(true);
    expect(p.isOnline("g1", "p2")).toBe(false);
  });
});
