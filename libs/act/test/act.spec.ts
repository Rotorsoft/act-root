import { z } from "zod";
import { act, sleep, state, ZodEmpty } from "../src/index.js";

describe("act", () => {
  const counter = state("Counter", z.object({ count: z.number() }))
    .init(() => ({ count: 0 }))
    .emits({ incremented: ZodEmpty, decremented: ZodEmpty })
    .patch({
      incremented: (_, state) => ({ count: state.count + 1 }),
      decremented: (_, state) => ({ count: state.count - 1 }),
    })
    .on("increment", ZodEmpty)
    .emit(() => ["incremented", {}])
    .on("decrement", ZodEmpty)
    .emit(() => ["decremented", {}])
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

    // should drain the first two events...  third event should throw and stop drain
    let drained = await app.drain();
    expect(drained.acked.length).toBe(1);
    expect(drained.acked[0].at).toBe(1);
    expect(onIncremented).toHaveBeenCalledTimes(2);
    expect(onDecremented).toHaveBeenCalledTimes(1);

    // first fully failed
    drained = await app.drain({ leaseMillis: 1 }); // 1ms leases to test blocking
    expect(drained.acked.length).toBe(0);
    expect(onDecremented).toHaveBeenCalledTimes(2);

    // second fully failed (first retry)
    drained = await app.drain({ leaseMillis: 1 }); // 1ms leases to test blocking
    expect(drained.acked.length).toBe(0);
    expect(drained.blocked.length).toBe(0);
    expect(onDecremented).toHaveBeenCalledTimes(3);

    // third fully failed (second retry) - should block
    drained = await app.drain({ leaseMillis: 1 }); // 1ms leases to test blocking
    expect(drained.acked.length).toBe(0);
    expect(drained.blocked.length).toBe(1);
    expect(onDecremented).toHaveBeenCalledTimes(4);
  });

  it("should exit drain loop on error", async () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const fetch = app.fetch;
    app.fetch = () => {
      throw new Error("fetch error");
    };
    const drained = await app.drain();
    expect(drained.leased.length).toBe(0);
    app.fetch = fetch;
  });
});
