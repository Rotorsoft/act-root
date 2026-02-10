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
