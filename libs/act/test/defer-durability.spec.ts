import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  act,
  type CloseResult,
  dispose,
  sleep,
  state,
  store,
  ZodEmpty,
} from "../src/index.js";
import { CloseSignal } from "../src/internal/close-signal.js";
import { DeferSignal } from "../src/internal/defer-signal.js";

/**
 * Durability of the defer outcome: defer schedules are persisted
 * **atomically with the acks** in a single `Store.ack` call, so a drain
 * cycle's outcomes can never land partially. A failed finalize acks
 * nothing — close requests stay pending and redeliver, the deferred
 * stream stays claimable and redelivers, and the ordinary
 * catch → breaker → redeliver path covers every outcome uniformly.
 */
describe("defer durability", () => {
  const counter = state({ Counter: z.object({ count: z.number() }) })
    .init(() => ({ count: 0 }))
    .emits({ ticked: ZodEmpty })
    .patch({ ticked: () => ({}) })
    .on({ tick: ZodEmpty })
    .emit(() => ["ticked", {}])
    .build();

  const actor = { id: "a", name: "a" };

  afterEach(async () => {
    vi.restoreAllMocks();
    await dispose()();
  });

  it("a failed finalize lands nothing — close requests are never lost", async () => {
    // Two streams in one cycle: one defers (far-future due-time), one
    // closes. When the atomic ack call fails, the close target must NOT
    // have been acked — a schedule write failing after the acks would drop
    // the close permanently (the terminal event, once acked, is never
    // redelivered).
    let defer_attempts = 0;
    const handler = async (_e: unknown, stream: string) => {
      if (stream === "d-defer") {
        defer_attempts++;
        throw new DeferSignal({ at: new Date(Date.now() + 60_000) });
      }
      throw new CloseSignal();
    };

    const app = act().withState(counter).on("ticked").do(handler).build();
    const closed: CloseResult[] = [];
    const errors: string[] = [];
    app.on("closed", (r) => closed.push(r));
    app.on("error", ({ error }) => errors.push(String(error)));

    const ack_spy = vi.spyOn(store(), "ack");
    ack_spy.mockRejectedValueOnce(new Error("disk full"));

    await app.do("tick", { stream: "d-defer", actor }, {});
    await app.do("tick", { stream: "d-close", actor }, {});
    await app.correlate();

    // Cycle 1: the atomic finalize fails — nothing lands. No close, no
    // ack, and the failure is an operator-visible lifecycle event.
    const first = await app.drain({ leaseMillis: 1 });
    expect(first.acked).toHaveLength(0);
    expect(closed).toHaveLength(0);
    expect(errors.length).toBeGreaterThan(0);

    // Cycle 2: everything redelivers — the close lands, the handler
    // re-throws its DeferSignal, and the retried finalize persists the
    // schedule. Nothing was lost to the failure.
    const second = await app.drain({ leaseMillis: 1 });
    expect(closed).toHaveLength(1);
    expect(closed[0].truncated.has("d-close")).toBe(true);
    expect(second.acked.some((l) => l.stream === "d-close")).toBe(true);
    expect(defer_attempts).toBe(2);

    // Cycle 3: the schedule is durable — claim skips the deferred stream
    // until its due-time, so the handler is not re-run.
    await app.drain({ leaseMillis: 1 });
    expect(defer_attempts).toBe(2);
  });

  it("persists the defer schedule in the same store call as the acks", async () => {
    const due = new Date(Date.now() + 60_000);
    const deferring = async () => {
      throw new DeferSignal({ at: due });
    };
    const app = act().withState(counter).on("ticked").do(deferring).build();

    const ack_spy = vi.spyOn(store(), "ack");
    const defer_spy = vi.spyOn(store(), "defer");

    await app.do("tick", { stream: "h1", actor }, {});
    await app.correlate();
    await app.drain({ leaseMillis: 1 });

    // One atomic call: the deferred lease rides the finalize batch marked
    // with `due`; the standalone defer() op is not part of drain
    // finalization anymore.
    expect(ack_spy).toHaveBeenCalledWith([
      expect.objectContaining({ stream: "h1", due: due.getTime() }),
    ]);
    expect(defer_spy).not.toHaveBeenCalled();
  });

  it("keeps the drain armed while finalization is unhealed", async () => {
    let attempts = 0;
    const deferring = async () => {
      attempts++;
      throw new DeferSignal({ at: new Date(Date.now() + 60_000) });
    };
    const app = act().withState(counter).on("ticked").do(deferring).build();
    app.on("error", () => {});

    vi.spyOn(store(), "ack").mockRejectedValue(new Error("still down"));

    await app.do("tick", { stream: "h2", actor }, {});
    await app.correlate();

    await app.drain({ leaseMillis: 1 });
    expect(attempts).toBe(1);
    // The failed finalize keeps the controller armed (catch path) and the
    // schedule unpersisted, so the next drain redelivers — the loop that
    // eventually heals the schedule keeps running while the store is down.
    // The short wait lets the 1ms lease from the failed cycle expire.
    await sleep(10);
    await app.drain({ leaseMillis: 1 });
    expect(attempts).toBe(2);
  });
});
