import { z } from "zod";
import { act, dispose, state, store } from "../src/index.js";

/**
 * Tests for auto-injection of reactingTo in reaction handlers (#587).
 *
 * When a reaction handler calls app.do() without the reactingTo parameter,
 * the framework auto-injects the triggering event, maintaining the
 * correlation chain by default.
 */
describe("auto-inject reactingTo (#587)", () => {
  const actor = { id: "a", name: "a" };

  beforeEach(async () => {
    await store().seed();
  });

  afterAll(async () => {
    await dispose()();
  });

  it("should auto-inject reactingTo when handler omits it", async () => {
    const Source = state({ Source: z.object({ v: z.number() }) })
      .init(() => ({ v: 0 }))
      .emits({ Triggered: z.object({ val: z.number() }) })
      .on({ trigger: z.object({ val: z.number() }) })
      .emit("Triggered")
      .build();

    const Sink = state({ Sink: z.object({ v: z.number() }) })
      .init(() => ({ v: 0 }))
      .emits({ Received: z.object({ val: z.number() }) })
      .patch({ Received: ({ data }) => ({ v: data.val }) })
      .on({ receive: z.object({ val: z.number() }) })
      .emit("Received")
      .build();

    const app_ = act()
      .withState(Source)
      .withState(Sink)
      .on("Triggered")
      .do(async function onTriggered(event, _stream, app) {
        // NOT passing reactingTo — framework should auto-inject it
        await app.do(
          "receive",
          { stream: "sink-1", actor: { id: "sys", name: "system" } },
          { val: event.data.val }
        );
      })
      .to((event) => ({ target: `sink-${event.stream}` }))
      .build();

    await app_.do("trigger", { stream: "src-1", actor }, { val: 42 });
    await app_.correlate();
    await app_.drain();

    // Verify the Received event on the sink stream has correct correlation
    const srcEvents = await app_.query_array({
      stream: "src-1",
      stream_exact: true,
    });
    const sinkEvents = await app_.query_array({
      stream: "sink-1",
      stream_exact: true,
    });

    const triggeredEvent = srcEvents.find((e) => e.name === "Triggered")!;
    const receivedEvent = sinkEvents.find((e) => e.name === "Received")!;

    expect(receivedEvent).toBeDefined();
    // Correlation chain should be maintained
    expect(receivedEvent.meta.correlation).toBe(
      triggeredEvent.meta.correlation
    );
    // Causation should point back to the triggering event
    expect(receivedEvent.meta.causation.event).toEqual({
      id: triggeredEvent.id,
      name: "Triggered",
      stream: "src-1",
    });
  });

  it("should respect explicit reactingTo when provided", async () => {
    const Source = state({ Source2: z.object({ v: z.number() }) })
      .init(() => ({ v: 0 }))
      .emits({ Triggered2: z.object({ val: z.number() }) })
      .on({ trigger2: z.object({ val: z.number() }) })
      .emit("Triggered2")
      .build();

    const Sink = state({ Sink2: z.object({ v: z.number() }) })
      .init(() => ({ v: 0 }))
      .emits({ Received2: z.object({ val: z.number() }) })
      .patch({ Received2: ({ data }) => ({ v: data.val }) })
      .on({ receive2: z.object({ val: z.number() }) })
      .emit("Received2")
      .build();

    const customCorrelation = "custom-correlation-id";

    const app_ = act()
      .withState(Source)
      .withState(Sink)
      .on("Triggered2")
      .do(async function onTriggered2(event, _stream, app) {
        // Explicitly passing a custom reactingTo — should NOT be overridden
        const fakeEvent = {
          ...event,
          meta: { correlation: customCorrelation, causation: {} },
        };
        await app.do(
          "receive2",
          { stream: "sink2-1", actor: { id: "sys", name: "system" } },
          { val: event.data.val },
          fakeEvent
        );
      })
      .to((event) => ({ target: `sink2-${event.stream}` }))
      .build();

    await app_.do("trigger2", { stream: "src2-1", actor }, { val: 99 });
    await app_.correlate();
    const drained = await app_.drain();
    expect(drained.acked.length).toBeGreaterThan(0);

    const sinkEvents = await app_.query_array({
      stream: "sink2-1",
      stream_exact: true,
    });
    const receivedEvent = sinkEvents.find((e) => e.name === "Received2")!;

    expect(receivedEvent).toBeDefined();
    // Should use the explicitly provided correlation, not the auto-injected one
    expect(receivedEvent.meta.correlation).toBe(customCorrelation);
  });

  it("should propagate correlation across multi-step reaction chains", async () => {
    const Step1 = state({ Step1: z.object({ v: z.number() }) })
      .init(() => ({ v: 0 }))
      .emits({ Started: z.object({ val: z.number() }) })
      .on({ start: z.object({ val: z.number() }) })
      .emit("Started")
      .build();

    const Step2 = state({ Step2: z.object({ v: z.number() }) })
      .init(() => ({ v: 0 }))
      .emits({ Forwarded: z.object({ val: z.number() }) })
      .patch({ Forwarded: ({ data }) => ({ v: data.val }) })
      .on({ forward: z.object({ val: z.number() }) })
      .emit("Forwarded")
      .build();

    const Step3 = state({ Step3: z.object({ v: z.number() }) })
      .init(() => ({ v: 0 }))
      .emits({ Completed: z.object({ val: z.number() }) })
      .patch({ Completed: ({ data }) => ({ v: data.val }) })
      .on({ complete: z.object({ val: z.number() }) })
      .emit("Completed")
      .build();

    const app_ = act()
      .withState(Step1)
      .withState(Step2)
      .withState(Step3)
      // Step 1 → Step 2 (no explicit reactingTo)
      .on("Started")
      .do(async function onStarted(event, _stream, app) {
        await app.do(
          "forward",
          { stream: "step2-1", actor: { id: "sys", name: "system" } },
          { val: event.data.val }
        );
      })
      .to(() => ({ target: "step2-1" }))
      // Step 2 → Step 3 (no explicit reactingTo)
      .on("Forwarded")
      .do(async function onForwarded(event, _stream, app) {
        await app.do(
          "complete",
          { stream: "step3-1", actor: { id: "sys", name: "system" } },
          { val: event.data.val }
        );
      })
      .to(() => ({ target: "step3-1" }))
      .build();

    await app_.do("start", { stream: "step1-1", actor }, { val: 7 });

    // Multiple correlate→drain passes to propagate through the chain
    for (let i = 0; i < 3; i++) {
      await app_.correlate();
      await app_.drain();
    }

    const step1Events = await app_.query_array({
      stream: "step1-1",
      stream_exact: true,
    });
    const step3Events = await app_.query_array({
      stream: "step3-1",
      stream_exact: true,
    });

    const startedEvent = step1Events.find((e) => e.name === "Started")!;
    const completedEvent = step3Events.find((e) => e.name === "Completed")!;

    expect(completedEvent).toBeDefined();
    // The entire chain should share the same correlation ID
    expect(completedEvent.meta.correlation).toBe(startedEvent.meta.correlation);
  });

  it("should not affect load, query, and query_array on scoped app", async () => {
    const Counter = state({ ScopedCounter: z.object({ count: z.number() }) })
      .init(() => ({ count: 0 }))
      .emits({ Counted: z.object({ n: z.number() }) })
      .patch({ Counted: ({ data }, s) => ({ count: s.count + data.n }) })
      .on({ count: z.object({ n: z.number() }) })
      .emit("Counted")
      .build();

    let loadResult: any;
    let queryResult: any;
    let queryArrayResult: any;

    const app_ = act()
      .withState(Counter)
      .on("Counted")
      .do(async function onCounted(_event, _stream, app) {
        // Verify all IAct methods work on the scoped proxy
        loadResult = await app.load(Counter, "ctr-1");
        queryResult = await app.query({ stream: "ctr-1", stream_exact: true });
        queryArrayResult = await app.query_array({
          stream: "ctr-1",
          stream_exact: true,
        });
      })
      .to(() => ({ target: "reaction-ctr" }))
      .build();

    await app_.do("count", { stream: "ctr-1", actor }, { n: 5 });
    await app_.correlate();
    await app_.drain();

    expect(loadResult).toBeDefined();
    expect(loadResult.state.count).toBe(5);
    expect(queryResult.count).toBeGreaterThan(0);
    expect(queryArrayResult.length).toBeGreaterThan(0);
  });
});
