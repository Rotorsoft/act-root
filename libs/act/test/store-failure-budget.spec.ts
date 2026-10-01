import { z } from "zod";
import { InMemoryCache } from "../src/adapters/in-memory-cache.js";
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
import type { Query, Store } from "../src/types/index.js";

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

/**
 * Per-stream reads already ran per stream, but under one `Promise.all` — so
 * one stream's read failure rejected the whole cycle and every healthy stream
 * leased beside it got nothing. An unreadable `pii` payload on one aggregate
 * stalled unrelated reactions (#1675).
 *
 * Correlate declines the payload it discards, so it reads past such a row.
 * The drain's fetch cannot: handlers receive the payload through their own
 * gate, so a fetch that dropped it would hand them a silently incomplete
 * event. Containing the failure per stream is what keeps the blast radius on
 * the stream that caused it.
 */
describe("a stream whose fetch fails does not stall the streams beside it (#1675)", () => {
  const armed = { on: false };

  /**
   * Fails the payload-bearing read for ONE stream, the way an undecryptable
   * `pii` payload does. A read that declines the payload — correlate's — is
   * unaffected, which is the adapter contract this rides on.
   */
  const poison_stream = (inner: Store, bad: string): Store =>
    new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop !== "query") {
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async (cb: (e: never) => void, q?: Query): Promise<number> => {
          if (armed.on && q?.stream === bad && q?.with_pii !== false)
            throw new Error("ciphertext framing version 22 is not supported");
          return target.query(cb as never, q as never);
        };
      },
    }) as Store;

  it("contains a non-Error throw too", async () => {
    // A store is free to reject with anything. Containment must not depend on
    // getting an `Error` back.
    const base = new InMemoryStore();
    await base.seed();
    const seen: string[] = [];
    const thrower = new Proxy(base, {
      get(target, prop, receiver) {
        if (prop !== "query") {
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async (cb: (e: never) => void, q?: Query): Promise<number> => {
          if (armed.on && q?.stream === "victim" && q?.with_pii !== false)
            throw `ciphertext framing version ${22}`;
          return target.query(cb as never, q as never);
        };
      },
    }) as Store;

    const app = act()
      .withState(counter)
      .on("ticked")
      .do(async function sink(e) {
        seen.push(e.stream);
      })
      .build({ scoped: { store: thrower, cache: new InMemoryCache() } });

    await app.do("tick", { stream: "victim", actor }, {});
    await app.do("tick", { stream: "healthy", actor }, {});

    armed.on = true;
    await app.correlate();
    await app.drain({ leaseMillis: 50 });
    armed.on = false;

    expect(seen).toEqual(["healthy"]);
  });

  it("delivers to the healthy stream, and never skips the poison one", async () => {
    const base = new InMemoryStore();
    await base.seed();
    const seen: string[] = [];
    const app = act()
      .withState(counter)
      .on("ticked")
      .do(async function sink(e) {
        seen.push(e.stream);
      })
      .build({
        scoped: {
          store: poison_stream(base, "victim"),
          cache: new InMemoryCache(),
        },
      });

    await app.do("tick", { stream: "victim", actor }, {});
    await app.do("tick", { stream: "healthy", actor }, {});

    // Only the reads fail — the commits above are already durable.
    armed.on = true;
    await app.correlate();
    await app.drain({ leaseMillis: 50 });

    // The healthy stream was leased in the same cycle and still ran.
    expect(seen).toEqual(["healthy"]);

    // The poison stream submitted no ack, so its watermark held and the event
    // is still pending — not silently skipped. Once the read recovers and the
    // lease lapses, it is delivered.
    armed.on = false;
    await sleep(80);
    await app.drain({ leaseMillis: 50 });
    expect(seen).toContain("victim");
  });
});
