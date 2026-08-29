import { z } from "zod";
import { InMemoryStore } from "../src/adapters/in-memory-store.js";
import {
  act,
  dispose,
  StoreError,
  sleep,
  state,
  store,
  ZodEmpty,
} from "../src/index.js";

/**
 * #1592: `claim` persists `retry = retry + 1` before any handler runs, and a
 * cycle that dies on a store op never rolls it back. Left alone, a store that
 * fails transiently walks the counter past `maxRetries` and blocks the stream
 * — with a message that prescribes a bigger lease for a handler that never
 * failed. The drain keeps its own ledger of claims spent that way and
 * discounts them out of the budget the block decisions read.
 */

const counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ ticked: ZodEmpty })
  .patch({ ticked: () => ({}) })
  .on({ tick: ZodEmpty })
  .emit(() => ["ticked", {}])
  .build();

const actor = { id: "a", name: "a" };

describe("store failures and the retry budget (#1592)", () => {
  afterEach(async () => {
    await dispose()();
  });

  it("refunds claims a failing ack spent, so the stream never blocks", async () => {
    const s = new InMemoryStore();
    store(s);
    let handled = 0;
    const handler = vi.fn(async () => {
      handled++;
    });
    Object.defineProperty(handler, "name", { value: "alwaysSucceeds" });

    const app = act()
      .withState(counter)
      .on("ticked")
      .do(handler, { maxRetries: 3 })
      .build({ circuitBreaker: { failureThreshold: 50 } });
    app.on("error", () => {});

    await app.do("tick", { stream: "refund-ack", actor }, {});
    await app.correlate();

    const real_ack = s.ack.bind(s);
    let failing = true;
    s.ack = ((leases: never) =>
      failing
        ? Promise.reject(new StoreError("ack", { cause: new Error("busy") }))
        : real_ack(leases)) as never;

    // Five cycles, every one of them finalized by a store that refuses the
    // ack — two more than the retry budget the handler was given.
    for (let i = 0; i < 5; i++) {
      await app.drain({ leaseMillis: 1 });
      await sleep(5);
    }
    expect(handled).toBe(5);
    expect(await app.blocked_streams()).toHaveLength(0);

    failing = false;
    const drained = await app.drain({ leaseMillis: 1 });
    expect(drained.acked).toHaveLength(1);
    expect(drained.blocked).toHaveLength(0);
    expect(await app.blocked_streams()).toHaveLength(0);
  });

  it("keeps the refund when a handler then fails without progress", async () => {
    const s = new InMemoryStore();
    store(s);
    const handler = vi.fn(async () => {
      throw new Error("handler is genuinely broken");
    });
    Object.defineProperty(handler, "name", { value: "alwaysThrows" });

    const app = act()
      .withState(counter)
      .on("ticked")
      .do(handler, { maxRetries: 2 })
      .build({ circuitBreaker: { failureThreshold: 50 } });
    app.on("error", () => {});

    await app.do("tick", { stream: "refund-fetch", actor }, {});
    await app.correlate();

    // The fetch leg fails, so the claim is spent before the handler is ever
    // reached — the least ambiguous form of the bug.
    const real_query = s.query.bind(s);
    let failing = true;
    s.query = ((...args: never[]) =>
      failing
        ? Promise.reject(new StoreError("query", { cause: new Error("busy") }))
        : real_query(...args)) as never;

    for (let i = 0; i < 2; i++) {
      await app.drain({ leaseMillis: 1 });
      await sleep(5);
    }
    expect(handler).not.toHaveBeenCalled();

    failing = false;
    // Now the handler runs, and fails, exactly `maxRetries` times before the
    // budget is spent — the two claims the store ate stay refunded across
    // cycles that write nothing back.
    const first = await app.drain({ leaseMillis: 1 });
    await sleep(5);
    const second = await app.drain({ leaseMillis: 1 });
    await sleep(5);
    const third = await app.drain({ leaseMillis: 1 });

    expect(handler).toHaveBeenCalledTimes(3);
    expect(first.blocked).toHaveLength(0);
    expect(second.blocked).toHaveLength(0);
    expect(third.blocked).toHaveLength(1);
    expect(third.blocked[0].error).toContain("handler is genuinely broken");
  });
});
