import { z } from "zod";
import { act, dispose, sleep, state, store, ZodEmpty } from "../src/index.js";

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
    .on("ignored")
    .do(() => Promise.resolve())
    .void() // void resolver — correlate should skip this
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
    let drained = await app.drain({ leaseMillis: 1 });
    expect(drained.acked.length).toBe(1);
    expect(drained.acked[0].at).toBe(1);
    expect(onIncremented).toHaveBeenCalledTimes(2);
    expect(onDecremented).toHaveBeenCalledTimes(1);

    // first fully failed
    drained = await app.drain({ leaseMillis: 1 });
    console.log("first try", drained);
    expect(drained.acked.length).toBe(0);
    expect(onDecremented).toHaveBeenCalledTimes(2);

    // second fully failed (first retry)
    drained = await app.drain({ leaseMillis: 1 });
    console.log("second try", drained);
    expect(drained.acked.length).toBe(0);
    expect(drained.blocked.length).toBe(0);
    expect(onDecremented).toHaveBeenCalledTimes(3);

    // third fully failed (second retry) - should block
    drained = await app.drain({ leaseMillis: 1 });
    console.log("third try", drained);
    expect(drained.acked.length).toBe(0);
    expect(drained.blocked.length).toBe(1);
    expect(onDecremented).toHaveBeenCalledTimes(4);
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
    let d;
    do {
      d = await app.drain();
    } while (d.acked.length || d.blocked.length);

    // Now _needs_drain is false. Non-reactive event should NOT set it.
    await app.do("ignore2", { stream: "s2", actor }, {});
    const skipped = await app.drain();
    expect(skipped.fetched.length).toBe(0);
    expect(skipped.leased.length).toBe(0);

    // Reactive event should set _needs_drain and drain normally
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
    // mock store claim to throw
    const mockedClaim = vi.spyOn(store(), "claim").mockImplementation(() => {
      throw new Error("test");
    });
    const drained = await app.drain();
    expect(drained.leased.length).toBe(0);
    mockedClaim.mockRestore();
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
      .do(() => Promise.resolve())
      .to((event) => ({ target: `dyn-${event.stream}` }))
      .build();

    await dynApp.do("doDyn", { stream: "x", actor }, {});
    // First correlate discovers "dyn-x"
    const r1 = await dynApp.correlate({ limit: 100 });
    expect(r1.subscribed).toBe(1);
    // Second correlate — same events, target already subscribed
    // Reset checkpoint to force re-scan
    (dynApp as any)._correlation_checkpoint = -1;
    (dynApp as any)._subscribed_statics.delete("dyn-x");
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
      .do(() => Promise.resolve())
      .to((event) => ({ target: `dyn2-${event.stream}` }))
      .build();

    await dynApp.do("doDyn2", { stream: "y", actor }, {});

    // Mock subscribe to fail
    const subscribeSpy = vi
      .spyOn(store(), "subscribe")
      .mockRejectedValueOnce(new Error("subscribe failed"));

    // First correlate should throw — checkpoint must NOT advance
    const checkpoint = (dynApp as any)._correlation_checkpoint;
    await expect(dynApp.correlate({ limit: 100 })).rejects.toThrow(
      "subscribe failed"
    );
    expect((dynApp as any)._correlation_checkpoint).toBe(checkpoint);

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

    it("should be a no-op when already settling", async () => {
      const settledListener = vi.fn();
      app.on("settled", settledListener);

      // Slow down correlate so the first settle is still running when the second fires
      const originalCorrelate = app.correlate.bind(app);
      const spy = vi.spyOn(app, "correlate").mockImplementation(async (q) => {
        await sleep(200);
        return originalCorrelate(q);
      });

      await app.do("increment", { stream: "settle-guard", actor }, {});
      // First call starts the cycle
      app.settle({ debounceMs: 1 });
      await sleep(50); // Let the timer fire and settle begin
      // Second call while settling — timer fires but guard returns
      app.settle({ debounceMs: 1 });
      await sleep(800);

      // Only 1 settled emission — second was guarded
      expect(settledListener).toHaveBeenCalledTimes(1);

      spy.mockRestore();
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
      app.settle({ debounceMs: 500 });
      app.stop_settling(); // cancels before it fires
      await sleep(600);
      // no error, no settle cycle ran
    });

    it("should not emit settled when maxPasses is 0", async () => {
      const settledListener = vi.fn();
      app.on("settled", settledListener);

      app.settle({ debounceMs: 1, maxPasses: 0 });
      await sleep(100);
      expect(settledListener).not.toHaveBeenCalled();

      app.off("settled", settledListener);
    });

    it("should break early when correlate returns no subscriptions on second pass", async () => {
      const settledListener = vi.fn();
      app.on("settled", settledListener);

      // Mock correlate: first call returns subscriptions so loop continues,
      // second call returns 0 → triggers i>0 break
      let correlateCount = 0;
      const correlateSpy = vi.spyOn(app, "correlate").mockImplementation(() => {
        correlateCount++;
        if (correlateCount === 1)
          return Promise.resolve({ subscribed: 1, last_id: 0 } as any);
        return Promise.resolve({ subscribed: 0, last_id: 0 } as any);
      });
      // Mock drain to return acked work so the loop doesn't break at line 882
      const drainSpy = vi.spyOn(app, "drain").mockResolvedValue({
        fetched: [],
        leased: [],
        acked: [{ stream: "x", at: 1, by: "test", retry: 0, lagging: false }],
        blocked: [],
      });

      app.settle({ debounceMs: 1, maxPasses: 5 });
      await sleep(300);
      expect(settledListener).toHaveBeenCalledTimes(1);
      expect(correlateCount).toBe(2); // ran 2 passes, broke on second

      correlateSpy.mockRestore();
      drainSpy.mockRestore();
      app.off("settled", settledListener);
    });

    it("should handle errors in settle gracefully", async () => {
      const spy = vi
        .spyOn(app, "correlate")
        .mockRejectedValue(new Error("settle-error"));

      app.settle({ debounceMs: 1 });
      await sleep(300);
      // settle caught the error internally — no unhandled rejection
      spy.mockRestore();
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

  it("should handle static resolver targets at build time", async () => {
    const s = state({ Static: z.object({ v: z.number() }) })
      .init(() => ({ v: 0 }))
      .emits({ StaticEvt: ZodEmpty })
      .patch({ StaticEvt: () => ({}) })
      .on({ doStatic: ZodEmpty })
      .emit(() => ["StaticEvt", {}])
      .build();

    const staticApp = act()
      .withState(s)
      .on("StaticEvt")
      .do(() => Promise.resolve())
      .to("my-static-target") // static resolver — covers constructor branch
      .build();

    // _static_targets and _subscribed_statics populated at build time
    expect((staticApp as any)._static_targets.length).toBe(1);
    expect((staticApp as any)._static_targets[0].stream).toBe(
      "my-static-target"
    );

    // Correlate initializes subscriptions for static targets (covers _subscribed_statics.add)
    await staticApp.correlate();
    expect((staticApp as any)._subscribed_statics.has("my-static-target")).toBe(
      true
    );
  });

  it("should clear _needs_drain when drain processes events with no results", async () => {
    await app.do("increment", { stream: "clear-flag", actor }, {});
    await app.correlate();
    let d;
    do {
      d = await app.drain();
    } while (d.acked.length || d.blocked.length);
    expect((app as any)._needs_drain).toBe(false);
  });

  it("should clear _needs_drain via handler path when drain finds no matching reactions", async () => {
    // Mock: drain enters locked section, claims streams, but all handlers produce empty payloads
    // This covers line 672 (_needs_drain = false after 0 acked/blocked/errors)
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
    // Set _needs_drain manually
    (app as any)._needs_drain = true;
    const d = await app.drain();
    expect(d.acked.length).toBe(0);
    expect(d.blocked.length).toBe(0);
    expect((app as any)._needs_drain).toBe(false);
    mockClaim.mockRestore();
    mockQuery.mockRestore();
    mockAck.mockRestore();
  });

  it("should cleanup on dispose", async () => {
    const s = state({ Disp: z.object({ n: z.number() }) })
      .init(() => ({ n: 0 }))
      .emits({ DispEvt: ZodEmpty })
      .patch({ DispEvt: () => ({}) })
      .on({ doDisp: ZodEmpty })
      .emit(() => ["DispEvt", {}])
      .build();

    const dispApp = act().withState(s).build();
    // Start correlations to have a timer to clean up
    dispApp.start_correlations({}, 100);
    // dispose should not throw
    await dispose()();
    // Re-seed for other tests
    await store().seed();
  });

  it("should handle app with zero reactions (no _needs_drain on init)", async () => {
    // App with no reactions — _reactive_events is empty
    const s = state({ NoRx: z.object({ n: z.number() }) })
      .init(() => ({ n: 0 }))
      .emits({ NoRxEvt: ZodEmpty })
      .patch({ NoRxEvt: () => ({}) })
      .on({ doNoRx: ZodEmpty })
      .emit(() => ["NoRxEvt", {}])
      .build();

    const noRxApp = act().withState(s).build();
    expect((noRxApp as any)._reactive_events.size).toBe(0);
    // correlate inits but does NOT set _needs_drain (no reactive events)
    await noRxApp.correlate();
    expect((noRxApp as any)._needs_drain).toBe(false);
    // drain skips immediately
    const d = await noRxApp.drain();
    expect(d.fetched.length).toBe(0);
  });

  it("should handle leased stream with no payloads in map", async () => {
    // Claim returns two streams, but fetched only has events for one.
    // The second stream won't have an entry in payloadsMap → `|| []` fallback.
    const mockClaim = vi.spyOn(store(), "claim").mockResolvedValueOnce([
      {
        stream: "has-events",
        source: undefined,
        at: 0,
        by: "test",
        retry: 0,
        lagging: true,
      },
      {
        stream: "no-events",
        source: undefined,
        at: 0,
        by: "test",
        retry: 0,
        lagging: false,
      },
    ]);
    // query_array returns events only for the first stream's source
    const origQueryArray = app.query_array.bind(app);
    const mockQueryArray = vi
      .spyOn(app, "query_array")
      .mockImplementation(async (q) => {
        if (q.stream === undefined) return origQueryArray(q);
        return []; // no events for any stream
      });
    const mockAck = vi.spyOn(store(), "ack").mockResolvedValueOnce([]);
    (app as any)._needs_drain = true;
    const d = await app.drain();
    expect(d.leased.length).toBe(2);
    mockClaim.mockRestore();
    mockQueryArray.mockRestore();
    mockAck.mockRestore();
  });
});
