import { z } from "zod";
import { act, projection, slice, state, ZodEmpty } from "../src/index.js";
import { classify_registry } from "../src/internal/build-classify.js";

describe("classify_registry", () => {
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
      registry: Parameters<typeof classify_registry>[0];
      _states: Parameters<typeof classify_registry>[1];
    };
    const c = classify_registry(app.registry, app._states);

    expect(c.static_targets).toEqual([]);
    expect(c.has_dynamic_resolvers).toBe(false);
    expect(c.reactive_events.size).toBe(0);
    expect(c.event_to_state.get("Incremented")?.name).toBe("Counter");
    expect(c.event_to_state.get("Decremented")?.name).toBe("Counter");
  });

  it("flags has_dynamic_resolvers and skips dynamic targets in static_targets", () => {
    const app = act()
      .withState(Counter)
      .on("Incremented")
      .do(function handleIncrementedDyn() {
        return Promise.resolve();
      })
      .to((event) => ({ target: `dyn-${event.stream}` }))
      .build() as unknown as {
      registry: Parameters<typeof classify_registry>[0];
      _states: Parameters<typeof classify_registry>[1];
    };
    const c = classify_registry(app.registry, app._states);

    expect(c.has_dynamic_resolvers).toBe(true);
    expect(c.static_targets).toEqual([]);
    expect(c.reactive_events.has("Incremented")).toBe(true);
    expect(c.reactive_events.has("Decremented")).toBe(false);
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
      registry: Parameters<typeof classify_registry>[0];
      _states: Parameters<typeof classify_registry>[1];
    };
    const c = classify_registry(app.registry, app._states);

    expect(c.static_targets).toEqual([
      { stream: "dest", source: undefined, priority: 0 },
    ]);
    expect(c.has_dynamic_resolvers).toBe(false);
    expect(c.reactive_events.has("Incremented")).toBe(true);
    expect(c.reactive_events.has("Decremented")).toBe(true);
  });
});
