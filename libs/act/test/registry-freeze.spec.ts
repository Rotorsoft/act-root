import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { act, dispose, state, ZodEmpty } from "../src/index.js";

/**
 * The registry is complete when the builder finishes: autoclose reactions
 * are synthesized at build time and the containers are frozen, so any
 * later registration or orchestrator-side mutation throws instead of
 * silently diverging from what was classified.
 */
describe("registry freeze", () => {
  const counter = state({ Counter: z.object({ count: z.number() }) })
    .init(() => ({ count: 0 }))
    .emits({ ticked: ZodEmpty })
    .patch({ ticked: () => ({}) })
    .on({ tick: ZodEmpty })
    .emit(() => ["ticked", {}])
    .build();

  const closing = state({ Gate: z.object({ done: z.boolean() }) })
    .init(() => ({ done: false }))
    .emits({ Done: ZodEmpty })
    .patch({ Done: () => ({ done: true }) })
    .on({ finish: ZodEmpty })
    .emit(() => ["Done", {}])
    .autocloses({ is: "Done" })
    .build();

  afterEach(async () => {
    await dispose()();
  });

  it("freezes the registry containers at build", () => {
    const app = act().withState(counter).build();
    expect(Object.isFrozen(app.registry)).toBe(true);
    expect(Object.isFrozen(app.registry.actions)).toBe(true);
    expect(Object.isFrozen(app.registry.events)).toBe(true);
    // Adding an event register post-build throws instead of silently
    // bypassing classification.
    expect(() => {
      (app.registry.events as Record<string, unknown>).Rogue = {};
    }).toThrow(TypeError);
  });

  it("synthesizes the autoclose reaction at build, not construction", () => {
    const app = act().withState(closing).build();
    const register = app.registry.events.Done;
    expect(register.reactions.has("__autoclose_Gate")).toBe(true);
    // Repeat builds share the completed registry — the reaction is
    // synthesized once and survives per-tenant re-builds unchanged.
    const before = register.reactions.get("__autoclose_Gate");
    expect(Object.isFrozen(app.registry)).toBe(true);
    expect(register.reactions.get("__autoclose_Gate")).toBe(before);
  });
});
