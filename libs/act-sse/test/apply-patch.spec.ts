import { describe, expect, it } from "vitest";
import { applyBroadcastMessage } from "../src/apply-patch.js";
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
};

describe("applyBroadcastMessage", () => {
  describe("full state messages", () => {
    it("accepts full state when no cached state", () => {
      const msg: FullStateMessage<TestState> = {
        _type: "full",
        _v: 1,
        name: "hello",
        count: 42,
        serverTime: new Date().toISOString(),
      };
      const result = applyBroadcastMessage(msg, null);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.state._v).toBe(1);
        expect(result.state.name).toBe("hello");
        expect(result.state.count).toBe(42);
        // _type should be stripped
        expect("_type" in result.state).toBe(false);
      }
    });

    it("accepts full state when version >= cached", () => {
      const cached: TestState = { _v: 3, name: "old", count: 0 };
      const msg: FullStateMessage<TestState> = {
        _type: "full",
        _v: 5,
        name: "new",
        count: 10,
        serverTime: new Date().toISOString(),
      };
      const result = applyBroadcastMessage(msg, cached);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.state._v).toBe(5);
    });

    it("rejects stale full state", () => {
      const cached: TestState = { _v: 10, name: "fresh", count: 0 };
      const msg: FullStateMessage<TestState> = {
        _type: "full",
        _v: 8,
        name: "stale",
        count: 0,
        serverTime: new Date().toISOString(),
      };
      const result = applyBroadcastMessage(msg, cached);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("stale");
    });
  });

  describe("patch messages", () => {
    it("applies patch when _baseV matches cached _v", () => {
      // Use BroadcastChannel to generate a real patch
      const bc = new BroadcastChannel<TestState>();
      bc.publish("s1", { _v: 1, name: "before", count: 0 });

      let patchMsg: PatchMessage | null = null;
      bc.subscribe("s1", (m) => {
        if (m._type === "patch") patchMsg = m;
      });
      bc.publish("s1", { _v: 2, name: "after", count: 5 });

      expect(patchMsg).not.toBeNull();
      const cached: TestState = { _v: 1, name: "before", count: 0 };
      const result = applyBroadcastMessage<TestState>(patchMsg!, cached);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.state._v).toBe(2);
        expect(result.state.name).toBe("after");
        expect(result.state.count).toBe(5);
      }
    });

    it("returns stale when client is ahead", () => {
      const msg: PatchMessage = {
        _type: "patch",
        _v: 3,
        _baseV: 2,
        _patch: [{ op: "replace", path: "/count", value: 1 }],
        serverTime: new Date().toISOString(),
      };
      const cached: TestState = { _v: 5, name: "ahead", count: 99 };
      const result = applyBroadcastMessage(msg, cached);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("stale");
    });

    it("returns behind when client missed versions", () => {
      const msg: PatchMessage = {
        _type: "patch",
        _v: 5,
        _baseV: 4,
        _patch: [{ op: "replace", path: "/count", value: 1 }],
        serverTime: new Date().toISOString(),
      };
      const cached: TestState = { _v: 2, name: "behind", count: 0 };
      const result = applyBroadcastMessage(msg, cached);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("behind");
    });

    it("returns behind when no cached state", () => {
      const msg: PatchMessage = {
        _type: "patch",
        _v: 2,
        _baseV: 1,
        _patch: [{ op: "replace", path: "/count", value: 1 }],
        serverTime: new Date().toISOString(),
      };
      const result = applyBroadcastMessage(msg, null);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("behind");
    });

    it("returns behind when _baseV matches but cached is undefined", () => {
      const msg: PatchMessage = {
        _type: "patch",
        _v: 1,
        _baseV: 0,
        _patch: [{ op: "replace", path: "/count", value: 1 }],
        serverTime: new Date().toISOString(),
      };
      // cachedV = 0, _baseV = 0 → match, but no cached state to patch
      const result = applyBroadcastMessage(msg, undefined);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("behind");
    });

    it("returns patch-failed on invalid operations", () => {
      const msg: PatchMessage = {
        _type: "patch",
        _v: 2,
        _baseV: 1,
        _patch: [{ op: "test", path: "/name", value: "wrong" }],
        serverTime: new Date().toISOString(),
      };
      const cached: TestState = { _v: 1, name: "actual", count: 0 };
      const result = applyBroadcastMessage(msg, cached);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("patch-failed");
    });
  });

  describe("round-trip: publish → apply", () => {
    it("full cycle produces identical state", () => {
      const bc = new BroadcastChannel<TestState>();
      const state1: TestState = { _v: 1, name: "start", count: 0 };
      const state2: TestState = { _v: 2, name: "start", count: 10 };

      bc.publish("s1", state1);

      let msg: BroadcastMessage<TestState> | null = null;
      bc.subscribe("s1", (m) => {
        msg = m;
      });
      bc.publish("s1", state2);

      expect(msg).not.toBeNull();
      const result = applyBroadcastMessage<TestState>(msg!, state1);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.state).toEqual(state2);
      }
    });
  });
});
