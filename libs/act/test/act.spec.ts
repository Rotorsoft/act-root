import { z } from "zod";
import { act, sleep, state, store, ZodEmpty } from "../src/index.js";

describe("act", () => {
  const counter = state({ Counter: z.object({ count: z.number() }) })
    .init(() => ({ count: 0 }))
    .emits({ incremented: ZodEmpty, decremented: ZodEmpty, ignored: ZodEmpty })
    .patch({
      incremented: (_, state) => ({ count: state.count + 1 }),
      decremented: (_, state) => ({ count: state.count - 1 }),
      ignored: () => ({}),
    })
    .on({ increment: ZodEmpty })
    .emit(() => ["incremented", {}])
    .on({ decrement: ZodEmpty })
    .emit(() => ["decremented", {}])
    .on({ ignore: ZodEmpty })
    .emit(() => ["ignored", {}])
    .build();

  const dummy = state({ Dummy: z.object({ count: z.number() }) })
    .init(() => ({ count: 0 }))
    .emits({ added: ZodEmpty, ignored2: ZodEmpty })
    .patch({
      added: () => ({ count: 1 }),
      ignored2: () => ({}),
    })
    .on({ add: ZodEmpty })
    .emit(() => ["added", {}])
    .on({ ignore2: ZodEmpty })
    .emit(() => ["ignored2", {}])
    .build();

  const onIncremented = vi.fn().mockImplementation(async () => {
    await sleep(100);
  });
  const onDecremented = vi.fn().mockImplementation(async () => {
    await sleep(100);
    throw new Error("onDecremented failed");
  });

  const app = act()
    .withState(counter)
    .on("incremented")
    .do(onIncremented)
    .on("decremented")
    .do(onDecremented, { maxRetries: 2, blockOnError: true })
    .withState(dummy)
    .on("added")
    .do(() => Promise.resolve())
    .build();

  const actor = { id: "a", name: "a" };

  it("should register and call an event listener", async () => {
    const listener = vi.fn();

    app.on("committed", listener);
    await app.do("increment", { stream: "s", actor }, {});
    expect(listener).toHaveBeenCalled();
  });

  it("should not call removed event listener", async () => {
    const listener = vi.fn();
    app.on("committed", listener);
    app.off("committed", listener);
    await app.do("increment", { stream: "s", actor }, {});
    expect(listener).not.toHaveBeenCalled();
  });

  it("should handle increment and decrement should block", async () => {
    await app.do("decrement", { stream: "s", actor }, {});
    await app.correlate();

    // should drain the first two events...  third event should throw and stop drain
    let drained = await app.drain({ leaseMillis: 1 }); // 1ms leases to test blocking
    expect(drained.acked.length).toBe(1);
    expect(drained.acked[0].at).toBe(1);
    expect(onIncremented).toHaveBeenCalledTimes(2);
    expect(onDecremented).toHaveBeenCalledTimes(1);

    // first fully failed
    drained = await app.drain({ leaseMillis: 1 }); // 1ms leases to test blocking
    console.log("first try", drained);
    expect(drained.acked.length).toBe(0);
    expect(onDecremented).toHaveBeenCalledTimes(2);

    // second fully failed (first retry)
    drained = await app.drain({ leaseMillis: 1 }); // 1ms leases to test blocking
    console.log("second try", drained);
    expect(drained.acked.length).toBe(0);
    expect(drained.blocked.length).toBe(0);
    expect(onDecremented).toHaveBeenCalledTimes(3);

    // third fully failed (second retry) - should block
    drained = await app.drain({ leaseMillis: 1 }); // 1ms leases to test blocking
    console.log("third try", drained);
    expect(drained.acked.length).toBe(0);
    expect(drained.blocked.length).toBe(1);
    expect(onDecremented).toHaveBeenCalledTimes(4);
  });

  it("should not do anything when ignored events are emitted", async () => {
    await app.do("ignore", { stream: "s", actor }, {});
    const drained = await app.drain();
    expect(drained.acked.length).toBe(0);
  });

  it("should start and stop correlation worker, awaiting for interval to trigger correlations", async () => {
    const started = app.start_correlations({}, 10, vi.fn());
    expect(started).toBe(true);
    await sleep(100);
    const retry = app.start_correlations({}, 10, vi.fn());
    expect(retry).toBe(false);
    app.stop_correlations();

    // Should be able to start again after stopping, and callback should be called
    const callback = vi.fn();
    await app.do("increment", { stream: "new stream", actor }, {});
    const restarted = app.start_correlations({}, 10, callback);
    expect(restarted).toBe(true);
    await sleep(100);
    app.stop_correlations();
    expect(callback).toHaveBeenCalled();
  });

  it("should correlate when event has reactions", async () => {
    await app.do("ignore2", { stream: "dummy", actor }, {});
    let correlated = await app.correlate({ stream: "dummy" });
    expect(correlated.leased.length).toBe(0); // won't correlate events without reactions
    await app.do("add", { stream: "dummy", actor }, {});
    correlated = await app.correlate({ stream: "dummy" });
    expect(correlated.leased.length).toBe(1); // added event should correlate stream

    const drained = await app.drain({ streamLimit: 2 });
    expect(drained.fetched.length).toBe(2); // new stream and dummy
    expect(drained.leased.length).toBeGreaterThan(0);
  });

  it("should return empty when drain is already locked", async () => {
    // slow down poll so two concurrent drains overlap
    const originalPoll = store().poll.bind(store());
    const pollSpy = vi
      .spyOn(store(), "poll")
      .mockImplementation(async (lagging, leading) => {
        await sleep(50);
        return originalPoll(lagging, leading);
      });
    const [r1, r2] = await Promise.all([app.drain(), app.drain()]);
    // one of them should have been locked out
    const locked = r1.fetched.length === 0 ? r1 : r2;
    expect(locked.fetched.length).toBe(0);
    expect(locked.leased.length).toBe(0);
    pollSpy.mockRestore();
  });

  it("should cover leading=0 branch when streamLimit=1", async () => {
    // emit an event with a reaction so drain has work
    await app.do("increment", { stream: "ratio-test", actor }, {});
    await app.correlate();
    // streamLimit=1 → lagging=1, leading=0 → covers the leading===0 branch
    const drained = await app.drain({ streamLimit: 1, leaseMillis: 1 });
    expect(drained.fetched.length).toBeLessThanOrEqual(1);
  });

  it("should cover lagging=0 branch in adaptive drain ratio", async () => {
    // Force ratio to 0 so lagging=Math.ceil(0)=0
    (app as any)._drain_lag2lead_ratio = 0;
    await app.do("increment", { stream: "lag0-test", actor }, {});
    await app.correlate();
    const drained = await app.drain({ streamLimit: 1, leaseMillis: 1 });
    expect(drained).toBeDefined();
    // Restore to default
    (app as any)._drain_lag2lead_ratio = 0.5;
  });

  it("should load unregistered state by object (fallback to stateOrName)", async () => {
    // Create a state not registered via .withState()
    const unregistered = state({ Unregistered: z.object({ val: z.number() }) })
      .init(() => ({ val: 0 }))
      .emits({ Evt: ZodEmpty })
      .patch({ Evt: () => ({}) })
      .on({ doEvt: ZodEmpty })
      .emit(() => ["Evt", {}])
      .build();

    // Load it directly — should use the state object itself since name isn't in _states
    const snap = await app.load(unregistered, "nonexistent-stream");
    expect(snap.state.val).toBe(0);
    expect(snap.patches).toBe(0);
  });

  it("should handle unregistered events in drain", async () => {
    // Emit a registered event so this stream gets polled
    await app.do("increment", { stream: "mixed-evt", actor }, {});
    // Also commit an unregistered event to the same stream
    await store().commit("mixed-evt", [{ name: "UnknownEvent", data: {} }], {
      correlation: "c",
      causation: {},
    });
    await app.correlate({ limit: 200 });
    // drain encounters both "incremented" (registered) and "UnknownEvent" (not registered)
    const drained = await app.drain();
    expect(drained).toBeDefined();
  });

  it("should exit drain loop on error", async () => {
    // mock store poll to throw
    const mockedPoll = vi.spyOn(store(), "poll").mockImplementation(() => {
      throw new Error("test");
    });
    const drained = await app.drain();
    expect(drained.leased.length).toBe(0);
    mockedPoll.mockClear();
  });
});
