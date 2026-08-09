import { z } from "zod";
import { act, dispose, state, store, ZodEmpty } from "../src/index.js";
import { CircuitBreaker } from "../src/internal/circuit-breaker.js";
import { SettleLoop } from "../src/internal/settle.js";
import type { Drain, Schemas } from "../src/types/index.js";

/**
 * ACT-1205 — SettleLoop.schedule must not drop a wake-up requested while
 * a cycle is running.
 *
 * `schedule()`'s timer used to bail with `if (this._running) return;` and
 * no pending flag. A commit landing during the final no-progress drain
 * pass — whose `schedule({debounceMs:0})` fires before `_running` clears
 * — was consumed: the armed controllers stayed armed but nothing
 * re-drained on an instance with no lane `cycleMs` and no polling.
 *
 * The fix records a `_pending` flag when the timer fires mid-cycle and
 * re-schedules it in `finally`. RED on the old code (the second wake-up
 * yields no second cycle); GREEN once the pending pass runs.
 */

const empty_drain = (): Drain<Schemas> => ({
  fetched: [],
  leased: [],
  acked: [],
  blocked: [],
});

describe("settle loop wake-up during a running cycle (ACT-1205)", () => {
  it("runs a cycle for a schedule() that fires while a cycle is in flight", async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 5,
      cooldownMs: 1000,
    });

    let drains = 0;
    let started_signal!: () => void;
    const started = new Promise<void>((r) => {
      started_signal = r;
    });
    let gate_release!: () => void;
    const gate = new Promise<void>((r) => {
      gate_release = r;
    });

    const loop = new SettleLoop<Schemas>(
      {
        init: async () => {},
        checkpoint: () => -1,
        correlate: async () => ({ subscribed: 0, last_id: -1 }),
        drain: async () => {
          drains++;
          if (drains === 1) {
            // First cycle's drain is in flight — signal, then hold so the
            // second schedule() lands while _running is still true.
            started_signal();
            await gate;
          }
          return empty_drain();
        },
        on_settled: () => {},
        breaker,
        correlate_probes_store: true,
      },
      0
    );

    // Kick off cycle 1.
    loop.schedule({ debounceMs: 0 });
    await started; // cycle 1's drain is running

    // Fire a wake-up while the cycle is running. The old code drops it.
    loop.schedule({ debounceMs: 0 });
    // Let the wake-up's zero-delay timer actually fire while _running is
    // still true — that's the exact window the bug lives in. Only then
    // release the in-flight cycle.
    await new Promise((r) => setTimeout(r, 10));

    // Let cycle 1 finish; its finally must re-arm the pending pass.
    gate_release();

    // Give the event loop time to run the re-armed cycle.
    await new Promise((r) => setTimeout(r, 20));

    expect(drains).toBeGreaterThanOrEqual(2);
    loop.stop();
  });
});

/**
 * ACT-1309 — SettleLoop must keep paginating while correlate advances its
 * checkpoint, even when a window subscribes/drains nothing.
 *
 * The loop used to derive progress solely from subscribe/ack/block counts,
 * discarding correlate's `last_id`. A bounded correlate window (`limit`)
 * full of globally-inert events advanced the checkpoint but registered "no
 * progress", so the loop broke before the next window — holding a reactive
 * event — was ever scanned. Counting `last_id > after_before` as progress
 * fixes it; it terminates because ids are monotonic and finite.
 */
describe("settle loop paginates past inert windows (ACT-1309)", () => {
  it("keeps correlating while last_id advances, though nothing subscribes or drains", async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 5,
      cooldownMs: 1000,
    });

    const MAX = 4; // inert events exist at ids 0..4
    let checkpoint = -1;
    let correlate_calls = 0;
    let settled_signal!: () => void;
    const settled = new Promise<void>((r) => {
      settled_signal = r;
    });

    const loop = new SettleLoop<Schemas>(
      {
        init: async () => {},
        checkpoint: () => checkpoint,
        correlate: async ({ after, limit }) => {
          correlate_calls++;
          // Scan a `limit`-sized window and advance the checkpoint, like the
          // real CorrelateCycle — but subscribe nothing (all events inert).
          const next = Math.min((after ?? -1) + (limit ?? 2), MAX);
          checkpoint = next;
          return { subscribed: 0, last_id: next };
        },
        drain: async () => empty_drain(),
        on_settled: () => settled_signal(),
        breaker,
        correlate_probes_store: true,
      },
      0
    );

    loop.schedule({ correlate: { after: -1, limit: 2 }, debounceMs: 0 });
    await settled;

    // -1 → 1 → 3 → 4 → (4, no advance → stop): four correlate passes.
    // On the old code the first inert pass broke the loop (1 call).
    expect(correlate_calls).toBe(4);
    expect(checkpoint).toBe(MAX);
    loop.stop();
  });
});

