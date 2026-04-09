import { z } from "zod";
import { act, dispose, projection, slice, state, store } from "../src/index.js";

describe("projection", () => {
  beforeEach(async () => {
    await store().drop();
  });

  afterAll(async () => {
    await dispose()();
  });

  const actor = { id: "a", name: "a" };
  let streamId = 0;
  const nextStream = () => `proj-test-${++streamId}`;

  const Incremented = z.object({ by: z.number() });
  const Labeled = z.object({ label: z.string() });

  const Counter = state({ Counter: z.object({ count: z.number() }) })
    .init(() => ({ count: 0 }))
    .emits({ Incremented })
    .patch({
      Incremented: (event, state) => ({ count: state.count + event.data.by }),
    })
    .on({ increment: z.object({ by: z.number() }) })
    .emit((action) => ["Incremented", { by: action.by }])
    .build();

  it("should build a projection with _tag Projection", () => {
    const p = projection("target")
      .on({ Incremented })
      .do(async function handleIncremented() {})
      .build();

    expect(p._tag).toBe("Projection");
    expect(p.events["Incremented"]).toBeDefined();
    expect(p.events["Incremented"].reactions.size).toBe(1);
  });

  it("should use default target from projection(target)", () => {
    const p = projection("counters")
      .on({ Incremented })
      .do(async function handleIncremented() {})
      .build();

    const [reaction] = [...p.events["Incremented"].reactions.values()];
    expect(reaction.resolver).toEqual({ target: "counters" });
  });

  it("should fall back to _this_ resolver when no default target", () => {
    const p = projection()
      .on({ Incremented })
      .do(async function handleIncremented() {})
      .build();

    const [reaction] = [...p.events["Incremented"].reactions.values()];
    // _this_ is a function resolver
    expect(typeof reaction.resolver).toBe("function");
  });

  it("should allow per-handler .to() to override default target", () => {
    const p = projection("default-target")
      .on({ Incremented })
      .do(async function handleIncremented() {})
      .to("override-target")
      .build();

    const [reaction] = [...p.events["Incremented"].reactions.values()];
    expect(reaction.resolver).toEqual({ target: "override-target" });
  });

  it("should allow per-handler .to() with function resolver", () => {
    const resolver = (event: any) => ({ target: event.stream });
    const p = projection("default-target")
      .on({ Incremented })
      .do(async function handleIncremented() {})
      .to(resolver)
      .build();

    const [reaction] = [...p.events["Incremented"].reactions.values()];
    expect(reaction.resolver).toBe(resolver);
  });

  it("should allow per-handler .void() to override default target", () => {
    const p = projection("default-target")
      .on({ Incremented })
      .do(async function handleIncremented() {})
      .void()
      .build();

    const [reaction] = [...p.events["Incremented"].reactions.values()];

    expect((reaction.resolver as any)({} as any)).toBeUndefined();
  });

  it("should use named handlers as reaction names", () => {
    const p = projection("target")
      .on({ Incremented })
      .do(async function myHandler() {})
      .build();

    const [name] = [...p.events["Incremented"].reactions.keys()];
    expect(name).toBe("myHandler");
  });

  it("should throw for anonymous handlers", () => {
    expect(() =>
      projection("target")
        .on({ Incremented })
        .do(async () => {})
    ).toThrow('Projection handler for "Incremented" must be a named function');
  });

  it("should register multiple event handlers with default target", () => {
    const p = projection("read-model")
      .on({ Incremented })
      .do(async function handleIncremented() {})
      .on({ Labeled })
      .do(async function handleLabeled() {})
      .build();

    expect(p.events["Incremented"]).toBeDefined();
    expect(p.events["Labeled"]).toBeDefined();
    expect(p.events["Incremented"].reactions.size).toBe(1);
    expect(p.events["Labeled"].reactions.size).toBe(1);

    // Both should inherit the default target
    for (const event of ["Incremented", "Labeled"] as const) {
      const [reaction] = [...p.events[event].reactions.values()];
      expect(reaction.resolver).toEqual({ target: "read-model" });
    }
  });

  it("should merge projection reactions into act() via .withState()", async () => {
    const stream = nextStream();
    const projected = vi.fn();

    const CounterProjection = projection("counters")
      .on({ Incremented })
      .do(async function project(event) {
        await Promise.resolve();
        projected(event.data);
      })
      .build();

    const app_ = act()
      .withState(Counter)
      .withProjection(CounterProjection)
      .build();

    await app_.do("increment", { stream, actor }, { by: 5 });
    await app_.correlate();
    await app_.drain();

    expect(projected).toHaveBeenCalledWith({ by: 5 });
  });

  it("should merge projection into act() alongside slices", async () => {
    const stream = nextStream();
    const sliceHandler = vi.fn().mockResolvedValue(undefined);
    const projHandler = vi.fn().mockResolvedValue(undefined);

    const CounterSlice = slice()
      .withState(Counter)
      .on("Incremented")
      .do(sliceHandler)
      .build();

    const CounterProjection = projection("counters")
      .on({ Incremented })
      .do(projHandler)
      .build();

    const app_ = act()
      .withSlice(CounterSlice)
      .withProjection(CounterProjection)
      .build();

    await app_.do("increment", { stream, actor }, { by: 3 });
    await app_.correlate();
    await app_.drain();
    await app_.drain();

    expect(sliceHandler).toHaveBeenCalled();
    expect(projHandler).toHaveBeenCalled();
  });

  it("should register multiple handlers for the same event", () => {
    const p = projection()
      .on({ Incremented })
      .do(async function first() {})
      .to("target-a")
      .on({ Incremented })
      .do(async function second() {})
      .to("target-b")
      .build();

    expect(p.events["Incremented"].reactions.size).toBe(2);
    const names = [...p.events["Incremented"].reactions.keys()];
    expect(names).toContain("first");
    expect(names).toContain("second");
  });

  it("should reject projection with events not in registered states", () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const ExternalEvent = z.object({ source: z.string() });

    const ExternalProjection = projection("external")
      .on({ ExternalEvent })
      .do(handler)
      .build();

    // Projection events must be a subset of app's state events
    const app_ = act()
      .withState(Counter)
      // @ts-expect-error - ExternalEvent is not in Counter's events
      .withProjection(ExternalProjection)
      .build();

    // Runtime still works (constraint is compile-time only)
    const events = app_.registry.events as Record<string, any>;
    expect(events["ExternalEvent"]).toBeDefined();
    expect(events["ExternalEvent"].reactions.size).toBe(1);
  });

  it("should throw when .on() receives multiple keys", () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- intentionally testing invalid input
      projection("target").on({
        A: z.object({}),
        B: z.object({}),
      } as any)
    ).toThrow(".on() requires exactly one key");
  });

  it("should expose .events on projection builder", () => {
    const Foo = z.object({ x: z.number() });
    const b = projection("bar")
      .on({ Foo })
      .do(async function handleFoo() {});
    expect(b.events).toBeDefined();
    expect(b.events["Foo"]).toBeDefined();
    expect(b.events["Foo"].schema).toBeDefined();
  });

  // --- Batch projection tests ---

  it("should build a projection with batch handler", () => {
    const batchFn = vi.fn().mockResolvedValue(undefined);
    const p = projection("target")
      .on({ Incremented })
      .do(async function handleIncremented() {})
      .batch(batchFn)
      .build();

    expect(p._tag).toBe("Projection");
    expect(p.target).toBe("target");
    expect(p.batchHandler).toBe(batchFn);
  });

  it("should not expose .batch() on projections without static target", () => {
    const p = projection()
      .on({ Incremented })
      .do(async function handleIncremented() {});

    expect("batch" in p).toBe(false);
  });

  it("should store target on projection with static target", () => {
    const p = projection("my-target")
      .on({ Incremented })
      .do(async function handleIncremented() {})
      .build();

    expect(p.target).toBe("my-target");
  });

  it("should call batch handler during drain instead of individual handlers", async () => {
    const stream = nextStream();
    const singleHandler = vi.fn().mockResolvedValue(undefined);
    const batchFn = vi.fn().mockResolvedValue(undefined);

    Object.defineProperty(singleHandler, "name", {
      value: "handleIncremented",
    });
    const BatchProjection = projection("batch-proj")
      .on({ Incremented })
      .do(singleHandler)
      .batch(batchFn)
      .build();

    const app_ = act()
      .withState(Counter)
      .withProjection(BatchProjection)
      .build();

    // Emit multiple events
    await app_.do("increment", { stream, actor }, { by: 1 });
    await app_.do("increment", { stream, actor }, { by: 2 });
    await app_.do("increment", { stream, actor }, { by: 3 });
    await app_.correlate();
    await app_.drain({ eventLimit: 100 });

    // Batch handler called once with all events
    expect(batchFn).toHaveBeenCalledTimes(1);
    const [events, target] = batchFn.mock.calls[0];
    expect(target).toBe("batch-proj");
    expect(events).toHaveLength(3);
    expect(events[0].data).toEqual({ by: 1 });
    expect(events[1].data).toEqual({ by: 2 });
    expect(events[2].data).toEqual({ by: 3 });

    // Single handler NOT called (batch takes over)
    expect(singleHandler).not.toHaveBeenCalled();
  });

  it("should call batch handler even for a single event", async () => {
    const stream = nextStream();
    const batchFn = vi.fn().mockResolvedValue(undefined);

    const BatchProjection = projection("batch-single")
      .on({ Incremented })
      .do(async function handleIncremented() {})
      .batch(batchFn)
      .build();

    const app_ = act()
      .withState(Counter)
      .withProjection(BatchProjection)
      .build();

    await app_.do("increment", { stream, actor }, { by: 7 });
    await app_.correlate();
    await app_.drain({ eventLimit: 100 });

    expect(batchFn).toHaveBeenCalledTimes(1);
    const [events] = batchFn.mock.calls[0];
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({ by: 7 });
  });

  it("should handle batch error with handled=0 and retry semantics", async () => {
    const stream = nextStream();
    const batchFn = vi.fn().mockRejectedValue(new Error("batch failed"));

    const BatchProjection = projection("batch-error")
      .on({ Incremented })
      .do(async function handleIncremented() {})
      .batch(batchFn)
      .build();

    const app_ = act()
      .withState(Counter)
      .withProjection(BatchProjection)
      .build();

    await app_.do("increment", { stream, actor }, { by: 1 });
    await app_.correlate();
    const result = await app_.drain({ eventLimit: 100 });

    // Batch failed — nothing acked, error reported
    expect(result.acked).toHaveLength(0);
    expect(batchFn).toHaveBeenCalledTimes(1);
  });

  it("should block batch projection after max retries", async () => {
    const stream = nextStream();
    const batchFn = vi.fn().mockRejectedValue(new Error("permanent failure"));

    const BatchProjection = projection("batch-block")
      .on({ Incremented })
      .do(async function handleIncremented() {})
      .batch(batchFn)
      .build();

    const blocked: Array<{ stream: string; error: string }> = [];
    const app_ = act()
      .withState(Counter)
      .withProjection(BatchProjection)
      .build();
    app_.on("blocked", (b) => blocked.push(...b));

    await app_.do("increment", { stream, actor }, { by: 1 });
    await app_.correlate();

    // Drain with very short lease so retries happen immediately
    // retry increments on each claim: 0→fail, 1→fail, 2→fail, 3→block
    for (let i = 0; i < 5; i++) {
      await app_.drain({ eventLimit: 100, leaseMillis: 1 });
      // Wait for lease to expire between retries
      await new Promise((r) => setTimeout(r, 5));
    }

    // Should have blocked after retries exhausted
    expect(blocked.length).toBeGreaterThanOrEqual(1);
    expect(blocked[0].error).toBe("permanent failure");
  });

  it("should use batch handler from projection embedded in slice", async () => {
    const stream = nextStream();
    const batchFn = vi.fn().mockResolvedValue(undefined);

    const BatchProjection = projection("slice-batch")
      .on({ Incremented })
      .do(async function handleIncremented() {})
      .batch(batchFn)
      .build();

    const CounterSlice = slice()
      .withState(Counter)
      .withProjection(BatchProjection)
      .build();

    const app_ = act().withSlice(CounterSlice).build();

    await app_.do("increment", { stream, actor }, { by: 4 });
    await app_.correlate();
    await app_.drain({ eventLimit: 100 });

    expect(batchFn).toHaveBeenCalledTimes(1);
    const [events] = batchFn.mock.calls[0];
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({ by: 4 });
  });

  it("should handle mixed event types in batch handler", async () => {
    const stream = nextStream();
    const batchFn = vi.fn().mockResolvedValue(undefined);

    const Widget = state({
      Widget: z.object({ count: z.number(), label: z.string() }),
    })
      .init(() => ({ count: 0, label: "" }))
      .emits({ Incremented, Labeled })
      .patch({
        Incremented: (event, s) => ({ ...s, count: s.count + event.data.by }),
        Labeled: (event, s) => ({ ...s, label: event.data.label }),
      })
      .on({ increment: z.object({ by: z.number() }) })
      .emit((a) => ["Incremented", { by: a.by }])
      .on({ label: z.object({ label: z.string() }) })
      .emit((a) => ["Labeled", { label: a.label }])
      .build();

    const MixedProjection = projection("mixed-batch")
      .on({ Incremented })
      .do(async function handleIncremented() {})
      .on({ Labeled })
      .do(async function handleLabeled() {})
      .batch(batchFn)
      .build();

    const app_ = act()
      .withState(Widget)
      .withProjection(MixedProjection)
      .build();

    await app_.do("increment", { stream, actor }, { by: 1 });
    await app_.do("label", { stream, actor }, { label: "hello" });
    await app_.do("increment", { stream, actor }, { by: 2 });
    await app_.correlate();
    await app_.drain({ eventLimit: 100 });

    expect(batchFn).toHaveBeenCalledTimes(1);
    const [events] = batchFn.mock.calls[0];
    expect(events).toHaveLength(3);
    expect(events[0].name).toBe("Incremented");
    expect(events[1].name).toBe("Labeled");
    expect(events[2].name).toBe("Incremented");
  });
});
