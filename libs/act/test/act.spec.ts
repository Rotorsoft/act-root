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
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    .do(onIncremented)
    .on("decremented")
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    .do(onDecremented, { maxRetries: 2, blockOnError: true })
    .build();

  const actor = { id: "a", name: "a" };

  it("should register and call an event listener", async () => {
    const listener = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    app.on("committed", listener);
    await app.do("increment", { stream: "s", actor }, {});
    expect(listener).toHaveBeenCalled();
  });

  it("should not call removed event listener", async () => {
    const listener = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    app.on("committed", listener);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    app.off("committed", listener);
    await app.do("increment", { stream: "s", actor }, {});
    expect(listener).not.toHaveBeenCalled();
  });

  it("should handle increment and decrement should block", async () => {
    const drained = await app.drain();
    console.log(drained);
    expect(drained.acked.length).toBe(1);
    expect(onIncremented).toHaveBeenCalled();
    expect(onDecremented).not.toHaveBeenCalled();

    await app.do("decrement", { stream: "s", actor }, {});
    const drained2 = await app.drain({ leaseMillis: 1 }); // 1ms leases to test blocking
    console.log(drained2);
    expect(drained2.acked.length).toBe(0);
    expect(onDecremented).toHaveBeenCalledTimes(1);

    const drained3 = await app.drain({ leaseMillis: 1 }); // 1ms leases to test blocking
    console.log(drained3);
    expect(drained3.acked.length).toBe(0);
    expect(onDecremented).toHaveBeenCalledTimes(2);

    const drained4 = await app.drain({ leaseMillis: 1 }); // 1ms leases to test blocking
    console.log(drained4);
    expect(drained4.acked.length).toBe(0);
    expect(drained4.blocked.length).toBe(1);
    expect(onDecremented).toHaveBeenCalledTimes(3);
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