/**
 * #1329 — the settle loop must not record a circuit-breaker `passed()` when
 * correlate didn't probe the store. On a static-reaction app correlate is a
 * no-op early-return; recording a fictitious success there re-closes an OPEN
 * breaker mid-outage and lets the drain hammer the down store.
 */
describe("settle breaker success is gated on a real correlate probe (#1329)", () => {
  const open_breaker = () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 60_000,
    });
    breaker.failed(1000, new Error("store down"));
    expect(breaker.state(1000)).toBe("open");
    return breaker;
  };

  const run_pass = async (
    breaker: CircuitBreaker,
    correlate_probes_store: boolean
  ) => {
    let settled_resolve!: () => void;
    const settled = new Promise<void>((r) => {
      settled_resolve = r;
    });
    const loop = new SettleLoop<Schemas>(
      {
        init: async () => {},
        checkpoint: () => 5,
        // No-op correlate (static app shape): no store call.
        correlate: async () => ({ subscribed: 0, last_id: 5 }),
        drain: async () => empty_drain(),
        on_settled: () => settled_resolve(),
        breaker,
        correlate_probes_store,
      },
      0
    );
    loop.schedule({ debounceMs: 0 });
    await settled;
    loop.stop();
  };

  it("does not close an OPEN breaker when correlate did not probe the store", async () => {
    const breaker = open_breaker();
    await run_pass(breaker, false);
    expect(breaker.state(1000)).toBe("open");
  });

  it("still closes the breaker when correlate probed the store (control)", async () => {
    const breaker = open_breaker();
    await run_pass(breaker, true);
    expect(breaker.state(1000)).toBe("closed");
  });
});

describe("settled payload (#1383)", () => {
  const Counter = state({ Counter: z.object({ n: z.number() }) })
    .init(() => ({ n: 0 }))
    .emits({ Ticked: ZodEmpty })
    .patch({ Ticked: (_e, s) => ({ n: s.n + 1 }) })
    .on({ tick: ZodEmpty })
    .emit(() => ["Ticked", {}])
    .build();

  const actor = { id: "a", name: "a" };

  afterEach(async () => {
    await dispose()();
  });

  // The loop only exits on a pass that made NO progress, so emitting that
  // pass alone made the payload always empty — while observability.md
  // tells operators to sum `drain.fetched` for throughput.
  it("reports the work the settle did, not its final empty pass", async () => {
    let handled = 0;
    const app = act()
      .withState(Counter)
      .on("Ticked")
      .do(async function react() {
        handled++;
      })
      .to((e) => ({ target: `t-${e.stream}` }))
      .build();

    const payloads: { acked: { stream: string }[]; fetched: unknown[] }[] = [];
    const acked_events: { stream: string }[] = [];
    app.on("settled", (d) => payloads.push(d as never));
    app.on("acked", (leases) => acked_events.push(...(leases as never[])));

    await app.do("tick", { stream: "p1", actor }, {});
    await app.do("tick", { stream: "p2", actor }, {});

    const done = new Promise<void>((resolve) => {
      app.on("settled", () => resolve());
    });
    app.settle({ debounceMs: 0 });
    await done;

    expect(handled).toBe(2);
    expect(payloads).toHaveLength(1);
    // Both reaction streams appear in the settle's payload.
    const acked_streams = payloads[0].acked.map((l) => l.stream).sort();
    expect(acked_streams).toContain("t-p1");
    expect(acked_streams).toContain("t-p2");
    expect(payloads[0].fetched.length).toBeGreaterThan(0);
    // The payload is exactly the union of what the dedicated `acked`
    // listener saw across the settle's passes — which is what the
    // observability guide's "don't double-count them here" presupposes.
    expect(payloads[0].acked.map((l) => l.stream).sort()).toEqual(
      acked_events.map((l) => l.stream).sort()
    );

    await app.shutdown();
  });
});

