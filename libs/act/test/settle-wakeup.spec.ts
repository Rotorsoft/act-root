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
