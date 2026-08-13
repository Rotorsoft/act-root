/**
 * #1442 — `shutdown()` used to stop *scheduling* without waiting for or
 * cancelling a drain cycle already in flight. A handler parked on an `await`
 * kept running, its stream stayed leased until the lease expired (dead time
 * for the replacement worker on every rolling deploy), and its ack landed
 * after teardown, where a dropped ack means the round of work is discarded
 * and redelivered (#1418).
 */
import { act, dispose, state, store } from "@rotorsoft/act";
import type { StreamPosition } from "@rotorsoft/act/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const ZodEmpty = z.object({});

/** One state whose `Ticked` event drives a reaction we can park on demand. */
const Ticker = state({ Ticker: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Ticked: ZodEmpty })
  .patch({ Ticked: (_, s) => ({ count: s.count + 1 }) })
  .on({ tick: ZodEmpty })
  .emit(() => ["Ticked", {}])
  .build();

const gate = () => {
  let release!: () => void;
  let entered = false;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return {
    release,
    get entered() {
      return entered;
    },
    wait: async () => {
      entered = true;
      await promise;
    },
  };
};

/** Build an Act whose only reaction parks on `g`, on the default lane. */
const parked_app = (g: ReturnType<typeof gate>) =>
  act()
    .withState(Ticker)
    .on("Ticked")
    .do(async function parkedHandler() {
      await g.wait();
    })
    .to({ target: "out" })
    .build();

/** Same, but the reaction runs on a lane with its own lease budget. */
const laned_parked_app = (g: ReturnType<typeof gate>, leaseMillis: number) =>
  act()
    .withState(Ticker)
    .withLane({ name: "slow", leaseMillis })
    .on("Ticked")
    .do(async function parkedHandler() {
      await g.wait();
    })
    .to({ target: "out", lane: "slow" })
    .build();

/** Spin until `check` holds or the deadline passes. */
const until = async (check: () => boolean, ms = 2_000) => {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline)
    await new Promise<void>((r) => setTimeout(r, 5));
};

const positions = async () => {
  const seen: StreamPosition[] = [];
  await store().query_streams((s) => seen.push(s), {});
  return seen;
};

afterEach(async () => {
  await dispose()("EXIT").catch(() => {});
  vi.useRealTimers();
});

describe("shutdown grace budget", () => {
  it("awaits an in-flight cycle so the handler finishes and the lease is released", async () => {
    const g = gate();
    const app = parked_app(g);
    const actor = { id: "a", name: "a" };
    await app.do("tick", { stream: "src", actor }, {});
    await app.correlate();

    // Fire the cycle but don't await it — the handler parks inside.
    const draining = app.drain({ leaseMillis: 5_000 });
    await until(() => g.entered);
    expect(g.entered).toBe(true);

    // Before the fix this resolved in ~0 ms with the handler still parked.
    let settled = false;
    const shutting = app.shutdown({ graceMs: 5_000 }).then(() => {
      settled = true;
    });
    await new Promise<void>((r) => setTimeout(r, 50));
    expect(settled).toBe(false);

    g.release();
    await shutting;
    await draining;

    // The handler reached its ack, so nothing is left leased for the
    // replacement worker to wait out.
    const [out] = (await positions()).filter((s) => s.stream === "out");
    expect(out.leased_by).toBeFalsy();
    expect(out.at).toBeGreaterThanOrEqual(0);
  });

  it("still observes acked listeners for work that completes during the window", async () => {
    // Listeners used to come off first, so the completing handler's outcome
    // was unobservable even when it landed.
    const g = gate();
    const app = parked_app(g);
    const acked = vi.fn();
    app.on("acked", acked);
    const actor = { id: "a", name: "a" };
    await app.do("tick", { stream: "src", actor }, {});
    await app.correlate();

    const draining = app.drain({ leaseMillis: 5_000 });
    await until(() => g.entered);
    const shutting = app.shutdown({ graceMs: 5_000 });
    g.release();
    await shutting;
    await draining;
    expect(acked).toHaveBeenCalled();
  });

  it("graceMs: 0 keeps the old behavior — returns without waiting", async () => {
    const g = gate();
    const app = parked_app(g);
    const actor = { id: "a", name: "a" };
    await app.do("tick", { stream: "src", actor }, {});
    await app.correlate();
    const draining = app.drain({ leaseMillis: 5_000 });
    await until(() => g.entered);

    const started = Date.now();
    await app.shutdown({ graceMs: 0 });
    expect(Date.now() - started).toBeLessThan(50);

    g.release();
    await draining;
  });

  it("proceeds when the budget is exhausted — one stuck handler cannot hang teardown", async () => {
    const g = gate();
    const app = parked_app(g);
    const actor = { id: "a", name: "a" };
    await app.do("tick", { stream: "src", actor }, {});
    await app.correlate();
    const draining = app.drain({ leaseMillis: 5_000 });
    await until(() => g.entered);

    // Never released — teardown must still complete on the budget.
    await app.shutdown({ graceMs: 30 });

    g.release();
    await draining;
  });

  it("is idempotent — the first call's budget applies", async () => {
    const app = parked_app(gate());
    const first = app.shutdown({ graceMs: 0 });
    expect(app.shutdown({ graceMs: 5_000 })).toBe(first);
    await first;
  });

  it("returns immediately when nothing is in flight", async () => {
    const app = parked_app(gate());
    const started = Date.now();
    await app.shutdown();
    expect(Date.now() - started).toBeLessThan(50);
  });

  it("rejects a nonsensical graceMs at the call, not on the next tick", async () => {
    const app = parked_app(gate());
    expect(() => app.shutdown({ graceMs: -1 })).toThrow();
    expect(() => app.shutdown({ graceMs: Number.NaN })).toThrow();
    await app.shutdown({ graceMs: 0 });
  });
});

describe("default grace budget derivation", () => {
  /** Park a cycle, then measure the budget by advancing fake time. */
  const budget_of = async (lane?: number) => {
    const g = gate();
    const app = lane === undefined ? parked_app(g) : laned_parked_app(g, lane);
    const actor = { id: "a", name: "a" };
    await app.do("tick", { stream: "src", actor }, {});
    await app.correlate();
    const draining = app.drain({ leaseMillis: 60_000 });
    await until(() => g.entered);

    vi.useFakeTimers();
    let settled = false;
    const shutting = app.shutdown().then(() => {
      settled = true;
    });
    return {
      /** True once teardown gave up waiting at `ms`. */
      settles_at: async (ms: number) => {
        await vi.advanceTimersByTimeAsync(ms - 1);
        const before = settled;
        await vi.advanceTimersByTimeAsync(2);
        const after = settled;
        vi.useRealTimers();
        g.release();
        await shutting;
        await draining;
        return { before, after };
      },
    };
  };

  it("defaults to drain's own 10s lease fallback when no lane pinned one", async () => {
    const { settles_at } = await budget_of();
    expect(await settles_at(10_000)).toEqual({ before: false, after: true });
  });

  it("uses the lane's configured leaseMillis", async () => {
    const { settles_at } = await budget_of(3_000);
    expect(await settles_at(3_000)).toEqual({ before: false, after: true });
  });

  it("caps a long lane lease at 30s so one handler cannot hold a deploy open", async () => {
    const { settles_at } = await budget_of(120_000);
    expect(await settles_at(30_000)).toEqual({ before: false, after: true });
  });
});
