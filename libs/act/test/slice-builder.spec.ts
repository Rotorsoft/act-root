import { z } from "zod";
import {
  act,
  dispose,
  isSlice,
  slice,
  state,
  store,
  ZodEmpty,
} from "../src/index.js";

// Base state: a simple Counter
const Counter = state("Counter", z.object({ count: z.number() }))
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ by: z.number() }) })
  .patch({
    Incremented: ({ data }, state) => ({ count: state.count + data.by }),
  })
  .on("Increment", z.object({ by: z.number() }))
  .emit(({ by }) => ["Incremented", { by }])
  .build();

const actor = { id: "test", name: "test" };

describe("slice-builder", () => {
  beforeEach(async () => {
    await store().drop();
  });

  afterAll(async () => {
    await dispose()();
  });

  describe("isSlice", () => {
    it("should return true for a slice", () => {
      const s = slice("test").build();
      expect(isSlice(s)).toBe(true);
    });

    it("should return false for non-slice values", () => {
      expect(isSlice(null)).toBe(false);
      expect(isSlice(undefined)).toBe(false);
      expect(isSlice({})).toBe(false);
      expect(isSlice(Counter)).toBe(false);
      expect(isSlice({ kind: "other" })).toBe(false);
    });
  });

  describe("building slices", () => {
    it("should build an empty slice", () => {
      const s = slice("empty").build();
      expect(s.kind).toBe("slice");
      expect(s.name).toBe("empty");
      expect(s.states.size).toBe(0);
      expect(s.reactions).toHaveLength(0);
    });

    it("should build a slice that extends a state with new events and actions", () => {
      const doubling = slice("doubling")
        .with(Counter)
        .events({
          Doubled: z.object({ by: z.number() }),
        })
        .patches({
          Doubled: ({ data }, state) => ({ count: state.count + data.by * 2 }),
        })
        .action("Double", z.object({ by: z.number() }))
        .emit(({ by }) => ["Doubled", { by }])
        .build();

      expect(doubling.kind).toBe("slice");
      expect(doubling.name).toBe("doubling");
      expect(doubling.states.size).toBe(1);
      expect(doubling.states.has("Counter")).toBe(true);

      const contrib = doubling.states.get("Counter")!;
      expect(contrib.base).toBe(Counter);
      expect(Object.keys(contrib.events)).toEqual(["Doubled"]);
      expect(Object.keys(contrib.actions)).toEqual(["Double"]);
      expect(Object.keys(contrib.patch)).toEqual(["Doubled"]);
    });

    it("should build a reactions-only slice", () => {
      const handler = async () => {};
      const s = slice("reactions-only")
        .on("Incremented")
        .do(handler)
        .void()
        .build();

      expect(s.states.size).toBe(0);
      expect(s.reactions).toHaveLength(1);
      expect(s.reactions[0].event).toBe("Incremented");
    });

    it("should support invariants on slice actions", () => {
      const guarded = slice("guarded")
        .with(Counter)
        .events({ Tripled: z.object({ by: z.number() }) })
        .patches({
          Tripled: ({ data }, state) => ({ count: state.count + data.by * 3 }),
        })
        .action("Triple", z.object({ by: z.number() }))
        .given([
          {
            description: "Count must be non-negative",
            valid: (state) => state.count >= 0,
          },
        ])
        .emit(({ by }) => ["Tripled", { by }])
        .build();

      const contrib = guarded.states.get("Counter")!;
      expect(contrib.given["Triple"]).toHaveLength(1);
      expect(contrib.given["Triple"][0].description).toBe(
        "Count must be non-negative"
      );
    });
  });

  describe("composing slices with act()", () => {
    it("should compose a slice with its base state", async () => {
      const doubling = slice("doubling")
        .with(Counter)
        .events({
          Doubled: z.object({ by: z.number() }),
        })
        .patches({
          Doubled: ({ data }, state) => ({ count: state.count + data.by * 2 }),
        })
        .action("Double", z.object({ by: z.number() }))
        .emit(({ by }) => ["Doubled", { by }])
        .build();

      const app = act().with(Counter).with(doubling).build();

      // Base action still works
      await app.do("Increment", { stream: "s1", actor }, { by: 5 });
      let snap = await app.load(Counter, "s1");
      expect(snap.state.count).toBe(5);

      // Slice action works
      await app.do("Double", { stream: "s1", actor }, { by: 3 });
      snap = await app.load(Counter, "s1");
      expect(snap.state.count).toBe(11); // 5 + 3*2
    });

    it("should auto-register base state from slice", async () => {
      const doubling = slice("doubling")
        .with(Counter)
        .events({
          Doubled: z.object({ by: z.number() }),
        })
        .patches({
          Doubled: ({ data }, state) => ({ count: state.count + data.by * 2 }),
        })
        .action("Double", z.object({ by: z.number() }))
        .emit(({ by }) => ["Doubled", { by }])
        .build();

      // Register slice first (auto-registers Counter)
      const app = act().with(doubling).build();

      await app.do("Increment", { stream: "s2", actor }, { by: 1 });
      await app.do("Double", { stream: "s2", actor }, { by: 2 });
      const snap = await app.load(Counter, "s2");
      expect(snap.state.count).toBe(5); // 1 + 2*2
    });

    it("should compose multiple slices extending the same state", async () => {
      const doubling = slice("doubling")
        .with(Counter)
        .events({
          Doubled: z.object({ by: z.number() }),
        })
        .patches({
          Doubled: ({ data }, state) => ({ count: state.count + data.by * 2 }),
        })
        .action("Double", z.object({ by: z.number() }))
        .emit(({ by }) => ["Doubled", { by }])
        .build();

      const resetting = slice("resetting")
        .with(Counter)
        .events({ Reset: ZodEmpty })
        .patches({ Reset: () => ({ count: 0 }) })
        .action("Reset", ZodEmpty)
        .emit(() => ["Reset", {}])
        .build();

      const app = act().with(Counter).with(doubling).with(resetting).build();

      await app.do("Increment", { stream: "s3", actor }, { by: 10 });
      await app.do("Double", { stream: "s3", actor }, { by: 3 });
      let snap = await app.load(Counter, "s3");
      expect(snap.state.count).toBe(16); // 10 + 3*2

      await app.do("Reset", { stream: "s3", actor }, {});
      snap = await app.load(Counter, "s3");
      expect(snap.state.count).toBe(0);
    });

    it("should compose slice with reactions", async () => {
      const reacted = vi.fn().mockResolvedValue(undefined);

      const monitoring = slice("monitoring")
        .on("Incremented")
        .do(reacted)
        .build();

      const app = act().with(Counter).with(monitoring).build();

      await app.do("Increment", { stream: "s4", actor }, { by: 1 });
      await app.correlate();
      await app.drain({ leaseMillis: 1 });

      expect(reacted).toHaveBeenCalledTimes(1);
      expect(reacted).toHaveBeenCalledWith(
        expect.objectContaining({
          event: expect.objectContaining({
            name: "Incremented",
            data: { by: 1 },
          }),
          stream: expect.any(String),
          app: expect.any(Object),
        })
      );
    });
  });

  describe("conflict detection", () => {
    it("should throw on duplicate event from slice", () => {
      const conflicting = slice("conflict")
        .with(Counter)
        .events({ Incremented: z.object({ by: z.number() }) })
        .patches({
          Incremented: ({ data }, state) => ({
            count: state.count + data.by,
          }),
        })
        .build();

      expect(() => act().with(Counter).with(conflicting)).toThrow(
        /Duplicate event "Incremented"/
      );
    });

    it("should throw on duplicate action from slice", () => {
      const conflicting = slice("conflict")
        .with(Counter)
        .events({ NewEvent: ZodEmpty })
        .patches({ NewEvent: () => ({}) })
        .action("Increment", z.object({ by: z.number() }))
        .emit(() => ["NewEvent", {}])
        .build();

      expect(() => act().with(Counter).with(conflicting)).toThrow(
        /Duplicate action "Increment"/
      );
    });

    it("should throw on unknown event in slice reaction", () => {
      const bad = slice("bad")
        .on("NonExistentEvent")
        .do(async () => {})
        .void()
        .build();

      expect(() => act().with(Counter).with(bad)).toThrow(
        /Unknown event "NonExistentEvent"/
      );
    });
  });

  describe("partial state declaration", () => {
    it("should merge two slices contributing different fields to same state", async () => {
      const counting = slice("counting")
        .state("Counter", z.object({ count: z.number() }))
        .init(() => ({ count: 0 }))
        .events({ Incremented: z.object({ amount: z.number() }) })
        .patches({
          Incremented: (e, s) => ({ count: s.count + e.data.amount }),
        })
        .action("increment", z.object({ by: z.number() }))
        .emit(({ by }) => ["Incremented", { amount: by }])
        .build();

      const naming = slice("naming")
        .state("Counter", z.object({ name: z.string() }))
        .init(() => ({ name: "" }))
        .events({ Named: z.object({ name: z.string() }) })
        .patches({ Named: (e) => ({ name: e.data.name }) })
        .action("setName", z.object({ name: z.string() }))
        .emit(({ name }) => ["Named", { name }])
        .build();

      const app = act().with(counting).with(naming).build();

      await app.do("increment", { stream: "s1", actor }, { by: 5 });
      await app.do("setName", { stream: "s1", actor }, { name: "hello" });

      const snap = await app.load("Counter", "s1");
      expect(snap.state.count).toBe(5);
      expect(snap.state.name).toBe("hello");
    });

    it("should load by state name for partially-declared states", async () => {
      const counting = slice("counting")
        .state("MyState", z.object({ value: z.number() }))
        .init(() => ({ value: 0 }))
        .events({ ValueSet: z.object({ value: z.number() }) })
        .patches({ ValueSet: (e) => ({ value: e.data.value }) })
        .action("setValue", z.object({ value: z.number() }))
        .emit(({ value }) => ["ValueSet", { value }])
        .build();

      const app = act().with(counting).build();

      await app.do("setValue", { stream: "s1", actor }, { value: 42 });

      const snap = await app.load("MyState", "s1");
      expect(snap.state.value).toBe(42);
    });

    it("should throw on unknown state name in load", async () => {
      const counting = slice("counting")
        .state("MyState", z.object({ value: z.number() }))
        .init(() => ({ value: 0 }))
        .events({ ValueSet: z.object({ value: z.number() }) })
        .patches({ ValueSet: (e) => ({ value: e.data.value }) })
        .action("setValue", z.object({ value: z.number() }))
        .emit(({ value }) => ["ValueSet", { value }])
        .build();

      const app = act().with(counting).build();

      await expect(app.load("NonExistent", "s1")).rejects.toThrow(
        /Unknown state "NonExistent"/
      );
    });

    it("should compose three partial slices into one state", async () => {
      const sliceA = slice("a")
        .state("Thing", z.object({ x: z.number() }))
        .init(() => ({ x: 0 }))
        .events({ XSet: z.object({ x: z.number() }) })
        .patches({ XSet: (e) => ({ x: e.data.x }) })
        .action("setX", z.object({ x: z.number() }))
        .emit(({ x }) => ["XSet", { x }])
        .build();

      const sliceB = slice("b")
        .state("Thing", z.object({ y: z.number() }))
        .init(() => ({ y: 0 }))
        .events({ YSet: z.object({ y: z.number() }) })
        .patches({ YSet: (e) => ({ y: e.data.y }) })
        .action("setY", z.object({ y: z.number() }))
        .emit(({ y }) => ["YSet", { y }])
        .build();

      const sliceC = slice("c")
        .state("Thing", z.object({ z: z.number() }))
        .init(() => ({ z: 0 }))
        .events({ ZSet: z.object({ z: z.number() }) })
        .patches({ ZSet: (e) => ({ z: e.data.z }) })
        .action("setZ", z.object({ z: z.number() }))
        .emit(({ z }) => ["ZSet", { z }])
        .build();

      const app = act().with(sliceA).with(sliceB).with(sliceC).build();

      await app.do("setX", { stream: "t1", actor }, { x: 1 });
      await app.do("setY", { stream: "t1", actor }, { y: 2 });
      await app.do("setZ", { stream: "t1", actor }, { z: 3 });

      const snap = await app.load("Thing", "t1");
      expect(snap.state.x).toBe(1);
      expect(snap.state.y).toBe(2);
      expect(snap.state.z).toBe(3);
    });

    it("should support reactions with partial states", async () => {
      const reacted = vi.fn().mockResolvedValue(undefined);

      const counting = slice("counting")
        .state("Counter", z.object({ count: z.number() }))
        .init(() => ({ count: 0 }))
        .events({ CountChanged: z.object({ amount: z.number() }) })
        .patches({
          CountChanged: (e, s) => ({ count: s.count + e.data.amount }),
        })
        .action("addCount", z.object({ amount: z.number() }))
        .emit(({ amount }) => ["CountChanged", { amount }])
        .build();

      const monitoring = slice("monitoring")
        .on("CountChanged")
        .do(reacted)
        .build();

      const app = act().with(counting).with(monitoring).build();

      await app.do("addCount", { stream: "s1", actor }, { amount: 10 });
      await app.correlate();
      await app.drain({ leaseMillis: 1 });

      expect(reacted).toHaveBeenCalledTimes(1);
      expect(reacted).toHaveBeenCalledWith(
        expect.objectContaining({
          event: expect.objectContaining({
            name: "CountChanged",
            data: { amount: 10 },
          }),
        })
      );
    });

    it("should throw on duplicate events across partial slices", () => {
      const sliceA = slice("a")
        .state("Thing", z.object({ x: z.number() }))
        .init(() => ({ x: 0 }))
        .events({ SameEvent: z.object({ v: z.number() }) })
        .patches({ SameEvent: (e) => ({ x: e.data.v }) })
        .action("doA", z.object({ v: z.number() }))
        .emit(({ v }) => ["SameEvent", { v }])
        .build();

      const sliceB = slice("b")
        .state("Thing", z.object({ y: z.number() }))
        .init(() => ({ y: 0 }))
        .events({ SameEvent: z.object({ v: z.number() }) })
        .patches({ SameEvent: (e) => ({ y: e.data.v }) })
        .action("doB", z.object({ v: z.number() }))
        .emit(({ v }) => ["SameEvent", { v }])
        .build();

      expect(() => act().with(sliceA).with(sliceB)).toThrow(
        /Duplicate event "SameEvent"/
      );
    });

    it("should throw on duplicate actions across partial slices", () => {
      const sliceA = slice("a")
        .state("Thing", z.object({ x: z.number() }))
        .init(() => ({ x: 0 }))
        .events({ EventA: z.object({ v: z.number() }) })
        .patches({ EventA: (e) => ({ x: e.data.v }) })
        .action("doSame", z.object({ v: z.number() }))
        .emit(({ v }) => ["EventA", { v }])
        .build();

      const sliceB = slice("b")
        .state("Thing", z.object({ y: z.number() }))
        .init(() => ({ y: 0 }))
        .events({ EventB: z.object({ v: z.number() }) })
        .patches({ EventB: (e) => ({ y: e.data.v }) })
        .action("doSame", z.object({ v: z.number() }))
        .emit(({ v }) => ["EventB", { v }])
        .build();

      expect(() => act().with(sliceA).with(sliceB)).toThrow(
        /Duplicate action "doSame"/
      );
    });

    it("should throw when mixing base-state and partial-state patterns", () => {
      const partial = slice("partial")
        .state("Counter", z.object({ extra: z.string() }))
        .init(() => ({ extra: "" }))
        .events({ ExtraSet: z.object({ extra: z.string() }) })
        .patches({ ExtraSet: (e) => ({ extra: e.data.extra }) })
        .action("setExtra", z.object({ extra: z.string() }))
        .emit(({ extra }) => ["ExtraSet", { extra }])
        .build();

      expect(() => act().with(Counter).with(partial)).toThrow(
        /Cannot declare partial state "Counter".*already registered via state\(\) builder/
      );
    });

    it("should produce correct merged init from multiple partial slices", async () => {
      const sliceA = slice("a")
        .state("Merged", z.object({ x: z.number() }))
        .init(() => ({ x: 10 }))
        .events({ Noop1: ZodEmpty })
        .patches({ Noop1: () => ({}) })
        .action("noop1", ZodEmpty)
        .emit(() => ["Noop1", {}])
        .build();

      const sliceB = slice("b")
        .state("Merged", z.object({ y: z.string() }))
        .init(() => ({ y: "hello" }))
        .events({ Noop2: ZodEmpty })
        .patches({ Noop2: () => ({}) })
        .action("noop2", ZodEmpty)
        .emit(() => ["Noop2", {}])
        .build();

      const app = act().with(sliceA).with(sliceB).build();

      // Load without any actions — should get merged init
      const snap = await app.load("Merged", "fresh-stream");
      expect(snap.state.x).toBe(10);
      expect(snap.state.y).toBe("hello");
    });
  });

  describe("diagram", () => {
    it("should generate a mermaid diagram", () => {
      const doubling = slice("doubling")
        .with(Counter)
        .events({
          Doubled: z.object({ by: z.number() }),
        })
        .patches({
          Doubled: ({ data }, state) => ({ count: state.count + data.by * 2 }),
        })
        .action("Double", z.object({ by: z.number() }))
        .emit(({ by }) => ["Doubled", { by }])
        .build();

      const diagram = doubling.diagram();
      expect(diagram).toContain("graph LR");
      expect(diagram).toContain("slice: doubling");
      expect(diagram).toContain("Counter");
      expect(diagram).toContain("Double");
      expect(diagram).toContain("Doubled");
    });

    it("should include reactions in diagram", () => {
      const handler = async function myHandler() {};
      const s = slice("with-reaction")
        .with(Counter)
        .events({ Halved: ZodEmpty })
        .patches({
          Halved: (_, state) => ({ count: Math.floor(state.count / 2) }),
        })
        .action("Halve", ZodEmpty)
        .emit(() => ["Halved", {}])
        .on("Halved")
        .do(handler)
        .void()
        .build();

      const diagram = s.diagram();
      expect(diagram).toContain("Halved");
      expect(diagram).toContain("void");
    });
  });
});
