import { describe, expect, it } from "vitest";
import { BroadcastChannel } from "../../src/sse/broadcast.js";
import type { BroadcastState, PatchMessage } from "../../src/sse/types.js";

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
    expect(Object.keys(msgs[0])).toHaveLength(0);
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
    expect(bc.state("s1")).toBeUndefined();

    bc.publish("s1", makeState(3, { name: "cached" }));
    const cached = bc.state("s1");
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
    expect(msgs).toHaveLength(1);
  });

  it("tracks subscriber count", () => {
    const bc = new BroadcastChannel<TestState>();
    expect(bc.subscriberCount("s1")).toBe(0);

    const c1 = bc.subscribe("s1", () => {});
    const c2 = bc.subscribe("s1", () => {});
    expect(bc.subscriberCount("s1")).toBe(2);

    c1();
    expect(bc.subscriberCount("s1")).toBe(1);

    c2();
    expect(bc.subscriberCount("s1")).toBe(0);
  });

  it("overlay sends patch for same-version changes", () => {
    const bc = new BroadcastChannel<TestState>();
    bc.publish("s1", makeState(5, { name: "original" }));

    const msgs: PatchMessage<TestState>[] = [];
    bc.subscribe("s1", (m) => msgs.push(m));
    bc.overlay("s1", { name: "overlayed" });

    expect(msgs).toHaveLength(1);
    expect(msgs[0][5]).toEqual({ name: "overlayed" });
  });

  it("overlay returns undefined when no cached state", () => {
    const bc = new BroadcastChannel<TestState>();
    const result = bc.overlay("missing", { name: "x" });
    expect(result).toBeUndefined();
  });

  it("overlay updates cache", () => {
    const bc = new BroadcastChannel<TestState>();
    bc.publish("s1", makeState(5, { name: "original" }));
    bc.overlay("s1", { name: "changed" });
    expect(bc.state("s1")?.name).toBe("changed");
  });

  it("exposes cache accessor", () => {
    const bc = new BroadcastChannel<TestState>();
    bc.publish("s1", makeState(1));
    expect(bc.cache.get("s1")?._v).toBe(1);
    const entries = [...bc.cache.entries()];
    expect(entries).toHaveLength(1);
    expect(entries[0][0]).toBe("s1");
  });

  describe("deprecated snake_case aliases", () => {
    it("publish_overlay delegates to overlay (same cache state)", () => {
      const bc = new BroadcastChannel<TestState>();
      bc.publish("s1", makeState(5, { name: "original" }));

      const msgs: PatchMessage<TestState>[] = [];
      bc.subscribe("s1", (m) => msgs.push(m));
      const msg = bc.publish_overlay("s1", { name: "overlayed" });

      expect(msg).toEqual({ 5: { name: "overlayed" }, _overlay: true });
      expect(msgs).toHaveLength(1);
      expect(bc.state("s1")?.name).toBe("overlayed");
      expect(bc.publish_overlay("missing", { name: "x" })).toBeUndefined();
    });

    it("get_state delegates to state", () => {
      const bc = new BroadcastChannel<TestState>();
      expect(bc.get_state("s1")).toBeUndefined();
      bc.publish("s1", makeState(3, { name: "cached" }));
      expect(bc.get_state("s1")).toBe(bc.state("s1"));
      expect(bc.get_state("s1")?._v).toBe(3);
    });

    it("get_subscriber_count delegates to subscriberCount", () => {
      const bc = new BroadcastChannel<TestState>();
      expect(bc.get_subscriber_count("s1")).toBe(0);
      const cleanup = bc.subscribe("s1", () => {});
      expect(bc.get_subscriber_count("s1")).toBe(1);
      expect(bc.get_subscriber_count("s1")).toBe(bc.subscriberCount("s1"));
      cleanup();
      expect(bc.get_subscriber_count("s1")).toBe(0);
    });

    it("constructor accepts deprecated cache_size", () => {
      const bc = new BroadcastChannel<TestState>({ cache_size: 1 });
      bc.publish("s1", makeState(1));
      bc.publish("s2", makeState(1));
      expect(bc.state("s1")).toBeUndefined(); // evicted at capacity 1
      expect(bc.state("s2")?._v).toBe(1);
    });

    it("cacheSize wins when both cacheSize and cache_size are given", () => {
      const bc = new BroadcastChannel<TestState>({
        cacheSize: 2,
        cache_size: 1,
      });
      bc.publish("s1", makeState(1));
      bc.publish("s2", makeState(1));
      expect(bc.state("s1")?._v).toBe(1); // capacity 2 — nothing evicted
      expect(bc.state("s2")?._v).toBe(1);
    });
  });

  it("respects cacheSize option", () => {
    const bc = new BroadcastChannel<TestState>({ cacheSize: 1 });
    bc.publish("s1", makeState(1));
    bc.publish("s2", makeState(1));
    expect(bc.state("s1")).toBeUndefined(); // evicted at capacity 1
    expect(bc.state("s2")?._v).toBe(1);
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
