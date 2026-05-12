import { z } from "zod";
import { act, projection, slice, state, ZodEmpty } from "../src/index.js";
import { sandbox } from "../src/test/index.js";

describe("slice", () => {
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

  let streamId = 0;
  const nextStream = () => `slice-test-${++streamId}`;

  it("should build a slice with states and empty reactions", () => {
    const s = slice().withState(PartA).build();
    expect(s._tag).toBe("Slice");
    expect(s.states.size).toBe(1);
    expect(s.states.has("Thing")).toBe(true);
    expect(s.events.Incremented).toBeDefined();
    expect(s.events.Incremented.reactions.size).toBe(0);
  });

  it("should register scoped reactions via .on().do()", () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const s = slice().withState(PartA).on("Incremented").do(handler).build();

    expect(s.events.Incremented.reactions.size).toBe(1);
  });

  it("should throw for anonymous handlers", () => {
    expect(() =>
      slice()
        .withState(PartA)
        .on("Incremented")
        .do(async () => {})
    ).toThrow('Reaction handler for "Incremented" must be a named function');
  });

  it("should register scoped reactions via .on().do().to() with string", () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const s = slice()
      .withState(PartA)
      .on("Incremented")
      .do(handler)
      .to("target-stream")
      .build();

    expect(s.events.Incremented.reactions.size).toBe(1);
  });

  it("should register scoped reactions via .on().do().to() with function resolver", () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const resolver = (event: any) => ({ target: event.stream });
    const s = slice()
      .withState(PartA)
      .on("Incremented")
      .do(handler)
      .to(resolver)
      .build();

    expect(s.events.Incremented.reactions.size).toBe(1);
  });

  it("should merge act().withState(Slice) states and reactions into act registry", async () => {
    const stream = nextStream();
    const onIncremented = vi.fn().mockResolvedValue(undefined);

    const ThingSlice = slice()
      .withState(PartA)
      .on("Incremented")
      .do(onIncremented)
      .build();

    const { app, dispose } = await sandbox(
      act().withSlice(ThingSlice).withState(PartB)
    );

    await app.do("increment", { stream, actor }, { by: 3 });
    await app.do("setLabel", { stream, actor }, { label: "hello" });
    await app.correlate();
    await app.drain();

    const snap = await app.load("Thing", stream);
    expect(snap.state.count).toBe(3);
    expect(snap.state.label).toBe("hello");
    expect(onIncremented).toHaveBeenCalled();

    await dispose();
  });

  it("should compose multiple slices into act", async () => {
    const stream = nextStream();
    const onIncremented = vi.fn().mockResolvedValue(undefined);
    const onLabeled = vi.fn().mockResolvedValue(undefined);

    const SliceA = slice()
      .withState(PartA)
      .on("Incremented")
      .do(onIncremented)
      .build();

    const SliceB = slice().withState(PartB).on("Labeled").do(onLabeled).build();

    const { app, dispose } = await sandbox(
      act().withSlice(SliceA).withSlice(SliceB)
    );

    await app.do("increment", { stream, actor }, { by: 1 });
    await app.do("setLabel", { stream, actor }, { label: "test" });
    await app.correlate();
    await app.drain();

    expect(onIncremented).toHaveBeenCalled();
    expect(onLabeled).toHaveBeenCalled();

    const snap = await app.load("Thing", stream);
    expect(snap.state.count).toBe(1);
    expect(snap.state.label).toBe("test");

    await dispose();
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

    const SliceA = slice().withState(CountA).build();
    const SliceB = slice().withState(CountB).build();

    const { app, dispose } = await sandbox(
      act().withSlice(SliceA).withSlice(SliceB)
    );

    await app.do("add", { stream, actor }, { n: 5 });
    await app.do("tag", { stream, actor }, { tag: "merged" });

    const snap = await app.load("Counter", stream);
    expect(snap.state.total).toBe(5);
    expect(snap.state.tag).toBe("merged");

    await dispose();
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

    const Slice1 = slice().withState(S1).build();
    const Slice2 = slice().withState(S2).build();

    expect(() => act().withSlice(Slice1).withSlice(Slice2)).toThrow(
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

    const Slice1 = slice().withState(S1).build();
    const Slice2 = slice().withState(S2).build();

    expect(() => act().withSlice(Slice1).withSlice(Slice2)).toThrow(
      'Duplicate event "SameEvent"'
    );
  });

  describe("cross-slice event contract (ACT-401)", () => {
    it("allows same-name state partials that share the schema reference", () => {
      const Counted = z.object({ n: z.number() });

      const CountA = state({ Counter: z.object({ total: z.number() }) })
        .init(() => ({ total: 0 }))
        .emits({ Counted })
        .patch({ Counted: (e, s) => ({ total: s.total + e.data.n }) })
        .on({ count: z.object({ n: z.number() }) })
        .emit((a) => ["Counted", { n: a.n }])
        .build();

      const CountB = state({ Counter: z.object({ tag: z.string() }) })
        .init(() => ({ tag: "" }))
        .emits({ Counted })
        .build();

      const SliceA = slice().withState(CountA).build();
      const SliceB = slice().withState(CountB).build();

      expect(() => act().withSlice(SliceA).withSlice(SliceB)).not.toThrow();
    });

    it("throws when same-name state partials use different schema references for the same event", () => {
      const CountA = state({ Counter: z.object({ total: z.number() }) })
        .init(() => ({ total: 0 }))
        .emits({ Counted: z.object({ n: z.number() }) })
        .patch({ Counted: (e, s) => ({ total: s.total + e.data.n }) })
        .on({ count: z.object({ n: z.number() }) })
        .emit((a) => ["Counted", { n: a.n }])
        .build();

      const CountB = state({ Counter: z.object({ tag: z.string() }) })
        .init(() => ({ tag: "" }))
        .emits({ Counted: z.object({ n: z.number() }) })
        .build();

      const SliceA = slice().withState(CountA).build();
      const SliceB = slice().withState(CountB).build();

      expect(() => act().withSlice(SliceA).withSlice(SliceB)).toThrow(
        /Event "Counted" in state "Counter" is declared with different Zod schemas across slices/
      );
    });

    it("error message points the developer at the shared-schema fix", () => {
      const A = state({ Thing: z.object({ a: z.number() }) })
        .init(() => ({ a: 0 }))
        .emits({ Pinged: z.object({ at: z.number() }) })
        .patch({ Pinged: (_, s) => s })
        .on({ ping: z.object({ at: z.number() }) })
        .emit((a) => ["Pinged", { at: a.at }])
        .build();

      const B = state({ Thing: z.object({ b: z.number() }) })
        .init(() => ({ b: 0 }))
        .emits({ Pinged: z.object({ at: z.number() }) })
        .build();

      const SliceA = slice().withState(A).build();
      const SliceB = slice().withState(B).build();

      expect(() => act().withSlice(SliceA).withSlice(SliceB)).toThrow(
        /extract a shared schema.*export const Pinged.*import it in every slice/s
      );
    });

    it("throws on structurally-divergent schemas with the same name", () => {
      const A = state({ Order: z.object({ id: z.string() }) })
        .init(() => ({ id: "" }))
        .emits({ OrderPaid: z.object({ amount: z.number().positive() }) })
        .patch({ OrderPaid: (_, s) => s })
        .on({ pay: z.object({ amount: z.number().positive() }) })
        .emit((a) => ["OrderPaid", { amount: a.amount }])
        .build();

      const B = state({ Order: z.object({ note: z.string() }) })
        .init(() => ({ note: "" }))
        .emits({ OrderPaid: z.object({ amount: z.string() }) })
        .build();

      const SliceA = slice().withState(A).build();
      const SliceB = slice().withState(B).build();

      expect(() => act().withSlice(SliceA).withSlice(SliceB)).toThrow(
        /Event "OrderPaid".*different Zod schemas/
      );
    });
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

    const CounterSlice = slice().withState(Counter).build();
    const LoggerSlice = slice().withState(Logger).build();

    const crossHandler = vi.fn().mockResolvedValue(undefined);
    const { app, dispose } = await sandbox(
      act()
        .withSlice(CounterSlice)
        .withSlice(LoggerSlice)
        .on("Counted")
        .do(crossHandler)
    );

    await app.do("count", { stream, actor }, { n: 1 });
    await app.correlate();
    await app.drain();

    expect(crossHandler).toHaveBeenCalled();

    await dispose();
  });

  it("should still support act().withState(State) (backward compat)", async () => {
    const stream = nextStream();

    const counter = state({ Counter: z.object({ count: z.number() }) })
      .init(() => ({ count: 0 }))
      .emits({ incremented: ZodEmpty })
      .patch({ incremented: (_, state) => ({ count: state.count + 1 }) })
      .on({ increment: ZodEmpty })
      .emit(() => ["incremented", {}])
      .build();

    const { app, dispose } = await sandbox(act().withState(counter));
    await app.do("increment", { stream, actor }, {});
    const snap = await app.load(counter, stream);
    expect(snap.state.count).toBe(1);

    await dispose();
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

    const CounterSlice = slice().withState(Counter).build();

    const { app, dispose } = await sandbox(
      act().withSlice(CounterSlice).withState(Logger)
    );

    await app.do("count", { stream: counterStream, actor }, { n: 5 });
    await app.do("log", { stream: logStream, actor }, {});

    const counterSnap = await app.load("Counter", counterStream);
    const logSnap = await app.load(Logger, logStream);
    expect(counterSnap.state.count).toBe(5);
    expect(logSnap.state.entries).toBe(1);

    await dispose();
  });

  it("should expose .events on slice builder for AsCommitted typing", () => {
    const b = slice().withState(PartA);
    expect(b.events).toBeDefined();
    expect(b.events.Incremented).toBeDefined();
    expect(b.events.Incremented.schema).toBeDefined();
  });

  it("should compose slices that share the same state", async () => {
    const stream = nextStream();
    const onIncremented = vi.fn().mockResolvedValue(undefined);
    const onLabeled = vi.fn().mockResolvedValue(undefined);

    const SliceA = slice()
      .withState(PartA)
      .withState(PartB)
      .on("Incremented")
      .do(onIncremented)
      .build();

    const SliceB = slice().withState(PartB).on("Labeled").do(onLabeled).build();

    const { app, dispose } = await sandbox(
      act().withSlice(SliceA).withSlice(SliceB)
    );

    await app.do("increment", { stream, actor }, { by: 7 });
    await app.do("setLabel", { stream, actor }, { label: "shared" });
    await app.correlate();
    await app.drain();

    expect(onIncremented).toHaveBeenCalled();
    expect(onLabeled).toHaveBeenCalled();

    const snap = await app.load("Thing", stream);
    expect(snap.state.count).toBe(7);
    expect(snap.state.label).toBe("shared");

    await dispose();
  });

  it("should merge multiple partials within a single slice", async () => {
    const stream = nextStream();
    const s = slice().withState(PartA).withState(PartB).build();

    expect(s.states.size).toBe(1);
    expect(s.events.Incremented).toBeDefined();
    expect(s.events.Labeled).toBeDefined();

    const { app, dispose } = await sandbox(act().withSlice(s));
    await app.do("increment", { stream, actor }, { by: 2 });
    await app.do("setLabel", { stream, actor }, { label: "merged" });

    const snap = await app.load("Thing", stream);
    expect(snap.state.count).toBe(2);
    expect(snap.state.label).toBe("merged");

    await dispose();
  });

  // --- Embedded projection tests ---

  it("should build a slice with an embedded projection", () => {
    const Incremented = z.object({ by: z.number() });
    const proj = projection("counters")
      .on({ Incremented })
      .do(async function handleIncremented() {})
      .build();

    const s = slice().withState(PartA).withProjection(proj).build();

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

    const ThingSlice = slice().withState(PartA).withProjection(proj).build();
    const { app, dispose } = await sandbox(
      act().withSlice(ThingSlice).withState(PartB)
    );

    await app.do("increment", { stream, actor }, { by: 7 });
    await app.correlate();
    await app.drain();

    expect(projected).toHaveBeenCalledWith({ by: 7 });

    await dispose();
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
      .withState(PartA)
      .withProjection(proj)
      .on("Incremented")
      .do(sliceHandler)
      .build();

    const { app, dispose } = await sandbox(act().withSlice(ThingSlice));

    await app.do("increment", { stream, actor }, { by: 1 });
    await app.correlate();
    await app.drain();
    await app.drain();

    expect(sliceHandler).toHaveBeenCalled();
    expect(projHandler).toHaveBeenCalled();

    await dispose();
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

    const ThingSlice = slice().withState(PartA).withProjection(proj).build();
    const { app, dispose } = await sandbox(act().withSlice(ThingSlice));

    await app.do("increment", { stream, actor }, { by: 1 });
    await app.correlate();
    await app.drain();

    expect(receivedEvent.data).toEqual({ by: 1 });
    expect(receivedStream).toBe("counters");
    const [reaction] = [...proj.events.Incremented.reactions.values()];
    expect(reaction.handler.length).toBe(2);

    await dispose();
  });

  it("should deduplicate names when projection and slice have same handler name", async () => {
    const Incremented = z.object({ by: z.number() });
    const projHandler = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(projHandler, "name", { value: "myHandler" });
    const proj = projection("counters")
      .on({ Incremented })
      .do(projHandler)
      .build();

    const sliceHandler = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(sliceHandler, "name", { value: "myHandler" });
    const ThingSlice = slice()
      .withState(PartA)
      .withProjection(proj)
      .on("Incremented")
      .do(sliceHandler)
      .build();

    const { app, dispose } = await sandbox(act().withSlice(ThingSlice));
    const events = app.registry.events as Record<string, any>;

    const names = [...events.Incremented.reactions.keys()];
    expect(names).toContain("myHandler");
    expect(names).toContain("myHandler_p");

    await dispose();
  });

  it("should compose multiple slices with embedded projections", async () => {
    const stream = nextStream();
    const projA = vi.fn().mockResolvedValue(undefined);
    const projB = vi.fn().mockResolvedValue(undefined);

    const Incremented = z.object({ by: z.number() });
    const Labeled = z.object({ label: z.string() });

    const ProjA = projection("counters").on({ Incremented }).do(projA).build();
    const ProjB = projection("labels").on({ Labeled }).do(projB).build();

    const SliceA = slice().withState(PartA).withProjection(ProjA).build();
    const SliceB = slice().withState(PartB).withProjection(ProjB).build();

    const { app, dispose } = await sandbox(
      act().withSlice(SliceA).withSlice(SliceB)
    );

    await app.do("increment", { stream, actor }, { by: 1 });
    await app.do("setLabel", { stream, actor }, { label: "test" });
    await app.correlate();
    await app.drain();

    expect(projA).toHaveBeenCalled();
    expect(projB).toHaveBeenCalled();

    await dispose();
  });

  it("should still support standalone act().withProjection(projection) (backward compat)", async () => {
    const stream = nextStream();
    const handler = vi.fn().mockResolvedValue(undefined);

    const Incremented = z.object({ by: z.number() });
    const StandaloneProj = projection("counters")
      .on({ Incremented })
      .do(handler)
      .build();

    const { app, dispose } = await sandbox(
      act().withState(PartA).withProjection(StandaloneProj)
    );

    await app.do("increment", { stream, actor }, { by: 5 });
    await app.correlate();
    await app.drain();

    expect(handler).toHaveBeenCalled();

    await dispose();
  });

  /* eslint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/require-await -- type-only narrowing checks */
  describe("type narrowing", () => {
    it("narrows event name + handler args in .on().do()", () => {
      const _check = () => {
        slice()
          .withState(PartA)
          .on("Incremented")
          .do(async function react(event, _stream, _app) {
            const _by: number = event.data.by;
            expect(_by).toBeDefined();
          })
          .to("counter-target")
          .build();
      };
      expect(typeof _check).toBe("function");
    });

    it("rejects unknown event names in .on() at compile time", () => {
      const _check = () => {
        // @ts-expect-error 'NotEmitted' isn't an event of PartA
        slice().withState(PartA).on("NotEmitted");
      };
      expect(typeof _check).toBe("function");
    });

    it("narrows event in .to() resolver function", () => {
      const _check = () => {
        slice()
          .withState(PartA)
          .on("Incremented")
          .do(async function react() {})
          .to((event) => {
            const _by: number = event.data.by;
            return { target: `t-${_by}` };
          })
          .build();
      };
      expect(typeof _check).toBe("function");
    });
  });
});
