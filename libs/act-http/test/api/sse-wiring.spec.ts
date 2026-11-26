import { act, type State, sensitive, state } from "@rotorsoft/act";
import { describe, expect, it } from "vitest";
import { ZodError, z } from "zod";
import {
  fire_and_forget,
  SseConnectionCounter,
} from "../../src/api/sse-counter.js";
import { SseOptionsSchema } from "../../src/api/sse-options.js";
import { sse_states } from "../../src/api/sse-states.js";
import {
  DEFAULT_SSE_HEARTBEAT_MS,
  DEFAULT_SSE_MAX_CONNECTIONS,
  DEFAULT_SSE_MAX_PENDING_PER_CONNECTION,
  runSseSubscription,
  type SseSubscriptionFrame,
} from "../../src/api/sse-wiring.js";
import { BroadcastChannel } from "../../src/sse/index.js";

describe("SseOptionsSchema", () => {
  const channel = new BroadcastChannel();

  it("applies the defaults and keeps a caller's knobs", () => {
    expect(SseOptionsSchema.parse({ channel })).toMatchObject({
      maxConnections: DEFAULT_SSE_MAX_CONNECTIONS,
      heartbeatMs: DEFAULT_SSE_HEARTBEAT_MS,
      maxPendingPerConnection: DEFAULT_SSE_MAX_PENDING_PER_CONNECTION,
    });
    const knobs = {
      maxConnections: 100,
      heartbeatMs: 60_000,
      maxPendingPerConnection: 32,
    };
    expect(SseOptionsSchema.parse({ channel, ...knobs })).toMatchObject(knobs);
  });

  // A `NaN` bound makes every comparison false: the cap or the backlog
  // would be unbounded, or a fraction would admit one more than asked.
  it.each([
    [
      "maxConnections",
      [0, 10_001, Number.NaN, Number.POSITIVE_INFINITY, 500.5],
    ],
    ["heartbeatMs", [14_999, 300_001, Number.NaN, 30_000.5]],
    ["maxPendingPerConnection", [0, 100_001, Number.NaN, 1.5]],
  ])("refuses an out-of-range %s with ZodError", (knob, values) => {
    for (const value of values)
      expect(() => SseOptionsSchema.parse({ channel, [knob]: value })).toThrow(
        ZodError
      );
  });
});

describe("SseConnectionCounter", () => {
  it("acquires up to the limit, then refuses", () => {
    const counter = new SseConnectionCounter(2);
    expect(counter.acquire()).toBe(true);
    expect(counter.acquire()).toBe(true);
    expect(counter.acquire()).toBe(false);
    expect(counter.open).toBe(2);
  });

  it("release frees a slot", () => {
    const counter = new SseConnectionCounter(1);
    expect(counter.acquire()).toBe(true);
    expect(counter.acquire()).toBe(false);
    counter.release();
    expect(counter.open).toBe(0);
    expect(counter.acquire()).toBe(true);
  });

  it("release below zero is a no-op (defensive)", () => {
    const counter = new SseConnectionCounter(1);
    counter.release(); // never acquired
    counter.release();
    expect(counter.open).toBe(0);
  });
});

describe("fire_and_forget", () => {
  it("resolves to the op's value on success", async () => {
    const out = await fire_and_forget(() => Promise.resolve(42));
    expect(out).toBe(42);
  });

  it("swallows rejection and resolves to undefined", async () => {
    const out = await fire_and_forget(() =>
      Promise.reject(new Error("closed"))
    );
    expect(out).toBeUndefined();
  });

  it("doesn't leak an unhandled rejection when the caller drops the result", async () => {
    // Intentionally do not await — fire_and_forget should still
    // attach the .catch so Node's unhandled-rejection hook stays quiet.
    fire_and_forget(() => Promise.reject(new Error("dropped")));
    // Give microtasks a chance to settle.
    await new Promise((r) => setTimeout(r, 0));
  });
});