// #1436 — `on_settled` sat inside the IIFE whose `.catch` records
// `breaker.failed()`, and every other statement in that block IS a store op
// (`init`, `correlate`, `drain` — and `drain` never throws, it catches
// internally). So a throwing observability listener was indistinguishable
// from the store going away: a spurious `error` event on every settle, and
// at `failureThreshold: 1` an OPEN breaker that returned EMPTY_DRAIN for the
// whole cooldown, re-tripping on each half-open recovery. A broken metrics
// bridge stalled the reaction pipeline indefinitely.
describe("a throwing settled listener is contained (#1436)", () => {
  const Counter = state({ Counter: z.object({ n: z.number() }) })
    .init(() => ({ n: 0 }))
    .emits({ Ticked: ZodEmpty })
    .patch({ Ticked: (_e, s) => ({ n: s.n + 1 }) })
    .on({ tick: ZodEmpty })
    .emit(() => ["Ticked", {}])
    .build();

  const actor = { id: "a", name: "a" };

  afterEach(async () => {
    await dispose()();
  });

  const build = (opts?: object) =>
    act()
      .withState(Counter)
      .on("Ticked")
      .do(async function react() {})
      .to((e) => ({ target: `t-${e.stream}` }))
      .build(opts as never);

  /**
   * Settle, waiting on a resolver registered BEFORE the throwing listener so
   * the throw cannot suppress it (an EventEmitter aborts the remaining
   * listeners for that event).
   */
  const settle_once = async (
    app: ReturnType<typeof build>,
    thrower?: () => void
  ) => {
    const done = new Promise<void>((resolve) => {
      app.on("settled", () => resolve());
    });
    if (thrower) app.on("settled", thrower);
    app.settle({ debounceMs: 0 });
    await done;
    // let the IIFE's .catch run before asserting on what it recorded
    await new Promise((r) => setTimeout(r, 20));
  };

  it("does not record the listener's throw as a store failure", async () => {
    const app = build();
    const errors: unknown[] = [];
    app.on("error", (e) => errors.push(e));

    await app.do("tick", { stream: "c1", actor }, {});
    await settle_once(app, () => {
      throw new Error("metrics bridge exploded");
    });

    expect(errors).toEqual([]);
    await app.shutdown();
  });

  it("does not open the breaker, so the pipeline keeps draining", async () => {
    // failureThreshold 1 is legal and schema-validated, so one spurious
    // failure was enough to stall everything for a full cooldown.
    const app = build({
      circuitBreaker: { failureThreshold: 1, cooldownMs: 30_000 },
    });
    const errors: unknown[] = [];
    app.on("error", (e) => errors.push(e));

    await app.do("tick", { stream: "c2", actor }, {});
    await settle_once(app, () => {
      throw new Error("metrics bridge exploded");
    });

    // A follow-up unit of work must still drain.
    await app.do("tick", { stream: "c2", actor }, {});
    await app.correlate();
    const drained = await app.drain();

    expect({ errors, acked: drained.acked.length }).toEqual({
      errors: [],
      acked: 1,
    });
    await app.shutdown();
  });

  it("control — a non-throwing settled listener still fires and stays clean", async () => {
    const app = build();
    const errors: unknown[] = [];
    let settled = 0;
    app.on("error", (e) => errors.push(e));

    await app.do("tick", { stream: "c3", actor }, {});
    await settle_once(app, () => {
      settled++;
    });

    expect(errors).toEqual([]);
    expect(settled).toBeGreaterThan(0);
    await app.shutdown();
  });

  it("control — a real store failure still reaches the breaker", async () => {
    // The containment must not swallow the thing the catch exists for.
    const app = build();
    const errors: unknown[] = [];
    app.on("error", (e) => errors.push(e));
    const boom = vi
      .spyOn(store(), "subscribe")
      .mockRejectedValue(new Error("store is down"));

    await app.do("tick", { stream: "c4", actor }, {}).catch(() => {});
    app.settle({ debounceMs: 0 });
    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0));

    expect(String((errors[0] as { error?: Error })?.error)).toContain(
      "store is down"
    );
    boom.mockRestore();
    await app.shutdown();
  });
});
