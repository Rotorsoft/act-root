import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  act,
  type CloseResult,
  dispose,
  type Lease,
  state,
  store,
  ZodEmpty,
} from "../src/index.js";
import { CloseSignal } from "../src/internal/close-signal.js";
import { DeferSignal } from "../src/internal/defer-signal.js";

/**
 * Durability of the defer outcome (#1124): a failed `Store.defer` write must
 * never stall a recurring stream or drop the rest of the cycle's outcomes.
 *
 * Contract pinned here:
 * - the failed write is surfaced on the `error` lifecycle event (breaker),
 * - the affected stream stays immediately re-claimable (no local park, no
 *   `deferred_at`), so the next drain redelivers, the handler re-throws its
 *   `DeferSignal`, and the persist retry heals the durable schedule,
 * - close requests and ack lifecycle events from the same cycle survive —
 *   close targets are acked before the defer write, so losing them to a
 *   thrown persist would drop the close permanently.
 */
describe("defer durability (#1124)", () => {
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

  it("redelivers and heals the schedule when the defer write fails", async () => {
    let attempts = 0;
    // Far-future due-time: any redelivery inside this test comes from the
    // unpersisted/unparked failure path, never from the schedule elapsing.
    const until = new Date(Date.now() + 60_000);
    const deferring = async () => {
      attempts++;
      throw new DeferSignal({ at: until });
    };

    const app = act().withState(counter).on("ticked").do(deferring).build();
    const errors: string[] = [];
    app.on("error", ({ error }) => errors.push(String(error)));

    const defer_spy = vi
      .spyOn(store(), "defer")
      .mockRejectedValueOnce(new Error("disk full"));

    await app.do("tick", { stream: "h1", actor }, {});
    await app.correlate();

    // Cycle 1: handler defers, the durable write fails. No ack, no block —
    // and the failure is an operator-visible lifecycle event.
    const first = await app.drain({ leaseMillis: 1 });
    expect(attempts).toBe(1);
    expect(first.acked).toHaveLength(0);
    expect(first.blocked).toHaveLength(0);
    expect(errors.some((m) => m.includes("defer persist failed"))).toBe(true);
    expect(errors.some((m) => m.includes("h1"))).toBe(true);

    // Cycle 2: the stream was neither parked locally nor deferred durably,
    // so it redelivers immediately — well before the due-time. The handler
    // re-throws its DeferSignal and the persist retry succeeds.
    const second = await app.drain({ leaseMillis: 1 });
    expect(attempts).toBe(2);
    expect(second.acked).toHaveLength(0);
    expect(defer_spy).toHaveBeenCalledTimes(2);

    // Cycle 3: the schedule is durable now — claim skips the stream until
    // the due-time, so the handler is not re-run.
    await app.drain({ leaseMillis: 1 });
    expect(attempts).toBe(2);
  });

  it("keeps the drain armed while a defer write is unhealed", async () => {
    const deferring = async () => {
      throw new DeferSignal({ at: new Date(Date.now() + 60_000) });
    };
    const app = act().withState(counter).on("ticked").do(deferring).build();
    app.on("error", () => {});

    vi.spyOn(store(), "defer").mockRejectedValue(new Error("still down"));

    await app.do("tick", { stream: "h2", actor }, {});
    await app.correlate();

    await app.drain({ leaseMillis: 1 });
    // A healthy defer would have parked the stream and (with nothing else
    // pending) let the controller disarm. The failed write must keep it
    // armed so the redelivery that heals the schedule actually runs.
    const again = await app.drain({ leaseMillis: 1 });
    expect(again.leased.some((l: Lease) => l.stream === "h2")).toBe(true);
  });

  it("a close request in the same cycle survives a failed defer write", async () => {
    // Two streams claimed in one cycle: one defers (its write will fail),
    // the other closes. Before #1124 the thrown persist aborted the cycle
    // after the close target was acked — the close was lost permanently.
    const handler = async (_e: unknown, stream: string) => {
      if (stream === "d-defer")
        throw new DeferSignal({ at: new Date(Date.now() + 60_000) });
      throw new CloseSignal();
    };

    const app = act().withState(counter).on("ticked").do(handler).build();
    const closed: CloseResult[] = [];
    const acked_streams: string[] = [];
    app.on("closed", (r) => closed.push(r));
    app.on("acked", (leases) =>
      acked_streams.push(...leases.map((l) => l.stream))
    );
    app.on("error", () => {});

    vi.spyOn(store(), "defer").mockRejectedValueOnce(new Error("disk full"));

    await app.do("tick", { stream: "d-defer", actor }, {});
    await app.do("tick", { stream: "d-close", actor }, {});
    await app.correlate();

    const cycle = await app.drain({ leaseMillis: 1 });

    // The close request and its ack lifecycle event both landed despite the
    // failed defer write in the same cycle.
    expect(closed).toHaveLength(1);
    expect(closed[0].truncated.has("d-close")).toBe(true);
    expect(acked_streams).toContain("d-close");
    expect(cycle.acked.some((l) => l.stream === "d-close")).toBe(true);
  });
});