describe("runSseSubscription", () => {
  type S = { _v: number; n: number };

  /**
   * Drain up to `count` frames from the generator. Resolves whatever
   * arrives before either the count is met or the generator
   * completes. Always returns the generator to its `finally` block.
   */
  async function take(
    gen: AsyncGenerator<SseSubscriptionFrame<S>>,
    count: number
  ): Promise<SseSubscriptionFrame<S>[]> {
    const frames: SseSubscriptionFrame<S>[] = [];
    for await (const frame of gen) {
      frames.push(frame);
      if (frames.length >= count) break;
    }
    return frames;
  }

  it("yields cached state first, then patches as they publish", async () => {
    const channel = new BroadcastChannel<S>();
    channel.publish("k", { _v: 1, n: 1 }, [{ n: 1 }]);
    const counter = new SseConnectionCounter(5);
    const gen = runSseSubscription(channel, "k", counter, undefined);

    setTimeout(() => channel.publish("k", { _v: 2, n: 2 }, [{ n: 2 }]), 10);
    const frames = await take(gen, 2);
    expect(frames[0]).toMatchObject({ kind: "state", data: { _v: 1 } });
    expect(frames[1]).toMatchObject({ kind: "patch" });
    expect(counter.open).toBe(0);
  });

  it("refuses a maxPending that would unbound the backlog, before taking a slot", async () => {
    const channel = new BroadcastChannel<S>();
    channel.publish("k", { _v: 1, n: 1 }, [{ n: 1 }]);
    const counter = new SseConnectionCounter(5);
    for (const maxPending of [Number.POSITIVE_INFINITY, Number.NaN, 0, 1.5])
      await expect(
        runSseSubscription(channel, "k", counter, undefined, {
          maxPending,
        }).next()
      ).rejects.toThrow(ZodError);
    expect(counter.open).toBe(0);
    // Control: an in-range bound opens on the cached state.
    const gen = runSseSubscription(channel, "k", counter, undefined, {
      maxPending: 2,
    });
    expect((await gen.next()).value).toMatchObject({ kind: "state" });
    await gen.return(undefined);
    expect(counter.open).toBe(0);
  });

  it("calls on_cap_exceeded when the counter is full", () => {
    const channel = new BroadcastChannel<S>();
    const counter = new SseConnectionCounter(0);
    const gen = runSseSubscription(channel, "k", counter, undefined, {
      on_cap_exceeded: () => {
        throw new Error("cap");
      },
    });
    return expect(gen.next()).rejects.toThrow(/cap/);
  });

  it("aborting the signal during the wait drains the loop", async () => {
    const channel = new BroadcastChannel<S>();
    channel.publish("k", { _v: 1, n: 1 }, [{ n: 1 }]);
    const counter = new SseConnectionCounter(1);
    const ctrl = new AbortController();
    const gen = runSseSubscription(channel, "k", counter, ctrl.signal);

    const first = await gen.next();
    expect(first.value).toMatchObject({ kind: "state" });
    // The loop is now awaiting the next publish — abort releases it
    // and the if-aborted check breaks the loop, running the finally.
    setTimeout(() => ctrl.abort(), 5);
    const drained = await gen.next();
    expect(drained.done).toBe(true);
    expect(counter.open).toBe(0);
  });

  it("skips the cached-state yield when no state has been published", async () => {
    const channel = new BroadcastChannel<S>();
    const counter = new SseConnectionCounter(1);
    const gen = runSseSubscription(channel, "k", counter, undefined);
    setTimeout(() => channel.publish("k", { _v: 1, n: 1 }, [{ n: 1 }]), 5);
    const frames = await take(gen, 1);
    expect(frames[0]).toMatchObject({ kind: "patch" });
    expect(counter.open).toBe(0);
  });

  it("drains queued patches without re-awaiting when multiple arrive between yields", async () => {
    const channel = new BroadcastChannel<S>();
    const counter = new SseConnectionCounter(5);
    const gen = runSseSubscription(channel, "k", counter, undefined);
    // Two synchronous publications — both queue before the consumer
    // can pull the first. The second-iteration `pending.length === 0`
    // check goes false, so the loop skips the await and shifts the
    // already-queued patch out without re-arming `resolve_wait`.
    setTimeout(() => {
      channel.publish("k", { _v: 1, n: 1 }, [{ n: 1 }]);
      channel.publish("k", { _v: 2, n: 2 }, [{ n: 2 }]);
    }, 5);
    const frames = await take(gen, 2);
    expect(frames[0]).toMatchObject({ kind: "patch" });
    expect(frames[1]).toMatchObject({ kind: "patch" });
    expect(counter.open).toBe(0);
  });

  it("releases the counter even when the consumer breaks early", async () => {
    const channel = new BroadcastChannel<S>();
    channel.publish("k", { _v: 1, n: 1 }, [{ n: 1 }]);
    const counter = new SseConnectionCounter(1);
    const gen = runSseSubscription(channel, "k", counter, undefined);
    const first = await gen.next();
    expect(first.value).toMatchObject({ kind: "state" });
    // Caller bails out without iterating further.
    await gen.return(undefined);
    expect(counter.open).toBe(0);
  });

  it("does not release a slot it never acquired when the cap is full and no on_cap_exceeded is supplied", async () => {
    // Defect #2: acquire() returns false, on_cap_exceeded is undefined,
    // so the loop runs with no slot — but the finally still calls
    // release(), decrementing _open below the true count and inflating
    // the effective cap. The counter starts at its limit (one live
    // holder), the generator fails to acquire, then closing it must NOT
    // drop the live holder's slot.
    const channel = new BroadcastChannel<S>();
    channel.publish("k", { _v: 1, n: 1 }, [{ n: 1 }]);
    const counter = new SseConnectionCounter(1);
    // One legitimate holder occupies the only slot.
    expect(counter.acquire()).toBe(true);
    expect(counter.open).toBe(1);

    // Cap is full; no on_cap_exceeded → generator falls through without
    // a slot of its own. Pull the cached-state frame, then close it.
    const gen = runSseSubscription(channel, "k", counter, undefined);
    const first = await gen.next();
    expect(first.value).toMatchObject({ kind: "state" });
    await gen.return(undefined); // runs the finally → release()

    // The live holder's slot must survive: exactly one open.
    expect(counter.open).toBe(1);
  });

  it("bounds a stalled consumer's backlog: an overflow becomes one _resync, then the newest patches", async () => {
    // A stalled consumer that never pulls must not let the backlog grow
    // without bound, nor lose versions silently: when a patch finds it full,
    // the stream's pending frames give way to one `_resync` (the client
    // refetches), and later patches queue behind it.
    const channel = new BroadcastChannel<S>();
    const counter = new SseConnectionCounter(5);
    const maxPending = 3;
    const gen = runSseSubscription(channel, "k", counter, undefined, {
      maxPending,
    });
    const primed = gen.next();
    const flood = 50;
    for (let i = 1; i <= flood; i++)
      channel.publish("k", { _v: i, n: i }, [{ n: i }]);

    // Publishes 1–3 fill the backlog; every third after that overflows and
    // swaps the stream's frames for one `_resync` (at 4, 7, …, 49), so the
    // consumer finds that resync, then patch 50.
    expect((await primed).value).toMatchObject({
      kind: "patch",
      data: { _resync: true },
    });
    expect((await gen.next()).value).toMatchObject({
      kind: "patch",
      data: { [flood]: { n: flood } },
    });
    await gen.return(undefined);
    expect(counter.open).toBe(0);
  });
});

