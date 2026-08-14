import { describe, expect, it } from "vitest";
import { applyPatchMessage } from "../../src/sse/apply-patch.js";
import { BroadcastChannel } from "../../src/sse/broadcast.js";
import type { BroadcastState, PatchMessage } from "../../src/sse/types.js";

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

  describe("genesis event (version 0) — #1346", () => {
    it("applies the genesis patch from init for a fresh client (no baseline)", () => {
      const msg: PatchMessage<TestState> = {
        0: { name: "born", count: 1 },
      };
      const result = applyPatchMessage(msg, null);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.state._v).toBe(0);
        expect(result.state.name).toBe("born");
        expect(result.state.count).toBe(1);
      }
    });

    it("round-trips broadcast.publish genesis → apply for a fresh client", () => {
      const bc = new BroadcastChannel<TestState>();
      // Genesis commit: first event version 0, one domain patch.
      const msg = bc.publish("s1", { _v: 0, name: "g", count: 1 }, [
        { name: "g", count: 1 },
      ]);
      expect(Object.keys(msg)).toEqual(["0"]); // key is version 0

      const result = applyPatchMessage(msg, null);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.state.count).toBe(1);
    });

    it("treats a re-sent genesis as stale for a client already at version 0", () => {
      const cached: TestState = { _v: 0, name: "have-it", count: 1 };
      const msg: PatchMessage<TestState> = { 0: { count: 999 } };
      const result = applyPatchMessage(msg, cached);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("stale");
    });

    it("treats a version-1 first patch with no baseline as behind (can't build from init)", () => {
      const msg: PatchMessage<TestState> = { 1: { count: 1 } };
      const result = applyPatchMessage(msg, null);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("behind");
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
        2: { count: 999 },
        3: { name: "v3" },
      };
      const result = applyPatchMessage(msg, cached);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.state._v).toBe(3);
        expect(result.state.count).toBe(10);
        expect(result.state.name).toBe("v3");
      }
    });
  });

  describe("overlay patches (ACT-1312)", () => {
    it("merges a marked overlay at the current version, keeping _v", () => {
      const cached: TestState = { _v: 5, name: "original", count: 3 };
      const msg: PatchMessage<TestState> = {
        5: { name: "overlayed" },
        _overlay: true,
      };
      const result = applyPatchMessage(msg, cached);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.state._v).toBe(5); // version unchanged
        expect(result.state.name).toBe("overlayed"); // overlay applied
        expect(result.state.count).toBe(3); // untouched field preserved
      }
    });

    it("still treats a same-version patch WITHOUT the marker as stale", () => {
      const cached: TestState = { _v: 5, name: "original", count: 0 };
      const msg: PatchMessage<TestState> = { 5: { name: "no-marker" } };
      const result = applyPatchMessage(msg, cached);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("stale");
    });

    it("treats an older overlay as stale", () => {
      const cached: TestState = { _v: 5, name: "ahead", count: 0 };
      const msg: PatchMessage<TestState> = {
        3: { name: "old-overlay" },
        _overlay: true,
      };
      const result = applyPatchMessage(msg, cached);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("stale");
    });

    it("treats an overlay ahead of the client as behind (must resync)", () => {
      const cached: TestState = { _v: 2, name: "lagging", count: 0 };
      const msg: PatchMessage<TestState> = {
        5: { name: "future-overlay" },
        _overlay: true,
      };
      const result = applyPatchMessage(msg, cached);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("behind");
    });

    it("treats an overlay with no cached baseline as behind (needs baseline)", () => {
      const msg: PatchMessage<TestState> = {
        5: { name: "overlay" },
        _overlay: true,
      };
      const result = applyPatchMessage(msg, null);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("behind");
    });

    it("round-trips overlay() → applyPatchMessage for a live caught-up client", () => {
      const bc = new BroadcastChannel<TestState>();
      // Seat a caught-up client at _v=5.
      bc.publish("room", { _v: 5, name: "seed", count: 1 }, []);
      const clientCached = bc.state("room");
      expect(clientCached?._v).toBe(5);

      let frame: PatchMessage<TestState> | undefined;
      bc.subscribe("room", (m) => {
        frame = m;
      });
      bc.overlay("room", { name: "alice-online" });
      expect(frame?._overlay).toBe(true);

      const result = applyPatchMessage(frame!, clientCached);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.state.name).toBe("alice-online");
        expect(result.state._v).toBe(5);
        expect(result.state.count).toBe(1);
      }
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

  // Three bugs have come out of the `_overlay` marker interacting with the
  // version gate: #1312 (same-version overlay dropped for caught-up
  // clients), #1346 (genesis version-0 treated as stale), #1419 (overlay at
  // cachedV + 1 folded as that version's domain patch). They are corners of
  // one state space, so pin the whole matrix rather than a case per bug.
  describe("frame kind × version position (#1312/#1346/#1419)", () => {
    const cached = { _v: 4, name: "n", count: 1 } as TestState;

    const overlay = (v: number): PatchMessage<TestState> =>
      ({ [v]: { name: "alice" }, _overlay: true }) as never;
    const ordinary = (v: number): PatchMessage<TestState> =>
      ({ [v]: { count: 2 } }) as never;

    it("overlay, stale (below the baseline) → stale", () => {
      expect(applyPatchMessage(overlay(3), cached)).toMatchObject({
        ok: false,
        reason: "stale",
      });
    });

    it("overlay, caught up → merges and keeps _v", () => {
      const r = applyPatchMessage(overlay(4), cached);
      expect(r.ok).toBe(true);
      expect(r.ok && r.state._v).toBe(4);
      expect(r.ok && (r.state as TestState).name).toBe("alice");
    });

    it("overlay, exactly one ahead → behind (never folded as the patch)", () => {
      // The client missed v5's DOMAIN patch. Adopting the overlay's payload
      // as v5 would mark it caught up while `count` stayed stale, and it
      // would never refetch.
      expect(applyPatchMessage(overlay(5), cached)).toMatchObject({
        ok: false,
        reason: "behind",
      });
    });

    it("overlay, several ahead → behind", () => {
      expect(applyPatchMessage(overlay(9), cached)).toMatchObject({
        ok: false,
        reason: "behind",
      });
    });

    it("overlay with no baseline → behind", () => {
      expect(applyPatchMessage(overlay(0), undefined)).toMatchObject({
        ok: false,
        reason: "behind",
      });
    });

    it("ordinary, stale → stale", () => {
      expect(applyPatchMessage(ordinary(3), cached)).toMatchObject({
        ok: false,
        reason: "stale",
      });
    });

    it("ordinary, at the baseline → stale", () => {
      expect(applyPatchMessage(ordinary(4), cached)).toMatchObject({
        ok: false,
        reason: "stale",
      });
    });

    it("ordinary, exactly one ahead → applies and advances _v", () => {
      const r = applyPatchMessage(ordinary(5), cached);
      expect(r.ok).toBe(true);
      expect(r.ok && r.state._v).toBe(5);
      expect(r.ok && (r.state as TestState).count).toBe(2);
    });

    it("ordinary, several ahead → behind", () => {
      expect(applyPatchMessage(ordinary(9), cached)).toMatchObject({
        ok: false,
        reason: "behind",
      });
    });

    it("ordinary genesis with no baseline → applies", () => {
      const r = applyPatchMessage(ordinary(0), undefined);
      expect(r.ok).toBe(true);
      expect(r.ok && r.state._v).toBe(0);
    });
  });
});

describe("a fresh client is never stale (#1474)", () => {
  it("reports behind, not stale, for an empty frame with no baseline", () => {
    // `stale` is the one answer that does NOT refetch, so returning it to a
    // client with no baseline strands it. Both this module's doc-comment and
    // real-time.md already claimed a fresh client can never be stale.
    expect(applyPatchMessage({}, undefined)).toEqual({
      ok: false,
      reason: "behind",
    });
    expect(applyPatchMessage({}, null)).toEqual({
      ok: false,
      reason: "behind",
    });
  });

  it("still reports stale for an empty frame when a baseline exists", () => {
    expect(applyPatchMessage({}, { _v: 3 })).toEqual({
      ok: false,
      reason: "stale",
    });
  });
});
