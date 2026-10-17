import { z } from "zod";
import { act, log, sleep, state, store, ZodEmpty } from "../src/index.js";
import { DEFAULT_BACKOFF } from "../src/internal/config.js";

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
    .do(function handleAdded() {
      return Promise.resolve();
    })
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
    // Retries wait the default backoff; jump the clock past it (timers stay
    // real) instead of waiting it out.
    vi.useFakeTimers({ toFake: ["Date"] });
    const past_backoff = () =>
      vi.setSystemTime(Date.now() + DEFAULT_BACKOFF.baseMs + 1);
    await app.do("decrement", { stream: "s", actor }, {});
    await app.correlate();

    // should drain the first two events...  third event should throw and stop drain
    // The handled prefix lands with the retry schedule, so it is not
    // reported as acked; the watermark shows it.
    let drained = await app.drain();
    expect(drained.acked.length).toBe(0);
    let at: number | undefined;
    await store().query_streams((p) => {
      if (p.stream === "s") at = p.at;
    });
    expect(at).toBe(1);
    expect(onIncremented).toHaveBeenCalledTimes(2);
    expect(onDecremented).toHaveBeenCalledTimes(1);

    // second attempt (first retry)
    past_backoff();
    drained = await app.drain();
    expect(drained.acked.length).toBe(0);
    expect(onDecremented).toHaveBeenCalledTimes(2);

    // third attempt (second retry) - the handled prefix did not refill the
    // budget, so maxRetries: 2 blocks here
    past_backoff();
    drained = await app.drain();
    expect(drained.acked.length).toBe(0);
    expect(drained.blocked.length).toBe(1);
    expect(onDecremented).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("should not do anything when ignored events are emitted", async () => {
    await app.do("ignore", { stream: "s", actor }, {});
    // correlate should skip void reactions (resolver returns undefined)
    const { subscribed } = await app.correlate({ limit: 200 });
    expect(subscribed).toBe(0); // void reactions don't create subscriptions
    const drained = await app.drain();
    expect(drained.acked.length).toBe(0);
  });

  it("should skip drain when committed events have no reactions", async () => {
    // Warm up: drain reactive events until fully caught up
    await app.do("add", { stream: "s2", actor }, {});
    await app.correlate();
    // Drain until nothing left (InMemoryStore may need multiple passes)
    let d = await app.drain();
    while (d.acked.length || d.blocked.length) {
      d = await app.drain();
    }

    // Caught up. A non-reactive event must not arm the drain.
    await app.do("ignore2", { stream: "s2", actor }, {});
    const skipped = await app.drain();
    expect(skipped.fetched.length).toBe(0);
    expect(skipped.leased.length).toBe(0);

    // A reactive event arms it and drains normally
    await app.do("add", { stream: "s2", actor }, {});
    await app.correlate();
    const drained = await app.drain();
    expect(drained.acked.length).toBeGreaterThan(0);
  });

  it("should drain when batch mixes non-reactive and reactive events", async () => {
    // non-reactive event alone would skip, but a reactive event in the same batch forces drain
    await app.do("ignore2", { stream: "s3", actor }, {});
    await app.do("add", { stream: "s3", actor }, {});
    await app.correlate();
    const drained = await app.drain();
    expect(drained.acked.length).toBeGreaterThan(0);
  });

  it("should emit settled even when drain is skipped", async () => {
    const settled = vi.fn();
    app.on("settled", settled);
    // non-reactive event — drain will be skipped
    await app.do("ignore2", { stream: "s4", actor }, {});
    app.settle({ debounceMs: 1 });
    await sleep(100);
    expect(settled).toHaveBeenCalled();
    app.off("settled", settled);
  });

  it("should start and stop correlation worker, awaiting for interval to trigger correlations", async () => {
    const started = app.start_correlations({}, 10);
    expect(started).toBe(true);
    await sleep(100);
    const retry = app.start_correlations({}, 10);
    expect(retry).toBe(false);
    app.stop_correlations();

    // Starts again after stopping, and each tick settles what it finds
    const settled = vi.fn();
    app.on("settled", settled);
    await app.do("increment", { stream: "new stream", actor }, {});
    const restarted = app.start_correlations({}, 10);
    expect(restarted).toBe(true);
    await vi.waitFor(() => expect(settled).toHaveBeenCalled());
    app.stop_correlations();
    app.off("settled", settled);
  });

  it("should log errors thrown by correlate inside the polling worker", async () => {
    // App with a dynamic resolver so correlate() calls store().query()
    const s = state({ PollErr: z.object({ n: z.number() }) })
      .init(() => ({ n: 0 }))
      .emits({ PollErrEvt: ZodEmpty })
      .patch({ PollErrEvt: () => ({}) })
      .on({ doPollErr: ZodEmpty })
      .emit(() => ["PollErrEvt", {}])
      .build();

    const errApp = act()
      .withState(s)
      .on("PollErrEvt")
      .do(function handlePollErrEvt() {
        return Promise.resolve();
      })
      .to((event) => ({ target: `poll-${event.stream}` }))
      .build();

    await errApp.do("doPollErr", { stream: "p1", actor }, {});

    const querySpy = vi
      .spyOn(store(), "query")
      .mockRejectedValue(new Error("query exploded"));
    const errorSpy = vi.spyOn(log(), "error").mockImplementation(() => {});

    const started = errApp.start_correlations({}, 10);
    expect(started).toBe(true);
    await sleep(50);
    errApp.stop_correlations();

    expect(errorSpy).toHaveBeenCalled();
    const arg = errorSpy.mock.calls[0]?.[0] as unknown as Error;
    expect(arg.message).toBe("query exploded");

    querySpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("should correlate when event has reactions", async () => {
    await app.do("ignore2", { stream: "dummy", actor }, {});
    let correlated = await app.correlate({ stream: "dummy" });
    expect(correlated.subscribed).toBe(0); // won't correlate events without reactions
    await app.do("add", { stream: "dummy", actor }, {});
    correlated = await app.correlate({ stream: "dummy" });
    expect(correlated.subscribed).toBe(1); // added event should correlate stream

    const drained = await app.drain({ streamLimit: 2 });
    expect(drained.fetched.length).toBeGreaterThan(0);
    expect(drained.leased.length).toBeGreaterThan(0);
  });

  it("should return empty when drain is already locked", async () => {
    // slow down claim so two concurrent drains overlap
    const originalClaim = store().claim.bind(store());
    const claimSpy = vi
      .spyOn(store(), "claim")
      .mockImplementation(async (lagging, leading, by, millis) => {
        await sleep(50);
        return originalClaim(lagging, leading, by, millis);
      });
    const [r1, r2] = await Promise.all([app.drain(), app.drain()]);
    // one of them should have been locked out
    const locked = r1.fetched.length === 0 ? r1 : r2;
    expect(locked.fetched.length).toBe(0);
    expect(locked.leased.length).toBe(0);
    claimSpy.mockRestore();
  });

  it("drains with streamLimit 1, which leaves no leading slot", async () => {
    // emit an event with a reaction so drain has work
    await app.do("increment", { stream: "ratio-test", actor }, {});
    await app.correlate();
    // streamLimit 1 → one lagging slot, no leading slot
    const drained = await app.drain({ streamLimit: 1 });
    expect(drained.fetched.length).toBeLessThanOrEqual(1);
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

  it("should handle dynamic correlate where targets already subscribed", async () => {
    // Build a separate app with a dynamic resolver
    const dynState = state({ Dyn: z.object({ n: z.number() }) })
      .init(() => ({ n: 0 }))
      .emits({ DynEvt: ZodEmpty })
      .patch({ DynEvt: () => ({}) })
      .on({ doDyn: ZodEmpty })
      .emit(() => ["DynEvt", {}])
      .build();

    const dynApp = act()
      .withState(dynState)
      .on("DynEvt")
      .do(function handleDynEvt() {
        return Promise.resolve();
      })
      .to((event) => ({ target: `dyn-${event.stream}` }))
      .build();

    await dynApp.do("doDyn", { stream: "x", actor }, {});
    // First correlate discovers "dyn-x"
    const r1 = await dynApp.correlate({ limit: 100 });
    expect(r1.subscribed).toBe(1);
    // Second correlate — same events, target already subscribed
    // Reset checkpoint to force re-scan
    (dynApp as any)._correlate._checkpoint = -1;
    (dynApp as any)._correlate._dynamic_subscriptions.delete("dyn-x");
    const r2 = await dynApp.correlate({ limit: 100 });
    expect(r2.subscribed).toBe(0); // already subscribed from r1
  });

  it("should not advance checkpoint if subscribe fails", async () => {
    const dynState = state({ Dyn2: z.object({ n: z.number() }) })
      .init(() => ({ n: 0 }))
      .emits({ Dyn2Evt: ZodEmpty })
      .patch({ Dyn2Evt: () => ({}) })
      .on({ doDyn2: ZodEmpty })
      .emit(() => ["Dyn2Evt", {}])
      .build();

    const dynApp = act()
      .withState(dynState)
      .on("Dyn2Evt")
      .do(function handleDyn2Evt() {
        return Promise.resolve();
      })
      .to((event) => ({ target: `dyn2-${event.stream}` }))
      .build();

    await dynApp.do("doDyn2", { stream: "y", actor }, {});

    // Mock subscribe to fail
    const subscribeSpy = vi
      .spyOn(store(), "subscribe")
      .mockRejectedValueOnce(new Error("subscribe failed"));

    // First correlate should throw — checkpoint must NOT advance
    const checkpoint = (dynApp as any)._correlate._checkpoint;
    await expect(dynApp.correlate({ limit: 100 })).rejects.toThrow(
      "subscribe failed"
    );
    expect((dynApp as any)._correlate._checkpoint).toBe(checkpoint);

    // Restore subscribe
    subscribeSpy.mockRestore();

    // Second correlate should re-scan the same events and succeed
    const r = await dynApp.correlate({ limit: 100 });
    expect(r.subscribed).toBe(1);
  });

  describe("settle", () => {
    it("should debounce multiple rapid calls into a single settle cycle", async () => {
      const settledListener = vi.fn();
      app.on("settled", settledListener);

      await app.do("increment", { stream: "debounce-test", actor }, {});
      // Rapid-fire settle calls — only the last timer fires
      app.settle({ debounceMs: 20 });
      app.settle({ debounceMs: 20 });
      app.settle({ debounceMs: 20 });

      // Wait for debounce + processing
      await sleep(300);
      expect(settledListener).toHaveBeenCalledTimes(1);
      const drain = settledListener.mock.calls[0][0];
      expect(drain).toHaveProperty("fetched");
      expect(drain).toHaveProperty("leased");
      expect(drain).toHaveProperty("acked");
      expect(drain).toHaveProperty("blocked");

      app.off("settled", settledListener);
    });

    it("should emit 'settled' event after reactions complete", async () => {
      const settledListener = vi.fn();
      app.on("settled", settledListener);

      await app.do("increment", { stream: "settled-event", actor }, {});
      app.settle({ debounceMs: 5 });

      await sleep(300);
      expect(settledListener).toHaveBeenCalledTimes(1);

      app.off("settled", settledListener);
    });

    it("should respect custom options", async () => {
      const settledListener = vi.fn();
      app.on("settled", settledListener);

      await app.do("increment", { stream: "settle-opts", actor }, {});
      app.settle({
        debounceMs: 5,
        correlate: { after: -1, limit: 50 },
        maxPasses: 2,
        streamLimit: 5,
        eventLimit: 5,
      });

      await sleep(300);
      expect(settledListener).toHaveBeenCalledTimes(1);

      app.off("settled", settledListener);
    });

    it("should stop_settling cancel a pending timer", async () => {
      const settledListener = vi.fn();
      app.on("settled", settledListener);
      const spy = vi.spyOn(app, "correlate");

      app.settle({ debounceMs: 50 });
      app.stop_settling(); // cancels before it fires
      await sleep(100);

      expect(spy).not.toHaveBeenCalled();
      expect(settledListener).not.toHaveBeenCalled();
      spy.mockRestore();
      app.off("settled", settledListener);
    });

    it("uses ActOptions.settleDebounceMs as default when settle() is called with no options", async () => {
      const customApp = act().withState(counter).build({ settleDebounceMs: 5 });
      const settledListener = vi.fn();
      customApp.on("settled", settledListener);

      await customApp.do(
        "increment",
        { stream: "default-debounce", actor },
        {}
      );
      // No debounceMs passed — should use the 5ms default from ActOptions
      customApp.settle();
      await sleep(150);
      expect(settledListener).toHaveBeenCalledTimes(1);

      customApp.off("settled", settledListener);
    });

    it("should not emit settled when maxPasses is 0", async () => {
      const settledListener = vi.fn();
      app.on("settled", settledListener);

      app.settle({ debounceMs: 1, maxPasses: 0 });
      await sleep(100);
      expect(settledListener).not.toHaveBeenCalled();

      app.off("settled", settledListener);
    });

    it("should keep draining when correlate yields no new subs but drain is still acking", async () => {
      // Regression: previous behavior broke after one pass when correlate
      // returned 0 subscriptions, even if drain was still paginating work.
      // That made settle a no-op for catch-up scenarios (e.g. after reset).
      const settledListener = vi.fn();
      app.on("settled", settledListener);

      const correlateSpy = vi
        .spyOn(app, "correlate")
        .mockResolvedValue({ subscribed: 0, last_id: 0 });
      // Drain leases and acks on the first 2 passes, then nothing → loop exits.
      let drainCount = 0;
      const drainSpy = vi
        .spyOn(app as any, "_drain_pass")
        .mockImplementation(() => {
          drainCount++;
          const work =
            drainCount <= 2
              ? [
                  {
                    stream: "x",
                    source: "x",
                    at: drainCount,
                    by: "t",
                    retry: 0,
                    lagging: false,
                  },
                ]
              : [];
          return Promise.resolve({
            fetched: [],
            leased: work,
            acked: work,
            blocked: [],
          });
        });

      app.settle({ debounceMs: 1, maxPasses: 10 });
      await sleep(300);
      expect(settledListener).toHaveBeenCalledTimes(1);
      // 2 productive passes + 1 final empty pass that triggers the exit
      expect(drainCount).toBe(3);

      correlateSpy.mockRestore();
      drainSpy.mockRestore();
      app.off("settled", settledListener);
    });

    it("should handle errors in settle gracefully", async () => {
      await app.do("increment", { stream: "settle-error", actor }, {});
      const spy = vi
        .spyOn(store(), "query")
        .mockRejectedValue(new Error("settle-error"));

      const errors: unknown[] = [];
      const onError = ({ error }: { error: unknown }) => errors.push(error);
      app.on("error", onError);
      const settledListener = vi.fn();
      app.on("settled", settledListener);

      app.settle({ debounceMs: 1 });
      await sleep(50);

      // settle caught the error and surfaced it, without settling.
      expect(errors.map(String)).toEqual(["Error: settle-error"]);
      expect(settledListener).not.toHaveBeenCalled();
      spy.mockRestore();
      app.off("error", onError);
      app.off("settled", settledListener);
    });
  });

  it("should query events with callback", async () => {
    await app.do("increment", { stream: "query-cb", actor }, {});
    const events: any[] = [];
    const result = await app.query({ stream: "query-cb" }, (e) =>
      events.push(e)
    );
    expect(result.count).toBeGreaterThan(0);
    expect(result.first).toBeDefined();
    expect(result.last).toBeDefined();
    expect(events.length).toBe(result.count);
  });

  it("should load state by string name", async () => {
    await app.do("increment", { stream: "load-by-name", actor }, {});
    const snap = await app.load("Counter", "load-by-name");
    expect(snap.state.count).toBe(1);
  });

  it("should throw when loading unknown state name", async () => {
    await expect(app.load("NonExistent" as any, "x")).rejects.toThrow(
      'State "NonExistent" not found'
    );
  });

  it("stays armed after a claim that yields no work, and disarms on the next empty claim", async () => {
    // Start from a quiet pipeline: finish what earlier tests' commits left.
    await app.drain();
    // The claim returns a stream, but every handler produces nothing
    const mockClaim = vi.spyOn(store(), "claim").mockResolvedValueOnce([
      {
        stream: "mock-stream",
        source: undefined,
        at: 0,
        by: "test",
        retry: 0,
        lagging: true,
      },
    ]);
    const mockQuery = vi.spyOn(store(), "query").mockResolvedValue(0);
    const mockAck = vi.spyOn(store(), "ack").mockResolvedValueOnce([]);
    // Arm it manually
    (app as any)._arm_all();
    const d = await app.drain();
    mockClaim.mockRestore();
    mockQuery.mockRestore();
    mockAck.mockRestore();
    expect(d.acked.length).toBe(0);
    expect(d.blocked.length).toBe(0);
    // A pass that leased something isn't idle, however little it did.
    const controller = (app as any)._drain_controllers.get("default");
    expect(controller.armed).toBe(true);
    await app.drain();
    expect(controller.armed).toBe(false);
  });
});
