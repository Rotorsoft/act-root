import { z } from "zod";
import {
  act,
  projection,
  slice,
  state,
  store,
  ZodEmpty,
} from "../src/index.js";

describe("slice", () => {
  beforeEach(async () => {
    await store().drop();
  });
  const schema = z.object({
    count: z.number(),
    label: z.string(),
  });

  const PartA = state({ Thing: schema })
    .init(() => ({ count: 0, label: "" }))
    .emits({ Incremented: z.object({ by: z.number() }) })
    .patch({
      Incremented: (event, state) => ({ count: state.count + event.data.by }),
    })
    .on({ increment: z.object({ by: z.number() }) })
    .emit((action) => ["Incremented", { by: action.by }])
    .build();

  const PartB = state({ Thing: schema })
    .init(() => ({ count: 0, label: "" }))
    .emits({ Labeled: z.object({ label: z.string() }) })
    .patch({
      Labeled: (event) => ({ label: event.data.label }),
    })
    .on({ setLabel: z.object({ label: z.string() }) })
    .emit((action) => ["Labeled", { label: action.label }])
    .build();

  const actor = { id: "a", name: "a" };

  // Use unique stream prefixes per test to avoid InMemoryStore collisions
  let streamId = 0;
  const nextStream = () => `slice-test-${++streamId}`;

  it("should build a slice with states and empty reactions", () => {
    const s = slice().with(PartA).build();
    expect(s._tag).toBe("Slice");
    expect(s.states.size).toBe(1);
    expect(s.states.has("Thing")).toBe(true);
    expect(s.events["Incremented"]).toBeDefined();
    expect(s.events["Incremented"].reactions.size).toBe(0);
  });

  it("should register scoped reactions via .on().do().void()", () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const s = slice().with(PartA).on("Incremented").do(handler).void().build();

    expect(s.events["Incremented"].reactions.size).toBe(1);
  });

  it("should generate a reaction name for anonymous handlers", () => {
    const s = slice()
      .with(PartA)
      .on("Incremented")
      .do(async () => {})
      .void()
      .build();

    const [name] = [...s.events["Incremented"].reactions.keys()];
    expect(name).toBe("Incremented_0");
  });

  it("should register scoped reactions via .on().do().to() with string", () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const s = slice()
      .with(PartA)
      .on("Incremented")
      .do(handler)
      .to("target-stream")
      .build();

    expect(s.events["Incremented"].reactions.size).toBe(1);
  });

  it("should register scoped reactions via .on().do().to() with function resolver", () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const resolver = (event: any) => ({ target: event.stream });
    const s = slice()
      .with(PartA)
      .on("Incremented")
      .do(handler)
      .to(resolver)
      .build();

    expect(s.events["Incremented"].reactions.size).toBe(1);
  });

  it("should merge act().with(Slice) states and reactions into act registry", async () => {
    const stream = nextStream();
    const onIncremented = vi.fn().mockResolvedValue(undefined);

    const ThingSlice = slice()
      .with(PartA)
      .on("Incremented")
      .do(onIncremented)
      .build();

    const app = act().with(ThingSlice).with(PartB).build();

    await app.do("increment", { stream, actor }, { by: 3 });
    await app.do("setLabel", { stream, actor }, { label: "hello" });
    await app.correlate();
    await app.drain();

    const snap = await app.load("Thing", stream);
    expect(snap.state.count).toBe(3);
    expect(snap.state.label).toBe("hello");
    expect(onIncremented).toHaveBeenCalled();
  });

  it("should compose multiple slices into act", async () => {
    const stream = nextStream();
    const onIncremented = vi.fn().mockResolvedValue(undefined);
    const onLabeled = vi.fn().mockResolvedValue(undefined);

    const SliceA = slice()
      .with(PartA)
      .on("Incremented")
      .do(onIncremented)
      .build();

    const SliceB = slice().with(PartB).on("Labeled").do(onLabeled).build();

    const app = act().with(SliceA).with(SliceB).build();

    await app.do("increment", { stream, actor }, { by: 1 });
    await app.do("setLabel", { stream, actor }, { label: "test" });
    await app.correlate();
    await app.drain();

    expect(onIncremented).toHaveBeenCalled();
    expect(onLabeled).toHaveBeenCalled();

    const snap = await app.load("Thing", stream);
    expect(snap.state.count).toBe(1);
    expect(snap.state.label).toBe("test");
  });

  it("should merge same-name partial states across slices at act level", async () => {
    const stream = nextStream();

    const CountA = state({ Counter: z.object({ total: z.number() }) })
      .init(() => ({ total: 0 }))
      .emits({ Added: z.object({ n: z.number() }) })
      .patch({ Added: (e, s) => ({ total: s.total + e.data.n }) })
      .on({ add: z.object({ n: z.number() }) })
      .emit((a) => ["Added", { n: a.n }])
      .build();

    const CountB = state({ Counter: z.object({ tag: z.string() }) })
      .init(() => ({ tag: "" }))
      .emits({ Tagged: z.object({ tag: z.string() }) })
      .patch({ Tagged: (e) => ({ tag: e.data.tag }) })
      .on({ tag: z.object({ tag: z.string() }) })
      .emit((a) => ["Tagged", { tag: a.tag }])
      .build();

    const SliceA = slice().with(CountA).build();
    const SliceB = slice().with(CountB).build();

    const app = act().with(SliceA).with(SliceB).build();

    await app.do("add", { stream, actor }, { n: 5 });
    await app.do("tag", { stream, actor }, { tag: "merged" });

    const snap = await app.load("Counter", stream);
    expect(snap.state.total).toBe(5);
    expect(snap.state.tag).toBe("merged");
  });

  it("should detect duplicate actions across slices", () => {
    const S1 = state({ X: z.object({ v: z.number() }) })
      .init(() => ({ v: 0 }))
      .emits({ E1: ZodEmpty })
      .patch({ E1: () => ({}) })
      .on({ doIt: ZodEmpty })
      .emit(() => ["E1", {}])
      .build();

    const S2 = state({ Y: z.object({ w: z.number() }) })
      .init(() => ({ w: 0 }))
      .emits({ E2: ZodEmpty })
      .patch({ E2: () => ({}) })
      .on({ doIt: ZodEmpty })
      .emit(() => ["E2", {}])
      .build();

    const Slice1 = slice().with(S1).build();
    const Slice2 = slice().with(S2).build();

    expect(() => act().with(Slice1).with(Slice2)).toThrow(
      'Duplicate action "doIt"'
    );
  });

  it("should detect duplicate events across slices", () => {
    const S1 = state({ X: z.object({ v: z.number() }) })
      .init(() => ({ v: 0 }))
      .emits({ SameEvent: ZodEmpty })
      .patch({ SameEvent: () => ({}) })
      .on({ doX: ZodEmpty })
      .emit(() => ["SameEvent", {}])
      .build();

    const S2 = state({ Y: z.object({ w: z.number() }) })
      .init(() => ({ w: 0 }))
      .emits({ SameEvent: ZodEmpty })
      .patch({ SameEvent: () => ({}) })
      .on({ doY: ZodEmpty })
      .emit(() => ["SameEvent", {}])
      .build();

    const Slice1 = slice().with(S1).build();
    const Slice2 = slice().with(S2).build();

    expect(() => act().with(Slice1).with(Slice2)).toThrow(
      'Duplicate event "SameEvent"'
    );
  });

  it("should support cross-slice reactions at the act level", async () => {
    const stream = nextStream();

    const Counter = state({ Counter: z.object({ count: z.number() }) })
      .init(() => ({ count: 0 }))
      .emits({ Counted: z.object({ n: z.number() }) })
      .patch({ Counted: (e, s) => ({ count: s.count + e.data.n }) })
      .on({ count: z.object({ n: z.number() }) })
      .emit((a) => ["Counted", { n: a.n }])
      .build();

    const Logger = state({ Log: z.object({ entries: z.number() }) })
      .init(() => ({ entries: 0 }))
      .emits({ Logged: ZodEmpty })
      .patch({ Logged: (_, s) => ({ entries: s.entries + 1 }) })
      .on({ log: ZodEmpty })
      .emit(() => ["Logged", {}])
      .build();

    const CounterSlice = slice().with(Counter).build();
    const LoggerSlice = slice().with(Logger).build();

    // Cross-slice reaction: react to Counter event at act level
    const crossHandler = vi.fn().mockResolvedValue(undefined);
    const app = act()
      .with(CounterSlice)
      .with(LoggerSlice)
      .on("Counted")
      .do(crossHandler)
      .build();

    await app.do("count", { stream, actor }, { n: 1 });
    await app.correlate();
    await app.drain();

    expect(crossHandler).toHaveBeenCalled();
  });

  it("should still support act().with(State) (backward compat)", async () => {
    const stream = nextStream();

    const counter = state({ Counter: z.object({ count: z.number() }) })
      .init(() => ({ count: 0 }))
      .emits({ incremented: ZodEmpty })
      .patch({ incremented: (_, state) => ({ count: state.count + 1 }) })
      .on({ increment: ZodEmpty })
      .emit(() => ["incremented", {}])
      .build();

    const app = act().with(counter).build();
    await app.do("increment", { stream, actor }, {});
    const snap = await app.load(counter, stream);
    expect(snap.state.count).toBe(1);
  });

  it("should support mixing slices and direct states in act()", async () => {
    const counterStream = nextStream();
    const logStream = nextStream();

    const Counter = state({ Counter: z.object({ count: z.number() }) })
      .init(() => ({ count: 0 }))
      .emits({ Counted: z.object({ n: z.number() }) })
      .patch({ Counted: (e, s) => ({ count: s.count + e.data.n }) })
      .on({ count: z.object({ n: z.number() }) })
      .emit((a) => ["Counted", { n: a.n }])
      .build();

    const Logger = state({ Log: z.object({ entries: z.number() }) })
      .init(() => ({ entries: 0 }))
      .emits({ Logged: ZodEmpty })
      .patch({ Logged: (_, s) => ({ entries: s.entries + 1 }) })
      .on({ log: ZodEmpty })
      .emit(() => ["Logged", {}])
      .build();

    const CounterSlice = slice().with(Counter).build();

    // Mix: slice + direct state
    const app = act().with(CounterSlice).with(Logger).build();

    await app.do("count", { stream: counterStream, actor }, { n: 5 });
    await app.do("log", { stream: logStream, actor }, {});

    const counterSnap = await app.load("Counter", counterStream);
    const logSnap = await app.load(Logger, logStream);
    expect(counterSnap.state.count).toBe(5);
    expect(logSnap.state.entries).toBe(1);
  });

  it("should expose .events on slice builder for AsCommitted typing", () => {
    const b = slice().with(PartA);
    // The events property should exist and have the event register
    expect(b.events).toBeDefined();
    expect(b.events["Incremented"]).toBeDefined();
    expect(b.events["Incremented"].schema).toBeDefined();
  });

  it("should compose slices that share the same state", async () => {
    const stream = nextStream();
    const onIncremented = vi.fn().mockResolvedValue(undefined);
    const onLabeled = vi.fn().mockResolvedValue(undefined);

    // SliceA includes both PartA and PartB so its handler can dispatch setLabel
    const SliceA = slice()
      .with(PartA)
      .with(PartB)
      .on("Incremented")
      .do(onIncremented)
      .build();

    // SliceB also includes PartB (shared state) — no conflict at composition
    const SliceB = slice().with(PartB).on("Labeled").do(onLabeled).build();

    const app = act().with(SliceA).with(SliceB).build();

    await app.do("increment", { stream, actor }, { by: 7 });
    await app.do("setLabel", { stream, actor }, { label: "shared" });
    await app.correlate();
    await app.drain();

    expect(onIncremented).toHaveBeenCalled();
    expect(onLabeled).toHaveBeenCalled();

    const snap = await app.load("Thing", stream);
    expect(snap.state.count).toBe(7);
    expect(snap.state.label).toBe("shared");
  });

  it("should merge multiple partials within a single slice", async () => {
    const stream = nextStream();
    const s = slice().with(PartA).with(PartB).build();

    expect(s.states.size).toBe(1); // both are "Thing", merged
    expect(s.events["Incremented"]).toBeDefined();
    expect(s.events["Labeled"]).toBeDefined();

    // Compose into act and verify it works
    const app = act().with(s).build();
    await app.do("increment", { stream, actor }, { by: 2 });
    await app.do("setLabel", { stream, actor }, { label: "merged" });

    const snap = await app.load("Thing", stream);
    expect(snap.state.count).toBe(2);
    expect(snap.state.label).toBe("merged");
  });

  // --- Embedded projection tests ---

  it("should build a slice with an embedded projection", () => {
    const Incremented = z.object({ by: z.number() });
    const proj = projection("counters")
      .on({ Incremented })
      .do(async () => {})
      .build();

    const s = slice().with(PartA).projection(proj).build();

    expect(s._tag).toBe("Slice");
    expect(s.projections).toHaveLength(1);
    expect(s.projections[0]).toBe(proj);
  });

  it("should merge embedded projection reactions into act registry", async () => {
    const stream = nextStream();
    const projected = vi.fn();

    const Incremented = z.object({ by: z.number() });
    const proj = projection("counters")
      .on({ Incremented })
      .do(async function project(event) {
        await Promise.resolve();
        projected(event.data);
      })
      .build();

    const ThingSlice = slice().with(PartA).projection(proj).build();
    const app = act().with(ThingSlice).with(PartB).build();

    await app.do("increment", { stream, actor }, { by: 7 });
    await app.correlate();
    await app.drain();

    expect(projected).toHaveBeenCalledWith({ by: 7 });
  });

  it("should fire both slice reactions and embedded projection handlers", async () => {
    const stream = nextStream();
    const sliceHandler = vi.fn().mockResolvedValue(undefined);
    const projHandler = vi.fn().mockResolvedValue(undefined);

    const Incremented = z.object({ by: z.number() });
    const proj = projection("counters")
      .on({ Incremented })
      .do(projHandler)
      .build();

    const ThingSlice = slice()
      .with(PartA)
      .projection(proj)
      .on("Incremented")
      .do(sliceHandler)
      .build();

    const app = act().with(ThingSlice).build();

    await app.do("increment", { stream, actor }, { by: 1 });
    await app.correlate();
    await app.drain();
    await app.drain();

    expect(sliceHandler).toHaveBeenCalled();
    expect(projHandler).toHaveBeenCalled();
  });

  it("should not pass dispatcher to embedded projection handlers", async () => {
    const stream = nextStream();
    let receivedEvent: any;
    let receivedStream: string | undefined;

    const Incremented = z.object({ by: z.number() });
    const proj = projection("counters")
      .on({ Incremented })
      .do(async function spy(event, stream) {
        await Promise.resolve();
        receivedEvent = event;
        receivedStream = stream;
      })
      .build();

    const ThingSlice = slice().with(PartA).projection(proj).build();
    const app = act().with(ThingSlice).build();

    await app.do("increment", { stream, actor }, { by: 1 });
    await app.correlate();
    await app.drain();

    // Projection handler received correct args
    expect(receivedEvent.data).toEqual({ by: 1 });
    expect(receivedStream).toBe("counters");
    // The handler's declared parameter count is 2 (no dispatcher)
    const [reaction] = [...proj.events["Incremented"].reactions.values()];
    expect(reaction.handler.length).toBe(2);
  });

  it("should deduplicate names when projection and slice have same handler name", () => {
    const Incremented = z.object({ by: z.number() });
    const projHandler = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(projHandler, "name", { value: "myHandler" });
    const proj = projection("counters")
      .on({ Incremented })
      .do(projHandler)
      .build();

    // Slice reaction with same handler name
    const sliceHandler = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(sliceHandler, "name", { value: "myHandler" });
    const ThingSlice = slice()
      .with(PartA)
      .projection(proj)
      .on("Incremented")
      .do(sliceHandler)
      .build();

    const app = act().with(ThingSlice).build();
    const events = app.registry.events as Record<string, any>;

    // Both should be registered — projection handler deduped with "_p" suffix
    const names = [...events["Incremented"].reactions.keys()];
    expect(names).toContain("myHandler");
    expect(names).toContain("myHandler_p");
  });

  it("should compose multiple slices with embedded projections", async () => {
    const stream = nextStream();
    const projA = vi.fn().mockResolvedValue(undefined);
    const projB = vi.fn().mockResolvedValue(undefined);

    const Incremented = z.object({ by: z.number() });
    const Labeled = z.object({ label: z.string() });

    const ProjA = projection("counters").on({ Incremented }).do(projA).build();

    const ProjB = projection("labels").on({ Labeled }).do(projB).build();

    const SliceA = slice().with(PartA).projection(ProjA).build();
    const SliceB = slice().with(PartB).projection(ProjB).build();

    const app = act().with(SliceA).with(SliceB).build();

    await app.do("increment", { stream, actor }, { by: 1 });
    await app.do("setLabel", { stream, actor }, { label: "test" });
    await app.correlate();
    await app.drain();

    expect(projA).toHaveBeenCalled();
    expect(projB).toHaveBeenCalled();
  });

  it("should still support standalone act().with(projection) (backward compat)", async () => {
    const stream = nextStream();
    const handler = vi.fn().mockResolvedValue(undefined);

    const Incremented = z.object({ by: z.number() });
    const StandaloneProj = projection("counters")
      .on({ Incremented })
      .do(handler)
      .build();

    const app = act().with(PartA).with(StandaloneProj).build();

    await app.do("increment", { stream, actor }, { by: 5 });
    await app.correlate();
    await app.drain();

    expect(handler).toHaveBeenCalled();
  });
});