describe("sse_states", () => {
  it("lists each state once, including states of a bare surface with no event schemas", () => {
    const app = {
      do: async () => [],
      registry: {
        actions: {
          open: { name: "Ticket", actions: {}, loads: { open: undefined } },
          close: { name: "Ticket", actions: {} },
          press: { name: "Calculator", actions: {} },
        },
        sensitive_fields: () => [],
      },
    };
    expect(sse_states(app, undefined, "hono").names).toEqual([
      "Ticket",
      "Calculator",
    ]);
  });

  describe("a state only reached through .loads", () => {
    const Taken = z.object({ who: z.string() });
    const loading = (loaded: State<any, any, any, string>, event: string) =>
      act()
        .withState(loaded)
        .withState(
          state({ Enrollment: z.object({}) })
            .init(() => ({}))
            .emits({ Enrolled: z.object({}) })
            .patch({ Enrolled: () => ({}) })
            .on({ Enroll: z.object({ who: z.string() }) })
            .loads(loaded, () => "shared", [event])
            .emit(({ who }) => [
              ["Enrolled", {}],
              [event, { who }],
            ])
            .build()
        )
        .build();

    it("gets its own subscription: its streams change too", () => {
      const Seats = state({ Seats: z.object({}) })
        .init(() => ({}))
        .emits({ SeatTaken: Taken })
        .patch({ SeatTaken: () => ({}) })
        .build();
      expect(
        sse_states(loading(Seats, "SeatTaken"), undefined, "trpc").names
      ).toEqual(["Enrollment", "Seats"]);
    });

    it("throws when its events declare sensitive fields", () => {
      const Vault = state({ Vault: z.object({}) })
        .init(() => ({}))
        .emits({ Locked: z.object({ who: sensitive(z.string()) }) })
        .patch({ Locked: () => ({}) })
        .build();
      expect(() =>
        sse_states(loading(Vault, "Locked"), undefined, "trpc")
      ).toThrow('trpc: state "Vault" can\'t be served over SSE');
    });
  });
});
