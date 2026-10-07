import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  act,
  dispose,
  projection,
  slice,
  state,
  ZodEmpty,
} from "../src/index.js";

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

  /**
   * `Object.freeze` seals the registry's object shape, so a post-build
   * `withState` already threw. But a reaction map is a `Map`, which freezing
   * the containing object does not seal — so `withProjection` quietly mutated
   * an already-classified registry, injecting a reaction that could never run
   * and had never been wrapped with the handler reader that strips
   * `sensitive()` keys (#1710). The latch closes registration at the API.
   */
  describe("registration is closed after build", () => {
    const proj = projection("late")
      .on({ ticked: ZodEmpty })
      .do(function projectLate() {
        return Promise.resolve();
      })
      .build();

    it("every mutating registration method throws", () => {
      const builder = act().withState(counter);
      builder.build();

      for (const call of [
        () => builder.withState(counter),
        () => builder.withSlice(slice().withState(counter).build()),
        () => builder.withProjection(proj as never),
        () => builder.withLane({ name: "late" }),
        () => builder.on("ticked"),
      ])
        expect(call).toThrow(/after build\(\)/);
    });

    it("leaves the classified registry untouched when it refuses", () => {
      // The point of the latch: not just that it throws, but that nothing
      // landed. `withProjection` used to inject into this very map.
      const builder = act().withState(counter);
      const app = builder.build();
      const before = [...app.registry.events.ticked.reactions.keys()];

      expect(() => builder.withProjection(proj as never)).toThrow();
      expect([...app.registry.events.ticked.reactions.keys()]).toEqual(before);
    });

    it("still allows build() to be called repeatedly", () => {
      // The multi-tenant pattern builds once per tenant; that registers
      // nothing and must keep working.
      const builder = act().withState(counter);
      const a = builder.build();
      const b = builder.build();
      expect(a.registry.events.ticked).toBeDefined();
      expect(b.registry.events.ticked).toBeDefined();
    });
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
