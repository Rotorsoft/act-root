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
