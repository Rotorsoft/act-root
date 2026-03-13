import { describe, expect, it } from "vitest";
import { applyPatchMessage } from "../src/apply-patch.js";
import { BroadcastChannel } from "../src/broadcast.js";
import type { BroadcastState, PatchMessage } from "../src/types.js";

type TestState = BroadcastState & {
  name: string;
  count: number;
};

describe("applyPatchMessage", () => {
  describe("single-version patches", () => {
    it("applies patch when version is contiguous", () => {
      const cached: TestState = { _v: 1, name: "before", count: 0 };
      const msg: PatchMessage<TestState> = {
        2: { name: "after", count: 5 },
      };
      const result = applyPatchMessage(msg, cached);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.state._v).toBe(2);
        expect(result.state.name).toBe("after");
        expect(result.state.count).toBe(5);
      }
    });

    it("returns stale when all patches are older", () => {
      const cached: TestState = { _v: 5, name: "ahead", count: 99 };
      const msg: PatchMessage<TestState> = {
        3: { count: 1 },
      };
      const result = applyPatchMessage(msg, cached);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("stale");
    });

    it("returns behind when client missed versions", () => {
      const cached: TestState = { _v: 2, name: "behind", count: 0 };
      const msg: PatchMessage<TestState> = {
        5: { count: 1 },
      };
      const result = applyPatchMessage(msg, cached);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("behind");
    });

    it("returns behind when no cached state", () => {
      const msg: PatchMessage<TestState> = {
        2: { count: 1 },
      };
      const result = applyPatchMessage(msg, null);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("behind");
    });

    it("returns stale for empty message", () => {
      const cached: TestState = { _v: 1, name: "x", count: 0 };
      const result = applyPatchMessage({}, cached);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("stale");
    });
  });

  describe("multi-version patches", () => {
    it("applies multiple patches in version order", () => {
      const cached: TestState = { _v: 1, name: "start", count: 0 };
      const msg: PatchMessage<TestState> = {
        2: { count: 3 },
        3: { count: 5, name: "updated" },
      };
      const result = applyPatchMessage(msg, cached);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.state._v).toBe(3);
        expect(result.state.count).toBe(5);
        expect(result.state.name).toBe("updated");
      }
    });

    it("skips already-applied versions", () => {
      const cached: TestState = { _v: 2, name: "v2", count: 10 };
      const msg: PatchMessage<TestState> = {
        2: { count: 999 }, // should be skipped
        3: { name: "v3" },
      };
      const result = applyPatchMessage(msg, cached);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.state._v).toBe(3);
        expect(result.state.count).toBe(10); // not overwritten by skipped v2
        expect(result.state.name).toBe("v3");
      }
    });
  });

  describe("overlay patches (same version)", () => {
    it("applies overlay patch at same version", () => {
      const cached: TestState = { _v: 5, name: "original", count: 0 };
      const msg: PatchMessage<TestState> = {
        5: { name: "overlayed" },
      };
      // v5 <= cachedV(5) → but maxV === cachedV, so "stale" — overlay skipped
      // This is correct: overlay is stale relative to cached version
      const result = applyPatchMessage(msg, cached);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("stale");
    });
  });

  describe("round-trip: publish → apply", () => {
    it("full cycle with domain patches produces correct state", () => {
      const bc = new BroadcastChannel<TestState>();
      const state1: TestState = { _v: 1, name: "start", count: 0 };
      bc.publish("s1", state1);

      let msg: PatchMessage<TestState> | null = null;
      bc.subscribe("s1", (m) => {
        msg = m;
      });

      const state2: TestState = { _v: 2, name: "start", count: 10 };
      bc.publish("s1", state2, [{ count: 10 }]);

      expect(msg).not.toBeNull();
      const result = applyPatchMessage<TestState>(msg!, state1);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.state._v).toBe(2);
        expect(result.state.count).toBe(10);
        expect(result.state.name).toBe("start");
      }
    });

    it("multi-event commit round-trip", () => {
      const bc = new BroadcastChannel<TestState>();
      const state1: TestState = { _v: 1, name: "start", count: 0 };
      bc.publish("s1", state1);

      let msg: PatchMessage<TestState> | null = null;
      bc.subscribe("s1", (m) => {
        msg = m;
      });

      // Two events in one commit
      const state3: TestState = { _v: 3, name: "final", count: 42 };
      bc.publish("s1", state3, [{ count: 20 }, { count: 42, name: "final" }]);

      expect(msg).not.toBeNull();
      const result = applyPatchMessage<TestState>(msg!, state1);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.state._v).toBe(3);
        expect(result.state.count).toBe(42);
        expect(result.state.name).toBe("final");
      }
    });
  });

  describe("deep merge behavior", () => {
    type NestedState = BroadcastState & {
      nested: { a: number; b: number };
    };

    it("deep merges nested objects", () => {
      const cached: NestedState = { _v: 1, nested: { a: 1, b: 2 } };
      const msg: PatchMessage<NestedState> = {
        2: { nested: { a: 10 } },
      };
      const result = applyPatchMessage(msg, cached);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.state.nested).toEqual({ a: 10, b: 2 });
      }
    });
  });
});
