import { z } from "zod";
import { act, dispose, slice, state, ZodEmpty } from "../src/index.js";

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: ZodEmpty })
  .patch({ Incremented: (_, s) => ({ count: s.count + 1 }) })
  .on({ increment: ZodEmpty })
  .emit(() => ["Incremented", {}])
  .build();

describe("lanes (ACT-1103, slice 1)", () => {
  afterEach(async () => {
    await dispose()();
  });

  it("records declared lanes on the built Act and excludes the implicit default", () => {
    const app = act()
      .withState(Counter)
      .withLane({ name: "slow", leaseMillis: 30_000, streamLimit: 5 })
      .withLane({ name: "fast", cycleMs: 50 })
      .build();

    expect(app.lanes).toHaveLength(2);
    expect(app.lanes.map((l) => l.name)).toEqual(["slow", "fast"]);
    expect(app.lanes[0]).toMatchObject({
      name: "slow",
      leaseMillis: 30_000,
      streamLimit: 5,
    });
    expect(app.lanes[1]).toMatchObject({ name: "fast", cycleMs: 50 });
  });

  it("preserves today's single-lane behavior when no lane is declared", () => {
    const app = act().withState(Counter).build();
    expect(app.lanes).toEqual([]);
  });

  it("rejects re-declaring the reserved 'default' lane name", () => {
    expect(() =>
      act()
        .withState(Counter)
        .withLane({ name: "default" as never })
    ).toThrow(/reserved/);
  });

  it("rejects duplicate lane declarations", () => {
    expect(() =>
      act()
        .withState(Counter)
        .withLane({ name: "slow" })
        .withLane({ name: "slow" as never })
    ).toThrow(/already declared/);
  });

  it("accepts inline .to({lane}) when the lane was declared", () => {
    const app = act()
      .withState(Counter)
      .withLane({ name: "slow" })
      .on("Incremented")
      .do(function react() {
        return Promise.resolve();
      })
      .to({ target: "slow-target", lane: "slow" })
      .build();

    const reaction = app.registry.events.Incremented.reactions.get("react");
    expect(reaction?.resolver).toEqual({
      target: "slow-target",
      lane: "slow",
    });
  });

  it("compile-time-rejects slice .to({lane}) referencing an undeclared lane", () => {
    // Slices now carry their own TLanes union via .withLane(...). The
    // builder narrows .to({lane}) against that union, so an undeclared
    // lane name fails compile — runtime never sees it. The @ts-expect-error
    // markers below are the live assertion: they fail to compile if the
    // narrowing breaks.
    /* eslint-disable @typescript-eslint/no-unused-expressions */
    () =>
      slice<typeof Counter>()
        .withState(Counter)
        .on("Incremented")
        .do(function staleHandler() {
          return Promise.resolve();
        })
        // @ts-expect-error "ghost" not declared on this slice
        .to({ target: "anywhere", lane: "ghost" })
        .build();
  });

  it("type-checks slice .to({lane}) against the slice's own withLane declarations", () => {
    const WebhookSlice = slice<typeof Counter>()
      .withState(Counter)
      .withLane({ name: "slow", leaseMillis: 30_000 })
      .on("Incremented")
      .do(function ship() {
        return Promise.resolve();
      })
      .to({ target: "outbox", lane: "slow" })
      .build();

    expect(WebhookSlice.lanes).toEqual([{ name: "slow", leaseMillis: 30_000 }]);
    const app = act().withState(Counter).withSlice(WebhookSlice).build();
    expect(app.lanes).toEqual([{ name: "slow", leaseMillis: 30_000 }]);
  });

  it("allows slice-declared 'default' lane references even without withLane", () => {
    const ok = slice<typeof Counter>()
      .withState(Counter)
      .on("Incremented")
      .do(function defaultHandler() {
        return Promise.resolve();
      })
      .to({ target: "default-target", lane: "default" })
      .build();

    expect(() => act().withSlice(ok).build()).not.toThrow();
  });

  it("rejects re-declaring 'default' on a slice", () => {
    expect(() =>
      slice<typeof Counter>()
        .withState(Counter)
        .withLane({ name: "default" as never })
    ).toThrow(/reserved/);
  });

  it("rejects duplicate slice-declared lane names", () => {
    expect(() =>
      slice<typeof Counter>()
        .withState(Counter)
        .withLane({ name: "slow" })
        .withLane({ name: "slow" as never })
    ).toThrow(/already declared/);
  });

  it("rejects slice/Act lane configs that disagree on timing", () => {
    const sliceA = slice<typeof Counter>()
      .withState(Counter)
      .withLane({ name: "slow", leaseMillis: 30_000 })
      .build();

    expect(() =>
      act()
        .withState(Counter)
        .withLane({ name: "slow", leaseMillis: 60_000 })
        .withSlice(sliceA)
        .build()
    ).toThrow(/different config/);
  });

  it("accepts matching slice/Act lane configs (idempotent merge)", () => {
    const sliceA = slice<typeof Counter>()
      .withState(Counter)
      .withLane({ name: "slow", leaseMillis: 30_000 })
      .build();

    const app = act()
      .withState(Counter)
      .withLane({ name: "slow", leaseMillis: 30_000 })
      .withSlice(sliceA)
      .build();

    expect(app.lanes).toHaveLength(1);
    expect(app.lanes[0]).toMatchObject({ name: "slow", leaseMillis: 30_000 });
  });

  it("rejects ActOptions.onlyLanes references to undeclared lanes", () => {
    expect(() =>
      act()
        .withState(Counter)
        .withLane({ name: "slow" })
        .build({ onlyLanes: ["slow", "ghost" as never] })
    ).toThrow(/undeclared lane.*ghost/);
  });

  it("accepts onlyLanes that name only the implicit 'default' lane", () => {
    expect(() =>
      act()
        .withState(Counter)
        .build({ onlyLanes: ["default"] })
    ).not.toThrow();
  });

  it("accepts an empty onlyLanes array as a no-op (no validation tripped)", () => {
    expect(() =>
      act().withState(Counter).build({ onlyLanes: [] })
    ).not.toThrow();
  });

  it("runtime gate still rejects an undeclared lane when types are bypassed", () => {
    // Static narrowing makes this branch unreachable for properly-typed
    // slices, but it stays as a backstop for slices compiled against older
    // type definitions (npm-installed older versions, registry manipulation
    // by tooling). Exercising it requires a deliberate `as any` cast.
    const stale = slice<typeof Counter>()
      .withState(Counter)
      .on("Incremented")
      .do(function staleHandler() {
        return Promise.resolve();
      })
      // Bypass the strict typing — simulates a slice built against the
      // pre-1103 SliceBuilder.
      .to({ target: "anywhere", lane: "ghost" as never })
      .build();

    expect(() => act().withSlice(stale).build()).toThrow(
      /undeclared lane "ghost"/
    );
  });

  it("type-checks dynamic resolvers' lane return against the slice's TLanes", () => {
    // Dynamic resolvers thread the same TLanes generic — the function's
    // return shape is `Resolved<TLanes> | undefined`, so an undeclared
    // lane fails compile. The @ts-expect-error below is the live assertion.
    /* eslint-disable @typescript-eslint/no-unused-expressions */
    () =>
      slice<typeof Counter>()
        .withState(Counter)
        .on("Incremented")
        .do(function dynamicHandler() {
          return Promise.resolve();
        })
        // @ts-expect-error dynamic resolver returns lane "ghost" not in declared set
        .to(() => ({ target: "x", lane: "ghost" }));

    // Positive case: declared lane in dynamic resolver compiles cleanly.
    const ok = slice<typeof Counter>()
      .withState(Counter)
      .withLane({ name: "slow" })
      .on("Incremented")
      .do(function dynamicSlow() {
        return Promise.resolve();
      })
      .to((event) => ({ target: `slow-${event.stream}`, lane: "slow" }))
      .build();

    expect(() => act().withSlice(ok).build()).not.toThrow();
  });

  it("rejects two static reactions targeting the same stream with different lanes", () => {
    function handlerA() {
      return Promise.resolve();
    }
    function handlerB() {
      return Promise.resolve();
    }
    expect(() =>
      act()
        .withState(Counter)
        .withLane({ name: "slow" })
        .withLane({ name: "fast" })
        .on("Incremented")
        .do(handlerA)
        .to({ target: "shared", lane: "slow" })
        .on("Incremented")
        .do(handlerB)
        .to({ target: "shared", lane: "fast" })
        .build()
    ).toThrow(/conflicting lane assignments/);
  });

  it("rejects when one reaction names a lane and another leaves it implicit", () => {
    function handlerA() {
      return Promise.resolve();
    }
    function handlerB() {
      return Promise.resolve();
    }
    // Direction A: lane-first, then no-lane (existing.lane defined, incoming undefined)
    expect(() =>
      act()
        .withState(Counter)
        .withLane({ name: "slow" })
        .on("Incremented")
        .do(handlerA)
        .to({ target: "shared", lane: "slow" })
        .on("Incremented")
        .do(handlerB)
        .to("shared")
        .build()
    ).toThrow(/conflicting lane assignments/);
    // Direction B: no-lane-first, then lane (existing.lane undefined, incoming defined)
    function handlerC() {
      return Promise.resolve();
    }
    function handlerD() {
      return Promise.resolve();
    }
    expect(() =>
      act()
        .withState(Counter)
        .withLane({ name: "slow" })
        .on("Incremented")
        .do(handlerC)
        .to("shared2")
        .on("Incremented")
        .do(handlerD)
        .to({ target: "shared2", lane: "slow" })
        .build()
    ).toThrow(/conflicting lane assignments/);
  });

  it("spawns one DrainController per active lane with the implicit default", () => {
    const app = act()
      .withState(Counter)
      .withLane({ name: "slow", leaseMillis: 30_000, streamLimit: 7 })
      .build();
    const controllers = (
      app as unknown as {
        _drain_controllers: Map<
          string,
          { lane: string | undefined; armed: boolean }
        >;
      }
    )._drain_controllers;
    expect([...controllers.keys()].sort()).toEqual(["default", "slow"]);
    // With multiple lanes active, each controller's lane is set so claim()
    // filters per-lane. The single-default-only case keeps lane=undefined.
    expect(controllers.get("default")?.lane).toBe("default");
    expect(controllers.get("slow")?.lane).toBe("slow");
  });

  it("keeps a single controller with lane=undefined when no lanes are declared", () => {
    const app = act().withState(Counter).build();
    const controllers = (
      app as unknown as {
        _drain_controllers: Map<string, { lane: string | undefined }>;
      }
    )._drain_controllers;
    expect([...controllers.keys()]).toEqual(["default"]);
    expect(controllers.get("default")?.lane).toBeUndefined();
  });

  it("honors ActOptions.onlyLanes — excluded lanes get no controller", () => {
    const app = act()
      .withState(Counter)
      .withLane({ name: "slow" })
      .withLane({ name: "fast" })
      .build({ onlyLanes: ["slow"] });
    const controllers = (
      app as unknown as { _drain_controllers: Map<string, unknown> }
    )._drain_controllers;
    expect([...controllers.keys()]).toEqual(["slow"]);
  });

  it("auto-starts a per-lane worker when cycleMs is declared", async () => {
    const app = act()
      .withState(Counter)
      .withLane({ name: "fast", cycleMs: 5 })
      .build();
    const controllers = (
      app as unknown as {
        _drain_controllers: Map<
          string,
          { lane: string | undefined; stop: () => void } & {
            _worker: unknown;
          }
        >;
      }
    )._drain_controllers;
    expect(controllers.get("fast")?._worker).toBeDefined();
    expect(controllers.get("default")?._worker).toBeUndefined();
  });

  it("auto-fires the per-lane worker — armed drains are picked up on schedule", async () => {
    const app = act()
      .withState(Counter)
      .withLane({ name: "fast", cycleMs: 5, leaseMillis: 100 })
      .on("Incremented")
      .do(async function noop() {})
      .to({ target: "out", lane: "fast" })
      .build();
    await app.do(
      "increment",
      { stream: "x", actor: { id: "a", name: "a" } },
      {}
    );
    await app.correlate();
    // Let the worker tick a couple of times; armed → drain → ack.
    await new Promise<void>((r) => setTimeout(r, 50));
    const ctrl = (
      app as unknown as {
        _drain_controllers: Map<string, { armed: boolean }>;
      }
    )._drain_controllers.get("fast");
    expect(ctrl?.armed).toBe(false);
  });

  it("shutdown stops every per-lane worker", async () => {
    const app = act()
      .withState(Counter)
      .withLane({ name: "fast", cycleMs: 5 })
      .withLane({ name: "slow", cycleMs: 1_000 })
      .build();
    const controllers = (
      app as unknown as {
        _drain_controllers: Map<
          string,
          { _worker: unknown; _stopped: boolean }
        >;
      }
    )._drain_controllers;
    expect(controllers.get("fast")?._worker).toBeDefined();
    expect(controllers.get("slow")?._worker).toBeDefined();
    await app.shutdown();
    expect(controllers.get("fast")?._worker).toBeUndefined();
    expect(controllers.get("slow")?._worker).toBeUndefined();
    expect(controllers.get("fast")?._stopped).toBe(true);
  });

  it("start() is a no-op after stop() — once stopped, the controller stays stopped", () => {
    const app = act().withState(Counter).build();
    const ctrl = (
      app as unknown as {
        _drain_controllers: Map<
          string,
          {
            stop: () => void;
            start: (ms: number) => void;
            _worker: unknown;
            _stopped: boolean;
          }
        >;
      }
    )._drain_controllers.get("default");
    ctrl?.stop();
    expect(ctrl?._stopped).toBe(true);
    ctrl?.start(5);
    expect(ctrl?._worker).toBeUndefined();
  });

  it("start() is a no-op when the worker is already running", () => {
    const app = act()
      .withState(Counter)
      .withLane({ name: "fast", cycleMs: 5 })
      .build();
    const ctrl = (
      app as unknown as {
        _drain_controllers: Map<
          string,
          { start: (ms: number) => void; _worker: unknown }
        >;
      }
    )._drain_controllers.get("fast");
    const before = ctrl?._worker;
    ctrl?.start(10);
    expect(ctrl?._worker).toBe(before);
  });

  it("do() arms only the lane whose reactions match the committed event", async () => {
    // Two lanes, two reactions, each on a different event. Committing
    // an event reactive to only one lane must not arm the other lane.
    const TwoEvents = state({
      TwoEvents: z.object({ count: z.number() }),
    })
      .init(() => ({ count: 0 }))
      .emits({ FastTick: ZodEmpty, SlowTick: ZodEmpty })
      .patch({
        FastTick: (_, s) => ({ count: s.count + 1 }),
        SlowTick: (_, s) => ({ count: s.count + 1 }),
      })
      .on({ fastTick: ZodEmpty })
      .emit(() => ["FastTick", {}])
      .on({ slowTick: ZodEmpty })
      .emit(() => ["SlowTick", {}])
      .build();

    const app = act()
      .withState(TwoEvents)
      .withLane({ name: "slow" })
      .withLane({ name: "fast" })
      .on("FastTick")
      .do(async function fastHandler() {})
      .to({ target: "fast-out", lane: "fast" })
      .on("SlowTick")
      .do(async function slowHandler() {})
      .to({ target: "slow-out", lane: "slow" })
      .build();
    const controllers = (
      app as unknown as {
        _drain_controllers: Map<string, { armed: boolean }>;
      }
    )._drain_controllers;

    await app.do(
      "fastTick",
      { stream: "x", actor: { id: "a", name: "a" } },
      {}
    );
    expect(controllers.get("fast")?.armed).toBe(true);
    expect(controllers.get("slow")?.armed).toBe(false);
    expect(controllers.get("default")?.armed).toBe(false);
  });

  it("do() arms every lane when the event has a dynamic resolver", async () => {
    // A dynamic resolver makes the lane opaque at classify time, so
    // `_event_to_lanes` records "all" — committing the event arms
    // every controller (fallback path).
    const app = act()
      .withState(Counter)
      .withLane({ name: "fast" })
      .withLane({ name: "slow" })
      .on("Incremented")
      .do(async function dyn() {})
      .to((event) => ({ target: `dyn-${event.stream}`, lane: "fast" }))
      .build();
    const controllers = (
      app as unknown as {
        _drain_controllers: Map<string, { armed: boolean }>;
      }
    )._drain_controllers;

    await app.do(
      "increment",
      { stream: "y", actor: { id: "a", name: "a" } },
      {}
    );
    expect(controllers.get("fast")?.armed).toBe(true);
    expect(controllers.get("slow")?.armed).toBe(true);
    expect(controllers.get("default")?.armed).toBe(true);
  });

  it("post-drain stop check — stop() called during a tick prevents re-scheduling", async () => {
    // The acked listener fires inside drain(). Calling shutdown() from
    // there flips `_stopped`; the tick then takes the post-drain
    // early-return branch.
    const app = act()
      .withState(Counter)
      .withLane({ name: "fast", cycleMs: 5, leaseMillis: 100 })
      .on("Incremented")
      .do(async function noop() {})
      .to({ target: "stop-mid-tick", lane: "fast" })
      .build();
    app.on("acked", () => {
      void app.shutdown();
    });
    await app.do(
      "increment",
      { stream: "x", actor: { id: "a", name: "a" } },
      {}
    );
    await app.correlate();
    await new Promise<void>((r) => setTimeout(r, 50));
    const ctrl = (
      app as unknown as {
        _drain_controllers: Map<
          string,
          { _worker: unknown; _stopped: boolean }
        >;
      }
    )._drain_controllers.get("fast");
    expect(ctrl?._stopped).toBe(true);
    expect(ctrl?._worker).toBeUndefined();
  });
});
