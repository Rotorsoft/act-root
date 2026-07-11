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

  it("re-seeds the DeferTimer from persisted deferred_at at cold start (#1221)", async () => {
    // A stream is deferred to a future due-time and persisted (subscribe
    // registers it, defer sets deferred_at). Then the process "restarts":
    // a fresh Act builds new controllers with an EMPTY in-memory
    // DeferTimer. Nothing commits to this idle stream — the only thing
    // that can re-arm the drain is a cold-start read of the persisted
    // deferred_at. Without the fix the DeferTimer stays empty, the
    // controller disarms, and the due-time never re-arms the drain.
    const due = Date.now() + 60_000;
    // Persist the deferred stream directly on the shared (singleton) store,
    // simulating the state left behind by a pre-restart worker.
    await store().subscribe([{ stream: "idle-agg", source: "idle-agg" }]);
    await store().defer(["idle-agg"], due);

    // Cold start: a fresh Act over the same store, new controllers + a new
    // (empty) DeferTimer. init() must re-seed the timer from deferred_at.
    const noop = async () => {};
    const app = act().withState(counter).on("ticked").do(noop).build();
    await app.correlate();

    const controllers = (
      app as unknown as {
        _drain_controllers: Map<
          string,
          { _defer: { size: number; is_deferred: (s: string) => boolean } }
        >;
      }
    )._drain_controllers;
    const controller = controllers.get("default")! as unknown as {
      _defer: { size: number; is_deferred: (s: string) => boolean };
      armed: boolean;
    };
    const defer_timer = controller._defer;
    expect(defer_timer.size).toBe(1);
    expect(defer_timer.is_deferred("idle-agg")).toBe(true);
  });

  it("re-arms the drain at the persisted due-time with no intervening commit (#1221)", async () => {
    // A near-future due-time so a real-time wait is short. The store's own
    // async ops use real setTimeout, so fake timers can't drive the wake
    // without deadlocking the store — a short real delay is the honest test.
    const due = Date.now() + 40;
    await store().subscribe([{ stream: "idle-agg", source: "idle-agg" }]);
    await store().defer(["idle-agg"], due);

    const noop = async () => {};
    const app = act().withState(counter).on("ticked").do(noop).build();
    await app.correlate();
    // Drive the cold-start drain to the disarmed state: the deferred stream
    // isn't claimable yet, so the controller disarms on the empty claim.
    await app.drain();

    const controller = (
      app as unknown as {
        _drain_controllers: Map<string, { armed: boolean }>;
      }
    )._drain_controllers.get("default")!;

    // Disarmed, and nothing has committed to the idle aggregate.
    expect(controller.armed).toBe(false);

    // Past the due-time: the re-seeded timer wakes and re-arms the
    // controller — the only thing that could, since no commit intervened.
    await sleep(80);
    expect(controller.armed).toBe(true);
  });

  it("seeds a non-default lane's controller from persisted deferred_at (#1221)", async () => {
    const due = Date.now() + 60_000;
    // A deferred stream stored on the "slow" lane.
    await store().subscribe([
      { stream: "slow-agg", source: "slow-agg", lane: "slow" },
    ]);
    await store().defer(["slow-agg"], due);

    const noop = async () => {};
    const app = act()
      .withState(counter)
      .withLane({ name: "slow" })
      .on("ticked")
      .do(noop)
      .build();
    await app.correlate();

    const controllers = (
      app as unknown as {
        _drain_controllers: Map<
          string,
          { _defer: { size: number; is_deferred: (s: string) => boolean } }
        >;
      }
    )._drain_controllers;
    // Seeded on the "slow" controller, not "default".
    expect(controllers.get("slow")!._defer.is_deferred("slow-agg")).toBe(true);
    expect(controllers.get("default")!._defer.size).toBe(0);
  });

  it("skips a deferred stream whose lane is excluded by onlyLanes (#1221)", async () => {
    const due = Date.now() + 60_000;
    // A deferred stream on the "slow" lane, but this instance runs only
    // "fast" — no controller owns "slow", so the seed must skip it (a peer
    // worker owns that timer). Covers the missing-controller branch.
    await store().subscribe([
      { stream: "slow-agg", source: "slow-agg", lane: "slow" },
    ]);
    await store().defer(["slow-agg"], due);

    const noop = async () => {};
    const app = act()
      .withState(counter)
      .withLane({ name: "slow" })
      .withLane({ name: "fast" })
      .on("ticked")
      .do(noop)
      .build({ onlyLanes: ["fast"] });
    await app.correlate();

    const controllers = (
      app as unknown as {
        _drain_controllers: Map<string, { _defer: { size: number } }>;
      }
    )._drain_controllers;
    // Only "fast" has a controller; nothing was seeded (slow is a peer's).
    expect(controllers.has("slow")).toBe(false);
    expect(controllers.get("fast")!._defer.size).toBe(0);
  });

  it("routes a lane-less persisted defer to the default controller (#1221)", async () => {
    // A StreamPosition may omit `lane` (the field is optional on the port).
    // An adapter that returns no lane must route to the default controller.
    // Stub query_streams to hand back exactly that shape.
    const due = Date.now() + 60_000;
    vi.spyOn(store(), "query_streams").mockImplementationOnce(
      async (callback) => {
        callback({
          stream: "lane-less",
          at: -1,
          retry: -1,
          blocked: false,
          error: "",
          priority: 0,
          deferred_at: due,
        });
        return { maxEventId: -1, count: 1 };
      }
    );

    const noop = async () => {};
    const app = act().withState(counter).on("ticked").do(noop).build();
    await app.correlate();

    const controllers = (
      app as unknown as {
        _drain_controllers: Map<
          string,
          { _defer: { is_deferred: (s: string) => boolean } }
        >;
      }
    )._drain_controllers;
    expect(controllers.get("default")!._defer.is_deferred("lane-less")).toBe(
      true
    );
  });

  it("does not seed a past-due deferred_at at cold start (#1221)", async () => {
    // A past-due schedule is already claimable — the ordinary armed drain
    // handles it, so the cold-start seed skips it. Covers the
    // `deferred_at <= now` branch.
    await store().subscribe([{ stream: "past-agg", source: "past-agg" }]);
    await store().defer(["past-agg"], Date.now() - 1_000);

    const noop = async () => {};
    const app = act().withState(counter).on("ticked").do(noop).build();
    await app.correlate();

    const controllers = (
      app as unknown as {
        _drain_controllers: Map<string, { _defer: { size: number } }>;
      }
    )._drain_controllers;
    expect(controllers.get("default")!._defer.size).toBe(0);
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
