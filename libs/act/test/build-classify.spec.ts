import { z } from "zod";
import { act, projection, slice, state, ZodEmpty } from "../src/index.js";
import { classifyRegistry } from "../src/internal/build-classify.js";

describe("classifyRegistry", () => {
  const Counter = state({ Counter: z.object({ count: z.number() }) })
    .init(() => ({ count: 0 }))
    .emits({ Incremented: ZodEmpty, Decremented: ZodEmpty })
    .patch({
      Incremented: (_, s) => ({ count: s.count + 1 }),
      Decremented: (_, s) => ({ count: s.count - 1 }),
    })
    .on({ increment: ZodEmpty })
    .emit(() => ["Incremented", {}])
    .on({ decrement: ZodEmpty })
    .emit(() => ["Decremented", {}])
    .build();

  function instance() {
    // Reach into the built Act to grab its registry + states map for the
    // classifier — same inputs the constructor uses.
    return act().withState(Counter).build();
  }

  it("returns an empty classification when no reactions are registered", () => {
    const app = instance() as unknown as {
      registry: Parameters<typeof classifyRegistry>[0];
      _states: Parameters<typeof classifyRegistry>[1];
    };
    const c = classifyRegistry(app.registry, app._states);

    expect(c.staticTargets).toEqual([]);
    expect(c.hasDynamicResolvers).toBe(false);
    expect(c.reactiveEvents.size).toBe(0);
    expect(c.eventToState.get("Incremented")?.name).toBe("Counter");
    expect(c.eventToState.get("Decremented")?.name).toBe("Counter");
  });

  it("flags hasDynamicResolvers and skips dynamic targets in staticTargets", () => {
    const app = act()
      .withState(Counter)
      .on("Incremented")
      .do(function handleIncrementedDyn() {
        return Promise.resolve();
      })
      .to((event) => ({ target: `dyn-${event.stream}` }))
      .build() as unknown as {
      registry: Parameters<typeof classifyRegistry>[0];
      _states: Parameters<typeof classifyRegistry>[1];
    };
    const c = classifyRegistry(app.registry, app._states);

    expect(c.hasDynamicResolvers).toBe(true);
    expect(c.staticTargets).toEqual([]);
    expect(c.reactiveEvents.has("Incremented")).toBe(true);
    expect(c.reactiveEvents.has("Decremented")).toBe(false);
  });

  it("dedupes static targets by (target, source)", () => {
    // Two reactions to different events that land on the same projection
    // should yield ONE static target.
    const Proj = projection("dest")
      .on({ Incremented: ZodEmpty })
      .do(function projectIncremented() {
        return Promise.resolve();
      })
      .on({ Decremented: ZodEmpty })
      .do(function projectDecremented() {
        return Promise.resolve();
      })
      .build();
    const TheSlice = slice().withState(Counter).withProjection(Proj).build();
    const app = act().withSlice(TheSlice).build() as unknown as {
      registry: Parameters<typeof classifyRegistry>[0];
      _states: Parameters<typeof classifyRegistry>[1];
    };
    const c = classifyRegistry(app.registry, app._states);

    expect(c.staticTargets).toEqual([{ stream: "dest", source: undefined }]);
    expect(c.hasDynamicResolvers).toBe(false);
    expect(c.reactiveEvents.has("Incremented")).toBe(true);
    expect(c.reactiveEvents.has("Decremented")).toBe(true);
  });
});
