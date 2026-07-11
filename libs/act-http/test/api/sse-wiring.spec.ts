import { describe, expect, it } from "vitest";
import {
  DEFAULT_SSE_HEARTBEAT_MS,
  DEFAULT_SSE_MAX_CONNECTIONS,
  fireAndForget,
  resolveSseConfig,
  runSseSubscription,
  SseConnectionCounter,
  type SseSubscriptionFrame,
} from "../../src/api/sse-wiring.js";
import { BroadcastChannel } from "../../src/sse/index.js";

describe("resolveSseConfig", () => {
  const channel = new BroadcastChannel();

  it("applies defaults when knobs are omitted", () => {
    const cfg = resolveSseConfig({ channel });
    expect(cfg.channel).toBe(channel);
    expect(cfg.maxConnections).toBe(DEFAULT_SSE_MAX_CONNECTIONS);
    expect(cfg.heartbeatMs).toBe(DEFAULT_SSE_HEARTBEAT_MS);
  });

  it("preserves caller-supplied knobs", () => {
    const cfg = resolveSseConfig({
      channel,
      maxConnections: 100,
      heartbeatMs: 60_000,
    });
    expect(cfg.maxConnections).toBe(100);
    expect(cfg.heartbeatMs).toBe(60_000);
  });

  it("rejects maxConnections below the floor", () => {
    expect(() => resolveSseConfig({ channel, maxConnections: 0 })).toThrow();
  });

  it("rejects maxConnections above the ceiling", () => {
    expect(() =>
      resolveSseConfig({ channel, maxConnections: 10_001 })
    ).toThrow();
  });

  it("rejects non-finite maxConnections (NaN/Infinity)", () => {
    expect(() =>
      resolveSseConfig({ channel, maxConnections: Number.NaN })
    ).toThrow();
    expect(() =>
      resolveSseConfig({ channel, maxConnections: Number.POSITIVE_INFINITY })
    ).toThrow();
  });

  it("rejects heartbeatMs below the floor", () => {
    expect(() => resolveSseConfig({ channel, heartbeatMs: 14_999 })).toThrow();
  });

  it("rejects heartbeatMs above the ceiling", () => {
    expect(() => resolveSseConfig({ channel, heartbeatMs: 300_001 })).toThrow();
  });

  it("rejects non-finite heartbeatMs", () => {
    expect(() =>
      resolveSseConfig({ channel, heartbeatMs: Number.NaN })
    ).toThrow();
  });

  it("rejects fractional maxConnections", () => {
    // 500.5 would let the counter admit 501 for a '500' cap.
    expect(() =>
      resolveSseConfig({ channel, maxConnections: 500.5 })
    ).toThrow();
  });

  it("rejects fractional heartbeatMs", () => {
    expect(() =>
      resolveSseConfig({ channel, heartbeatMs: 30_000.5 })
    ).toThrow();
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

describe("fireAndForget", () => {
  it("resolves to the op's value on success", async () => {
    const out = await fireAndForget(() => Promise.resolve(42));
    expect(out).toBe(42);
  });

  it("swallows rejection and resolves to undefined", async () => {
    const out = await fireAndForget(() => Promise.reject(new Error("closed")));
    expect(out).toBeUndefined();
  });

  it("doesn't leak an unhandled rejection when the caller drops the result", async () => {
    // Intentionally do not await — fireAndForget should still
    // attach the .catch so Node's unhandled-rejection hook stays quiet.
    fireAndForget(() => Promise.reject(new Error("dropped")));
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

  it("bounds the per-connection pending buffer, dropping the oldest when a slow consumer stalls", async () => {
    // Defect #1: a stalled consumer that never pulls lets `pending`
    // grow without bound. With a bound of N, publishing far more than N
    // messages before the consumer reads must retain only the newest N
    // (drop-oldest), not every message.
    const channel = new BroadcastChannel<S>();
    const counter = new SseConnectionCounter(5);
    const maxPending = 3;
    const gen = runSseSubscription(channel, "k", counter, undefined, {
      maxPending,
    });

    // Prime the subscription: pull the first frame so the loop is now
    // awaiting the next publish and the subscriber callback is armed.
    const primed = gen.next();
    // The consumer stalls here — it never pulls again while we flood.
    // Flood the channel with far more than `maxPending` publications.
    const flood = 50;
    for (let i = 1; i <= flood; i++) {
      channel.publish("k", { _v: i, n: i }, [{ n: i }]);
    }

    // First frame is the earliest surviving patch (n === flood - maxPending + 1).
    const first = await primed;
    expect(first.value).toMatchObject({
      kind: "patch",
      data: { [flood - maxPending + 1]: { n: flood - maxPending + 1 } },
    });

    // Only `maxPending - 1` remain queued (one was just shifted out).
    const rest: SseSubscriptionFrame<S>[] = [];
    for (let i = 0; i < maxPending - 1; i++) {
      rest.push((await gen.next()).value as SseSubscriptionFrame<S>);
    }
    // The very last flooded message must be present (newest kept).
    expect(rest.at(-1)).toMatchObject({
      kind: "patch",
      data: { [flood]: { n: flood } },
    });

    await gen.return(undefined);
    expect(counter.open).toBe(0);
  });
});
