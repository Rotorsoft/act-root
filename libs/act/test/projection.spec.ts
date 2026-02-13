import { z } from "zod";
import {
  act,
  isProjection,
  projection,
  slice,
  state,
  store,
} from "../src/index.js";

describe("projection", () => {
  beforeEach(async () => {
    await store().drop();
  });

  const actor = { id: "a", name: "a" };
  let streamId = 0;
  const nextStream = () => `proj-test-${++streamId}`;

  const Incremented = z.object({ by: z.number() });
  const Labeled = z.object({ label: z.string() });

  const Counter = state("Counter", z.object({ count: z.number() }))
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
      .do(async () => {})
      .build();

    expect(p._tag).toBe("Projection");
    expect(p.events["Incremented"]).toBeDefined();
    expect(p.events["Incremented"].reactions.size).toBe(1);
  });

  it("should identify projections with isProjection()", () => {
    const p = projection("target")
      .on({ Incremented })
      .do(async () => {})
      .build();

    expect(isProjection(p)).toBe(true);
    expect(isProjection(null)).toBe(false);
    expect(isProjection({ _tag: "Slice" })).toBe(false);
  });

  it("should use default target from projection(target)", () => {
    const p = projection("counters")
      .on({ Incremented })
      .do(async () => {})
      .build();

    const [reaction] = [...p.events["Incremented"].reactions.values()];
    expect(reaction.resolver).toEqual({ target: "counters" });
  });

  it("should fall back to _this_ resolver when no default target", () => {
    const p = projection()
      .on({ Incremented })
      .do(async () => {})
      .build();

    const [reaction] = [...p.events["Incremented"].reactions.values()];
    // _this_ is a function resolver
    expect(typeof reaction.resolver).toBe("function");
  });

  it("should allow per-handler .to() to override default target", () => {
    const p = projection("default-target")
      .on({ Incremented })
      .do(async () => {})
      .to("override-target")
      .build();

    const [reaction] = [...p.events["Incremented"].reactions.values()];
    expect(reaction.resolver).toEqual({ target: "override-target" });
  });

  it("should allow per-handler .to() with function resolver", () => {
    const resolver = (event: any) => ({ target: event.stream });
    const p = projection("default-target")
      .on({ Incremented })
      .do(async () => {})
      .to(resolver)
      .build();

    const [reaction] = [...p.events["Incremented"].reactions.values()];
    expect(reaction.resolver).toBe(resolver);
  });

  it("should allow per-handler .void() to override default target", () => {
    const p = projection("default-target")
      .on({ Incremented })
      .do(async () => {})
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

  it("should generate reaction names for anonymous handlers", () => {
    const p = projection("target")
      .on({ Incremented })
      .do(async () => {})
      .build();

    const [name] = [...p.events["Incremented"].reactions.keys()];
    expect(name).toBe("Incremented_0");
  });

  it("should register multiple event handlers with default target", () => {
    const p = projection("read-model")
      .on({ Incremented })
      .do(async () => {})
      .on({ Labeled })
      .do(async () => {})
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

  it("should merge projection reactions into act() via .with()", async () => {
    const stream = nextStream();
    const projected = vi.fn();

    const CounterProjection = projection("counters")
      .on({ Incremented })
      .do(async function project(event) {
        await Promise.resolve();
        projected(event.data);
      })
      .build();

    const app_ = act().with(Counter).with(CounterProjection).build();

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
      .with(Counter)
      .on("Incremented")
      .do(sliceHandler)
      .build();

    const CounterProjection = projection("counters")
      .on({ Incremented })
      .do(projHandler)
      .build();

    const app_ = act().with(CounterSlice).with(CounterProjection).build();

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

  it("should register projection-only events not from any state", () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const ExternalEvent = z.object({ source: z.string() });

    const ExternalProjection = projection("external")
      .on({ ExternalEvent })
      .do(handler)
      .build();

    const app_ = act().with(Counter).with(ExternalProjection).build();

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
      .do(async () => {});
    expect(b.events).toBeDefined();
    expect(b.events["Foo"]).toBeDefined();
    expect(b.events["Foo"].schema).toBeDefined();
  });
});
