import { z } from "zod";
import { act, state, ZodEmpty } from "../src/index.js";

describe("partial-state", () => {
  const schema = z.object({
    count: z.number(),
    label: z.string(),
  });

  const PartA = state("Thing", schema)
    .init(() => ({ count: 0, label: "" }))
    .emits({ Incremented: z.object({ by: z.number() }) })
    .patch({
      Incremented: (event, state) => ({ count: state.count + event.data.by }),
    })
    .on("increment", z.object({ by: z.number() }))
    .emit((action) => ["Incremented", { by: action.by }])
    .build();

  const PartB = state("Thing", schema)
    .init(() => ({ count: 0, label: "" }))
    .emits({ Labeled: z.object({ label: z.string() }) })
    .patch({
      Labeled: (event) => ({ label: event.data.label }),
    })
    .on("setLabel", z.object({ label: z.string() }))
    .emit((action) => ["Labeled", { label: action.label }])
    .build();

  const actor = { id: "a", name: "a" };

  it("should merge two partials with the same name", () => {
    const app = act().with(PartA).with(PartB).build();
    expect(app).toBeDefined();
  });

  it("should execute actions from both partials", async () => {
    const app = act().with(PartA).with(PartB).build();

    await app.do("increment", { stream: "s1", actor }, { by: 3 });
    await app.do("setLabel", { stream: "s1", actor }, { label: "hello" });

    const snap = await app.load(PartA, "s1");
    expect(snap.state.count).toBe(3);
    expect(snap.state.label).toBe("hello");
  });

  it("should reconstruct state from events across all partials", async () => {
    const app = act().with(PartA).with(PartB).build();

    await app.do("increment", { stream: "s2", actor }, { by: 1 });
    await app.do("setLabel", { stream: "s2", actor }, { label: "first" });
    await app.do("increment", { stream: "s2", actor }, { by: 2 });
    await app.do("setLabel", { stream: "s2", actor }, { label: "second" });

    const snap = await app.load(PartA, "s2");
    expect(snap.state.count).toBe(3);
    expect(snap.state.label).toBe("second");
  });

  it("should throw on duplicate action across partials", () => {
    const DupAction = state("Thing", schema)
      .init(() => ({ count: 0, label: "" }))
      .emits({ Other: ZodEmpty })
      .patch({ Other: () => ({}) })
      .on("increment", ZodEmpty)
      .emit(() => ["Other", {}])
      .build();

    expect(() => act().with(PartA).with(DupAction)).toThrow(
      'Duplicate action "increment"'
    );
  });

  it("should throw on duplicate event across partials", () => {
    const DupEvent = state("Thing", schema)
      .init(() => ({ count: 0, label: "" }))
      .emits({ Incremented: z.object({ by: z.number() }) })
      .patch({ Incremented: () => ({}) })
      .on("other", ZodEmpty)
      .emit(() => ["Incremented", { by: 0 }])
      .build();

    expect(() => act().with(PartA).with(DupEvent)).toThrow(
      'Duplicate event "Incremented"'
    );
  });

  it("should support reactions on events from any partial", async () => {
    const onIncremented = vi.fn().mockResolvedValue(undefined);
    const onLabeled = vi.fn().mockResolvedValue(undefined);

    const app = act()
      .with(PartA)
      .on("Incremented")
      .do(onIncremented)
      .with(PartB)
      .on("Labeled")
      .do(onLabeled)
      .build();

    await app.do("increment", { stream: "s3", actor }, { by: 1 });
    await app.do("setLabel", { stream: "s3", actor }, { label: "test" });
    await app.correlate();
    await app.drain();

    expect(onIncremented).toHaveBeenCalled();
    expect(onLabeled).toHaveBeenCalled();
  });

  it("should preserve snap from partial that defines it", () => {
    const WithSnap = state("Snapped", schema)
      .init(() => ({ count: 0, label: "" }))
      .emits({ X: ZodEmpty })
      .patch({ X: () => ({}) })
      .on("doX", ZodEmpty)
      .emit(() => ["X", {}])
      .snap(() => true)
      .build();

    const WithoutSnap = state("Snapped", schema)
      .init(() => ({ count: 0, label: "" }))
      .emits({ Y: ZodEmpty })
      .patch({ Y: () => ({}) })
      .on("doY", ZodEmpty)
      .emit(() => ["Y", {}])
      .build();

    // snap from first partial should survive merge
    const app = act().with(WithSnap).with(WithoutSnap).build();
    expect(app).toBeDefined();
  });

  it("should work with single-chain states (backward compat)", async () => {
    const counter = state("Counter", z.object({ count: z.number() }))
      .init(() => ({ count: 0 }))
      .emits({ incremented: ZodEmpty })
      .patch({ incremented: (_, state) => ({ count: state.count + 1 }) })
      .on("increment", ZodEmpty)
      .emit(() => ["incremented", {}])
      .build();

    const app = act().with(counter).build();
    await app.do("increment", { stream: "c1", actor }, {});
    const snap = await app.load(counter, "c1");
    expect(snap.state.count).toBe(1);
  });

  it("should merge partial schemas with non-overlapping fields", async () => {
    const SliceA = state("Merged", z.object({ count: z.number() }))
      .init(() => ({ count: 0 }))
      .emits({ Counted: z.object({ n: z.number() }) })
      .patch({ Counted: (e) => ({ count: e.data.n }) })
      .on("setCount", z.object({ n: z.number() }))
      .emit((a) => ["Counted", { n: a.n }])
      .build();

    const SliceB = state("Merged", z.object({ label: z.string() }))
      .init(() => ({ label: "" }))
      .emits({ Named: z.object({ label: z.string() }) })
      .patch({ Named: (e) => ({ label: e.data.label }) })
      .on("setName", z.object({ label: z.string() }))
      .emit((a) => ["Named", { label: a.label }])
      .build();

    const app = act().with(SliceA).with(SliceB).build();

    await app.do("setCount", { stream: "m1", actor }, { n: 42 });
    await app.do("setName", { stream: "m1", actor }, { label: "hello" });

    const snap = await app.load(SliceA, "m1");
    expect(snap.state.count).toBe(42);
    expect((snap.state as any).label).toBe("hello");
  });

  it("should merge init functions from partials", async () => {
    const SliceA = state("InitMerge", z.object({ x: z.number() }))
      .init(() => ({ x: 10 }))
      .emits({ A: ZodEmpty })
      .patch({ A: () => ({}) })
      .on("doA", ZodEmpty)
      .emit(() => ["A", {}])
      .build();

    const SliceB = state("InitMerge", z.object({ y: z.string() }))
      .init(() => ({ y: "default" }))
      .emits({ B: ZodEmpty })
      .patch({ B: () => ({}) })
      .on("doB", ZodEmpty)
      .emit(() => ["B", {}])
      .build();

    const app = act().with(SliceA).with(SliceB).build();
    await app.do("doA", { stream: "i1", actor }, {});
    const snap = await app.load(SliceA, "i1");
    expect(snap.state.x).toBe(10);
    expect((snap.state as any).y).toBe("default");
  });

  it("should allow overlapping keys with same base type", () => {
    const SliceA = state("Overlap", z.object({ shared: z.string() }))
      .init(() => ({ shared: "" }))
      .emits({ X: ZodEmpty })
      .patch({ X: () => ({}) })
      .on("doX", ZodEmpty)
      .emit(() => ["X", {}])
      .build();

    const SliceB = state("Overlap", z.object({ shared: z.string().optional() }))
      .init(() => ({ shared: undefined }))
      .emits({ Y: ZodEmpty })
      .patch({ Y: () => ({}) })
      .on("doY", ZodEmpty)
      .emit(() => ["Y", {}])
      .build();

    // Same base type (ZodString) - should not throw
    expect(() => act().with(SliceA).with(SliceB)).not.toThrow();
  });

  it("should throw on overlapping keys with different base types", () => {
    const SliceA = state("Conflict", z.object({ field: z.string() }))
      .init(() => ({ field: "" }))
      .emits({ X: ZodEmpty })
      .patch({ X: () => ({}) })
      .on("doX", ZodEmpty)
      .emit(() => ["X", {}])
      .build();

    const SliceB = state("Conflict", z.object({ field: z.number() }))
      .init(() => ({ field: 0 }))
      .emits({ Y: ZodEmpty })
      .patch({ Y: () => ({}) })
      .on("doY", ZodEmpty)
      .emit(() => ["Y", {}])
      .build();

    expect(() => act().with(SliceA).with(SliceB)).toThrow("Schema conflict");
  });

  it("should reconstruct state from cross-partial events", async () => {
    const SliceA = state("Cross", z.object({ total: z.number() }))
      .init(() => ({ total: 0 }))
      .emits({ Added: z.object({ n: z.number() }) })
      .patch({ Added: (e, s) => ({ total: s.total + e.data.n }) })
      .on("add", z.object({ n: z.number() }))
      .emit((a) => ["Added", { n: a.n }])
      .build();

    const SliceB = state("Cross", z.object({ tag: z.string() }))
      .init(() => ({ tag: "" }))
      .emits({ Tagged: z.object({ tag: z.string() }) })
      .patch({ Tagged: (e) => ({ tag: e.data.tag }) })
      .on("tag", z.object({ tag: z.string() }))
      .emit((a) => ["Tagged", { tag: a.tag }])
      .build();

    const app = act().with(SliceA).with(SliceB).build();
    await app.do("add", { stream: "c1", actor }, { n: 1 });
    await app.do("tag", { stream: "c1", actor }, { tag: "a" });
    await app.do("add", { stream: "c1", actor }, { n: 2 });
    await app.do("tag", { stream: "c1", actor }, { tag: "b" });

    const snap = await app.load(SliceA, "c1");
    expect(snap.state.total).toBe(3);
    expect((snap.state as any).tag).toBe("b");
  });

  it("should not conflict on optional wrapping of same base type", () => {
    const SliceA = state("OptWrap", z.object({ val: z.string() }))
      .init(() => ({ val: "" }))
      .emits({ X: ZodEmpty })
      .patch({ X: () => ({}) })
      .on("doX", ZodEmpty)
      .emit(() => ["X", {}])
      .build();

    const SliceB = state("OptWrap", z.object({ val: z.string().optional() }))
      .init(() => ({ val: undefined }))
      .emits({ Y: ZodEmpty })
      .patch({ Y: () => ({}) })
      .on("doY", ZodEmpty)
      .emit(() => ["Y", {}])
      .build();

    expect(() => act().with(SliceA).with(SliceB)).not.toThrow();
  });

  it("should merge given (invariants) from partials", async () => {
    const PartWithInvariant = state(
      "Guarded",
      z.object({ locked: z.boolean() })
    )
      .init(() => ({ locked: false }))
      .emits({ Locked: ZodEmpty })
      .patch({ Locked: () => ({ locked: true }) })
      .on("lock", ZodEmpty)
      .emit(() => ["Locked", {}])
      .build();

    const PartWithGuardedAction = state(
      "Guarded",
      z.object({ locked: z.boolean() })
    )
      .init(() => ({ locked: false }))
      .emits({ Attempted: ZodEmpty })
      .patch({ Attempted: () => ({}) })
      .on("attempt", ZodEmpty)
      .given([{ description: "Must not be locked", valid: (s) => !s.locked }])
      .emit(() => ["Attempted", {}])
      .build();

    const app = act()
      .with(PartWithInvariant)
      .with(PartWithGuardedAction)
      .build();

    await app.do("lock", { stream: "g1", actor }, {});
    await expect(
      app.do("attempt", { stream: "g1", actor }, {})
    ).rejects.toThrow("Must not be locked");
  });
});
