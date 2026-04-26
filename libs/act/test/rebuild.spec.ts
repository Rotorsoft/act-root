import { z } from "zod";
import { act, dispose, projection, state, store } from "../src/index.js";

describe("Store.reset", () => {
  beforeEach(async () => {
    await store().drop();
  });

  afterAll(async () => {
    await dispose()();
  });

  const actor = { id: "a", name: "a" };
  let streamId = 0;
  const nextStream = () => `reset-test-${++streamId}`;

  const Incremented = z.object({ by: z.number() });

  const Counter = state({ Counter: z.object({ count: z.number() }) })
    .init(() => ({ count: 0 }))
    .emits({ Incremented })
    .patch({
      Incremented: (event, s) => ({ count: s.count + event.data.by }),
    })
    .on({ increment: z.object({ by: z.number() }) })
    .emit((action) => ["Incremented", { by: action.by }])
    .build();

  it("should reset subscribed stream watermarks to -1", async () => {
    const s = store();
    await s.subscribe([{ stream: "a" }, { stream: "b" }, { stream: "c" }]);

    const count = await s.reset(["a", "c"]);
    expect(count).toBe(2);
  });

  it("should return 0 for non-existent streams", async () => {
    const count = await store().reset(["nonexistent"]);
    expect(count).toBe(0);
  });

  it("should return 0 for empty array", async () => {
    const count = await store().reset([]);
    expect(count).toBe(0);
  });

  it("should enable replay of projection after reset", async () => {
    const stream = nextStream();
    const projected: Array<{ by: number }> = [];

    const CounterProjection = projection("counter-proj")
      .on({ Incremented })
      .do(async function project(event) {
        await Promise.resolve();
        projected.push(event.data);
      })
      .build();

    const app = act()
      .withState(Counter)
      .withProjection(CounterProjection)
      .build();

    // Emit events and drain normally
    await app.do("increment", { stream, actor }, { by: 1 });
    await app.do("increment", { stream, actor }, { by: 2 });
    await app.do("increment", { stream, actor }, { by: 3 });
    await app.correlate();
    await app.drain({ eventLimit: 100 });

    expect(projected).toEqual([{ by: 1 }, { by: 2 }, { by: 3 }]);

    // Reset the projection stream and re-drain
    projected.length = 0;
    await store().reset(["counter-proj"]);
    await app.drain({ eventLimit: 100 });

    // All events replayed through the projection
    expect(projected).toEqual([{ by: 1 }, { by: 2 }, { by: 3 }]);
  });

  it("should unblock blocked streams after reset", async () => {
    const stream = nextStream();
    let shouldFail = true;
    const handler = vi.fn(async function failHandler() {
      await Promise.resolve();
      if (shouldFail) throw new Error("fail");
    });

    const FailProjection = projection("fail-proj")
      .on({ Incremented })
      .do(handler)
      .build();

    const app = act().withState(Counter).withProjection(FailProjection).build();

    await app.do("increment", { stream, actor }, { by: 1 });
    await app.correlate();

    // Drain until blocked (max retries = 3)
    for (let i = 0; i < 5; i++) {
      await app.drain({ eventLimit: 100, leaseMillis: 1 });
      await new Promise((r) => setTimeout(r, 5));
    }

    // Fix the handler and reset — app.reset() raises the drain flag.
    shouldFail = false;
    handler.mockClear();
    await app.reset(["fail-proj"]);
    const result = await app.drain({ eventLimit: 100 });

    expect(handler).toHaveBeenCalled();
    expect(result.acked.length).toBeGreaterThan(0);
  });

  it("should replay with batch handler after reset", async () => {
    const stream = nextStream();
    const batchFn = vi.fn().mockResolvedValue(undefined);
    const singleHandler = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(singleHandler, "name", {
      value: "handleIncremented",
    });

    const BatchProjection = projection("batch-reset")
      .on({ Incremented })
      .do(singleHandler)
      .batch(batchFn)
      .build();

    const app = act()
      .withState(Counter)
      .withProjection(BatchProjection)
      .build();

    await app.do("increment", { stream, actor }, { by: 1 });
    await app.do("increment", { stream, actor }, { by: 2 });
    await app.correlate();
    await app.drain({ eventLimit: 100 });

    batchFn.mockClear();
    singleHandler.mockClear();

    // Reset and re-drain
    await store().reset(["batch-reset"]);
    await app.drain({ eventLimit: 100 });

    expect(batchFn).toHaveBeenCalled();
    expect(singleHandler).not.toHaveBeenCalled();
  });

  it("should produce idempotent results on multiple resets", async () => {
    const stream = nextStream();
    const projected: number[] = [];

    const CounterProjection = projection("idempotent-proj")
      .on({ Incremented })
      .do(async function project(event) {
        await Promise.resolve();
        projected.push(event.data.by);
      })
      .build();

    const app = act()
      .withState(Counter)
      .withProjection(CounterProjection)
      .build();

    await app.do("increment", { stream, actor }, { by: 10 });
    await app.do("increment", { stream, actor }, { by: 20 });
    await app.correlate();
    await app.drain({ eventLimit: 100 });

    // First reset + drain
    projected.length = 0;
    await store().reset(["idempotent-proj"]);
    await app.drain({ eventLimit: 100 });
    const firstRun = [...projected];

    // Second reset + drain
    projected.length = 0;
    await store().reset(["idempotent-proj"]);
    await app.drain({ eventLimit: 100 });
    const secondRun = [...projected];

    expect(firstRun).toEqual(secondRun);
    expect(firstRun).toEqual([10, 20]);
  });

  it("should replay events when drain runs after reset on a settled app", async () => {
    const stream = nextStream();
    const projected: number[] = [];

    const CounterProjection = projection("settled-reset-proj")
      .on({ Incremented })
      .do(async function project(event) {
        await Promise.resolve();
        projected.push(event.data.by);
      })
      .build();

    const app = act()
      .withState(Counter)
      .withProjection(CounterProjection)
      .build();

    await app.do("increment", { stream, actor }, { by: 1 });
    await app.do("increment", { stream, actor }, { by: 2 });
    await app.correlate();
    // First drain processes events; second drain leaves the orchestrator
    // fully settled (_needs_drain cleared because nothing left to do).
    await app.drain({ eventLimit: 100 });
    await app.drain({ eventLimit: 100 });

    expect(projected).toEqual([1, 2]);

    projected.length = 0;
    const count = await app.reset(["settled-reset-proj"]);
    expect(count).toBe(1);
    const result = await app.drain({ eventLimit: 100 });

    expect(projected).toEqual([1, 2]);
    expect(result.acked.length).toBe(1);
  });

  it("should replay events when settle runs after reset on a settled app", async () => {
    const stream = nextStream();
    const projected: number[] = [];

    const CounterProjection = projection("settled-reset-settle-proj")
      .on({ Incremented })
      .do(async function project(event) {
        await Promise.resolve();
        projected.push(event.data.by);
      })
      .build();

    const app = act()
      .withState(Counter)
      .withProjection(CounterProjection)
      .build();

    await app.do("increment", { stream, actor }, { by: 7 });
    await app.do("increment", { stream, actor }, { by: 8 });

    await new Promise<void>((resolve) => {
      app.on("settled", () => resolve());
      app.settle();
    });
    expect(projected).toEqual([7, 8]);
    // Second settle drives _needs_drain to false (no work left).
    await app.drain({ eventLimit: 100 });

    projected.length = 0;
    await app.reset(["settled-reset-settle-proj"]);

    await new Promise<void>((resolve) => {
      app.on("settled", () => resolve());
      app.settle();
    });

    expect(projected).toEqual([7, 8]);
  });

  it("app.reset returns 0 and skips arming the drain flag for unknown streams", async () => {
    const app = act().withState(Counter).build();
    const count = await app.reset(["does-not-exist"]);
    expect(count).toBe(0);
    expect((app as unknown as { _needs_drain: boolean })._needs_drain).toBe(
      false
    );
  });

  it("app.reset does not arm the drain flag when the app has no reactions", async () => {
    // Static target subscription happens via withProjection, so we can reset
    // a real stream — but with no reactive events, _needs_drain should stay
    // false (drain would be a no-op anyway).
    const app = act().withState(Counter).build();
    await store().subscribe([{ stream: "no-reactions-proj" }]);
    const count = await app.reset(["no-reactions-proj"]);
    expect(count).toBe(1);
    expect((app as unknown as { _needs_drain: boolean })._needs_drain).toBe(
      false
    );
  });
});
