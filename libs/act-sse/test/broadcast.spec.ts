import { describe, expect, it } from "vitest";
import { BroadcastChannel } from "../src/broadcast.js";
import type {
  BroadcastMessage,
  BroadcastState,
  FullStateMessage,
  PatchMessage,
} from "../src/types.js";

type TestState = BroadcastState & {
  name: string;
  count: number;
  items: string[];
};

function makeState(v: number, overrides?: Partial<TestState>): TestState {
  return { _v: v, name: "test", count: 0, items: [], ...overrides };
}

describe("BroadcastChannel", () => {
  it("sends full state on first publish (no previous cached)", () => {
    const bc = new BroadcastChannel<TestState>();
    const msgs: BroadcastMessage<TestState>[] = [];
    bc.subscribe("s1", (m) => msgs.push(m));

    bc.publish("s1", makeState(1));

    expect(msgs).toHaveLength(1);
    expect(msgs[0]._type).toBe("full");
    expect((msgs[0] as FullStateMessage<TestState>)._v).toBe(1);
  });

  it("sends patch when diff is small", () => {
    const bc = new BroadcastChannel<TestState>();
    bc.publish("s1", makeState(1, { count: 0 }));

    const msgs: BroadcastMessage<TestState>[] = [];
    bc.subscribe("s1", (m) => msgs.push(m));
    bc.publish("s1", makeState(2, { count: 1 }));

    expect(msgs).toHaveLength(1);
    expect(msgs[0]._type).toBe("patch");
    const patch = msgs[0] as PatchMessage;
    expect(patch._baseV).toBe(1);
    expect(patch._v).toBe(2);
    expect(patch._patch.length).toBeGreaterThan(0);
  });

  it("sends full state when patch exceeds maxPatchOps", () => {
    const bc = new BroadcastChannel<TestState>({ maxPatchOps: 2 });
    bc.publish("s1", makeState(1, { count: 0, name: "a", items: [] }));

    const msgs: BroadcastMessage<TestState>[] = [];
    bc.subscribe("s1", (m) => msgs.push(m));
    // Change 3 fields → 3+ ops, exceeds maxPatchOps=2
    bc.publish("s1", makeState(2, { count: 99, name: "b", items: ["x"] }));

    expect(msgs).toHaveLength(1);
    expect(msgs[0]._type).toBe("full");
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
    const msgs: BroadcastMessage<TestState>[] = [];
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

    const msgs: BroadcastMessage<TestState>[] = [];
    bc.subscribe("s1", (m) => msgs.push(m));
    bc.publishOverlay("s1", makeState(5, { name: "overlayed" }));

    expect(msgs).toHaveLength(1);
    expect(msgs[0]._type).toBe("patch");
    const patch = msgs[0] as PatchMessage;
    expect(patch._baseV).toBe(5);
    expect(patch._v).toBe(5);
  });

  it("publishOverlay returns undefined when no cached state", () => {
    const bc = new BroadcastChannel<TestState>();
    const result = bc.publishOverlay("missing", makeState(1));
    expect(result).toBeUndefined();
  });

  it("publishOverlay works with no subscribers", () => {
    const bc = new BroadcastChannel<TestState>();
    bc.publish("s1", makeState(5, { name: "original" }));
    // No subscribe — exercises the !subs?.size branch in publishOverlay
    const result = bc.publishOverlay("s1", makeState(5, { name: "changed" }));
    expect(result).toBeDefined();
    expect(result!._type).toBe("patch");
  });

  it("sends full state when publishing identical state (zero-diff)", () => {
    const bc = new BroadcastChannel<TestState>();
    const state = makeState(1, { name: "same" });
    bc.publish("s1", state);

    const msgs: BroadcastMessage<TestState>[] = [];
    bc.subscribe("s1", (m) => msgs.push(m));
    bc.publish("s1", { ...state }); // identical content

    expect(msgs).toHaveLength(1);
    expect(msgs[0]._type).toBe("full"); // zero ops → full state fallback
  });

  it("exposes cache accessor", () => {
    const bc = new BroadcastChannel<TestState>();
    bc.publish("s1", makeState(1));
    expect(bc.cache.get("s1")?._v).toBe(1);
    // entries() iteration
    const entries = [...bc.cache.entries()];
    expect(entries).toHaveLength(1);
    expect(entries[0][0]).toBe("s1");
  });

  it("isolates streams from each other", () => {
    const bc = new BroadcastChannel<TestState>();
    const msgs1: BroadcastMessage<TestState>[] = [];
    const msgs2: BroadcastMessage<TestState>[] = [];

    bc.subscribe("s1", (m) => msgs1.push(m));
    bc.subscribe("s2", (m) => msgs2.push(m));

    bc.publish("s1", makeState(1));
    expect(msgs1).toHaveLength(1);
    expect(msgs2).toHaveLength(0);
  });
});
