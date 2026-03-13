import { describe, expect, it } from "vitest";
import { BroadcastChannel } from "../src/broadcast.js";
import type { BroadcastState, PatchMessage } from "../src/types.js";

type TestState = BroadcastState & {
  name: string;
  count: number;
  items: string[];
};

function makeState(v: number, overrides?: Partial<TestState>): TestState {
  return { _v: v, name: "test", count: 0, items: [], ...overrides };
}

describe("BroadcastChannel", () => {
  it("sends empty patch message on publish with no patches", () => {
    const bc = new BroadcastChannel<TestState>();
    const msgs: PatchMessage<TestState>[] = [];
    bc.subscribe("s1", (m) => msgs.push(m));

    bc.publish("s1", makeState(1));

    expect(msgs).toHaveLength(1);
    expect(Object.keys(msgs[0])).toHaveLength(0); // no patches = empty message
  });

  it("sends version-keyed patches", () => {
    const bc = new BroadcastChannel<TestState>();
    bc.publish("s1", makeState(1, { count: 0 }));

    const msgs: PatchMessage<TestState>[] = [];
    bc.subscribe("s1", (m) => msgs.push(m));
    bc.publish("s1", makeState(2, { count: 1 }), [{ count: 1 }]);

    expect(msgs).toHaveLength(1);
    expect(msgs[0][2]).toEqual({ count: 1 });
  });

  it("sends multiple version keys for multi-event commits", () => {
    const bc = new BroadcastChannel<TestState>();
    bc.publish("s1", makeState(1));

    const msgs: PatchMessage<TestState>[] = [];
    bc.subscribe("s1", (m) => msgs.push(m));
    bc.publish("s1", makeState(3, { count: 5, name: "updated" }), [
      { count: 3 },
      { count: 5, name: "updated" },
    ]);

    expect(msgs).toHaveLength(1);
    expect(msgs[0][2]).toEqual({ count: 3 });
    expect(msgs[0][3]).toEqual({ count: 5, name: "updated" });
  });

  it("caches state for reconnects", () => {
    const bc = new BroadcastChannel<TestState>();
    expect(bc.getState("s1")).toBeUndefined();

    bc.publish("s1", makeState(3, { name: "cached" }));
    const cached = bc.getState("s1");
    expect(cached?._v).toBe(3);
    expect(cached?.name).toBe("cached");
  });

  it("subscribe returns cleanup function", () => {
    const bc = new BroadcastChannel<TestState>();
    const msgs: PatchMessage<TestState>[] = [];
    const cleanup = bc.subscribe("s1", (m) => msgs.push(m));

    bc.publish("s1", makeState(1));
    expect(msgs).toHaveLength(1);

    cleanup();
    bc.publish("s1", makeState(2));
    expect(msgs).toHaveLength(1); // no new messages after cleanup
  });

  it("tracks subscriber count", () => {
    const bc = new BroadcastChannel<TestState>();
    expect(bc.getSubscriberCount("s1")).toBe(0);

    const c1 = bc.subscribe("s1", () => {});
    const c2 = bc.subscribe("s1", () => {});
    expect(bc.getSubscriberCount("s1")).toBe(2);

    c1();
    expect(bc.getSubscriberCount("s1")).toBe(1);

    c2();
    expect(bc.getSubscriberCount("s1")).toBe(0);
  });

  it("publishOverlay sends patch for same-version changes", () => {
    const bc = new BroadcastChannel<TestState>();
    bc.publish("s1", makeState(5, { name: "original" }));

    const msgs: PatchMessage<TestState>[] = [];
    bc.subscribe("s1", (m) => msgs.push(m));
    bc.publishOverlay("s1", { name: "overlayed" });

    expect(msgs).toHaveLength(1);
    expect(msgs[0][5]).toEqual({ name: "overlayed" });
  });

  it("publishOverlay returns undefined when no cached state", () => {
    const bc = new BroadcastChannel<TestState>();
    const result = bc.publishOverlay("missing", { name: "x" });
    expect(result).toBeUndefined();
  });

  it("publishOverlay updates cache", () => {
    const bc = new BroadcastChannel<TestState>();
    bc.publish("s1", makeState(5, { name: "original" }));
    bc.publishOverlay("s1", { name: "changed" });
    expect(bc.getState("s1")?.name).toBe("changed");
  });

  it("exposes cache accessor", () => {
    const bc = new BroadcastChannel<TestState>();
    bc.publish("s1", makeState(1));
    expect(bc.cache.get("s1")?._v).toBe(1);
    const entries = [...bc.cache.entries()];
    expect(entries).toHaveLength(1);
    expect(entries[0][0]).toBe("s1");
  });

  it("isolates streams from each other", () => {
    const bc = new BroadcastChannel<TestState>();
    const msgs1: PatchMessage<TestState>[] = [];
    const msgs2: PatchMessage<TestState>[] = [];

    bc.subscribe("s1", (m) => msgs1.push(m));
    bc.subscribe("s2", (m) => msgs2.push(m));

    bc.publish("s1", makeState(1));
    expect(msgs1).toHaveLength(1);
    expect(msgs2).toHaveLength(0);
  });
});
