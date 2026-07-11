import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDemoActor } from "../src/demo-actor.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("resolveDemoActor (#1225 — demo-only actor)", () => {
  it("returns the fake constant demo actor", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveDemoActor()).toEqual({ id: "1", name: "Calculator" });
    warn.mockRestore();
  });

  it("logs a loud DEMO-ONLY / unauthenticated warning on first use", async () => {
    // Fresh module so the one-time `warned` latch starts unset.
    vi.resetModules();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { resolveDemoActor: fresh } = await import("../src/demo-actor.js");
    fresh();
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0]?.[0]);
    expect(msg).toMatch(/DEMO ONLY/i);
    expect(msg).toMatch(/unauthenticated|verified actor/i);
  });

  it("warns only once across repeated calls (one-time latch)", async () => {
    vi.resetModules();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { resolveDemoActor: fresh } = await import("../src/demo-actor.js");
    fresh();
    fresh();
    fresh();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
