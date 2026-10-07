import { z } from "zod";
import { classify_registry } from "../src/builders/build-classify.js";
import { act, projection, slice, state, ZodEmpty } from "../src/index.js";

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
    expect(c.reactive_events.size).toBe(0);
    expect(c.event_to_state.get("Incremented")?.name).toBe("Counter");
    expect(c.event_to_state.get("Decremented")?.name).toBe("Counter");
  });

  it("skips dynamic targets in static_targets", () => {
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
    expect(c.static_targets).toEqual([]);
    expect(c.reactive_events.has("Incremented")).toBe(true);
    expect(c.reactive_events.has("Decremented")).toBe(false);
  });

  it("dedupes static targets by target", () => {
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
    expect(c.reactive_events.has("Incremented")).toBe(true);
    expect(c.reactive_events.has("Decremented")).toBe(true);
  });

  it("collapses same-target reactions from different sources, keeping the max priority", () => {
    // A subscription row is keyed by stream, so the batch must carry one
    // entry per target. Two entries would leave the priority merge to the
    // adapter, and a single batched UPDATE cannot do it.
    const app = act()
      .withState(Counter)
      .on("Incremented")
      .do(function reactLow() {
        return Promise.resolve();
      })
      .to({ target: "shared", source: "sA", priority: 1 })
      .on("Incremented")
      .do(function reactHigh() {
        return Promise.resolve();
      })
      .to({ target: "shared", source: "sB", priority: 7 })
      .build() as unknown as {
      registry: Parameters<typeof classify_registry>[0];
      _states: Parameters<typeof classify_registry>[1];
    };
    const c = classify_registry(app.registry, app._states);

    expect(c.static_targets).toEqual([
      { stream: "shared", source: "sA", priority: 7 },
    ]);
  });

  it("keeps the max priority regardless of declaration order", () => {
    const app = act()
      .withState(Counter)
      .on("Incremented")
      .do(function reactHigh2() {
        return Promise.resolve();
      })
      .to({ target: "shared", source: "sA", priority: 7 })
      .on("Incremented")
      .do(function reactLow2() {
        return Promise.resolve();
      })
      .to({ target: "shared", source: "sB", priority: 1 })
      .build() as unknown as {
      registry: Parameters<typeof classify_registry>[0];
      _states: Parameters<typeof classify_registry>[1];
    };
    const c = classify_registry(app.registry, app._states);

    expect(c.static_targets).toEqual([
      { stream: "shared", source: "sA", priority: 7 },
    ]);
  });
});
