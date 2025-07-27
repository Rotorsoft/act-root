import { z } from "zod";
import { act, sleep, state, store, ZodEmpty } from "../src/index.js";

describe("act", () => {
  const counter = state("Counter", z.object({ count: z.number() }))
    .init(() => ({ count: 0 }))
    .emits({ incremented: ZodEmpty, decremented: ZodEmpty, ignored: ZodEmpty })
    .patch({
      incremented: (_, state) => ({ count: state.count + 1 }),
      decremented: (_, state) => ({ count: state.count - 1 }),
      ignored: () => ({}),
    })
    .on("increment", ZodEmpty)
    .emit(() => ["incremented", {}])
    .on("decrement", ZodEmpty)
    .emit(() => ["decremented", {}])
    .on("ignored", ZodEmpty)
    .emit(() => ["ignored", {}])
    .build();

  const onIncremented = vi.fn().mockImplementation(async () => {
    await sleep(100);
  });
  const onDecremented = vi.fn().mockImplementation(async () => {
    await sleep(100);
    throw new Error("onDecremented failed");
  });

  const app = act()
    .with(counter)
    .on("incremented")

    .do(onIncremented)
    .on("decremented")

    .do(onDecremented, { maxRetries: 2, blockOnError: true })
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

    const { leased } = await app.correlate();
    expect(leased.length).toBe(1);

    // TODO: two correlate in a row should not return any leases
    // const result = await app.correlate();
    // expect(result.leased.length).toBe(0);
    // expect(result.last_id).toBe(2);

    // should drain the first two events...  third event should throw and stop drain
    let drained = await app.drain({ leaseMillis: 1 }); // 1ms leases to test blocking
    expect(drained.acked.length).toBe(1);
    expect(drained.acked[0].at).toBe(1);
    expect(onIncremented).toHaveBeenCalledTimes(2);
    expect(onDecremented).toHaveBeenCalledTimes(1);

    // first fully failed
    drained = await app.drain({ leaseMillis: 1 }); // 1ms leases to test blocking
    console.log(drained);
    expect(drained.acked.length).toBe(0);
    expect(onDecremented).toHaveBeenCalledTimes(2);

    // second fully failed (first retry)
    drained = await app.drain({ leaseMillis: 1 }); // 1ms leases to test blocking
    console.log(drained);
    expect(drained.acked.length).toBe(0);
    expect(drained.blocked.length).toBe(0);
    expect(onDecremented).toHaveBeenCalledTimes(3);

    // third fully failed (second retry) - should block
    drained = await app.drain({ leaseMillis: 1 }); // 1ms leases to test blocking
    expect(drained.acked.length).toBe(0);
    expect(drained.blocked.length).toBe(1);
    expect(onDecremented).toHaveBeenCalledTimes(4);
  });

  it("should not do anything when ignored events are emitted", async () => {
    await app.do("ignored", { stream: "s", actor }, {});
    const drained = await app.drain();
    expect(drained.acked.length).toBe(0);
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
});
