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
