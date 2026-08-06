import { z } from "zod";
import { act, dispose, state, ZodEmpty } from "../src/index.js";
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
