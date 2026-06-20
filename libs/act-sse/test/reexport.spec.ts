import { describe, expect, it } from "vitest";
import * as sse from "../src/index.js";

/**
 * ACT-981: @rotorsoft/act-sse is a deprecated re-export shim over
 * @rotorsoft/act-http/sse (the canonical home). The implementation and its
 * behavioral tests live in libs/act-http; this only guards that the shim
 * keeps re-exporting the full public surface so existing imports of the
 * deprecated package keep working.
 */
describe("act-sse deprecated re-export shim", () => {
  it("re-exports the act-http/sse public surface", () => {
    expect(typeof sse.BroadcastChannel).toBe("function");
    expect(typeof sse.PresenceTracker).toBe("function");
    expect(typeof sse.StateCache).toBe("function");
    expect(typeof sse.applyPatchMessage).toBe("function");
    expect(typeof sse.patch).toBe("function");
  });
});
