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
 * A stream is quarantined when its retry count runs past the budget with no
 * handler ever raising an error, because that is what a handler losing its
 * lease every round looks like. A store failing mid-pass looks identical from
 * there: `claim` writes the count up before any handler runs, and a pass that
 * dies on a store call never writes it back. So the quarantine stands down
 * while the store is failing, and re-arms once a pass completes.
 */

const counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ ticked: ZodEmpty })
  .patch({ ticked: () => ({}) })
  .on({ tick: ZodEmpty })
  .emit(() => ["ticked", {}])
  .build();

const actor = { id: "a", name: "a" };

describe("a failing store does not quarantine a healthy stream (#1592)", () => {
  afterEach(async () => {
    await dispose()();
  });

  it("keeps the stream running while acks keep failing, and recovers", async () => {
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
      // Threshold raised so the breaker stays closed through five failures:
      // this test is about the retry budget, not about the breaker tripping.
      .build({ circuitBreaker: { failureThreshold: 10 } });
    app.on("error", () => {});

    await app.do("tick", { stream: "busy-db", actor }, {});
    await app.correlate();

    const real_ack = s.ack.bind(s);
    let failing = true;
    s.ack = ((leases: never) =>
      failing
        ? Promise.reject(new StoreError("ack", { cause: new Error("busy") }))
        : real_ack(leases)) as never;

    // Five passes, every one of them finished by a store that refuses the
    // ack — two more than the handler's budget of three.
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

  it("still quarantines a stream that loses its lease every round", async () => {
    const s = new InMemoryStore();
    store(s);
    const handler = vi.fn(async () => {});
    Object.defineProperty(handler, "name", { value: "losesItsLease" });

    const app = act()
      .withState(counter)
      .on("ticked")
      .do(handler, { maxRetries: 3 })
      .build();
    app.on("error", () => {});

    const tick = async () => {
      await app.do("tick", { stream: "lost-lease", actor }, {});
      await app.correlate();
    };
    await tick();

    // First the store fails outright, then it recovers but drops every ack,
    // which is what a lease taken by another worker looks like: no error
    // anywhere, and the count climbing all the same. Only the second phase
    // should ever reach the quarantine.
    let failing = true;
    s.ack = ((_leases: never) =>
      failing
        ? Promise.reject(new StoreError("ack", { cause: new Error("busy") }))
        : Promise.resolve([])) as never;

    for (let i = 0; i < 2; i++) {
      await app.drain({ leaseMillis: 1 });
      await sleep(5);
    }
    expect(await app.blocked_streams()).toHaveLength(0);

    failing = false;
    const results = [];
    for (let i = 0; i < 3; i++) {
      results.push(await app.drain({ leaseMillis: 1 }));
      await sleep(5);
      await tick();
    }
    const blocked = results.flatMap((r) => r.blocked);
    expect(blocked).toHaveLength(1);
    expect(blocked[0].error).toContain("every attempt lost its lease");
  });
});
