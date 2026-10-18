import { z } from "zod";
import {
  act,
  dispose,
  NonRetryableError,
  state,
  store,
  ZodEmpty,
} from "../src/index.js";
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

describe("settle loop wake-up during a running cycle", () => {
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

describe("a scheduled settle pass is never reset or replaced", () => {
  const breaker = () =>
    new CircuitBreaker({ failureThreshold: 5, cooldownMs: 1000 });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a caller's options when an internal wake-up lands mid-cycle", async () => {
    const seen: Array<number | undefined> = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let started!: () => void;
    const running = new Promise<void>((r) => {
      started = r;
    });
    const loop = new SettleLoop<Schemas>(
      {
        init: async () => {},
        checkpoint: () => -1,
        correlate: async () => ({ subscribed: 0, last_id: -1 }),
        drain: async (options) => {
          seen.push(options.eventLimit);
          if (seen.length === 1) {
            started();
            await gate;
          }
          return empty_drain();
        },
        on_settled: () => {},
        breaker: breaker(),
      },
      0
    );
    loop.schedule();
    await running;
    loop.schedule(); // a commit while the cycle runs
    loop.schedule({ eventLimit: 77 }); // the caller
    loop.schedule(); // another commit
    release();
    await vi.waitFor(() => expect(seen).toEqual([undefined, 77]));
    loop.stop(true);
  });

  it("doesn't put off a scheduled pass when more calls arrive", async () => {
    vi.useFakeTimers();
    const drain = vi.fn(async () => empty_drain());
    const loop = new SettleLoop<Schemas>(
      {
        init: async () => {},
        checkpoint: () => -1,
        correlate: async () => ({ subscribed: 0, last_id: -1 }),
        drain,
        on_settled: () => {},
        breaker: breaker(),
      },
      10
    );
    loop.schedule({ debounceMs: 50 });
    await vi.advanceTimersByTimeAsync(40);
    loop.schedule({ debounceMs: 50 }); // a caller
    loop.schedule(); // a commit
    await vi.advanceTimersByTimeAsync(10);
    expect(drain).toHaveBeenCalledTimes(1);
    loop.stop(true);
  });

  it("control — stop() drops the caller's options with the pending pass", async () => {
    vi.useFakeTimers();
    const seen: Array<number | undefined> = [];
    const loop = new SettleLoop<Schemas>(
      {
        init: async () => {},
        checkpoint: () => -1,
        correlate: async () => ({ subscribed: 0, last_id: -1 }),
        drain: async (options) => {
          seen.push(options.eventLimit);
          return empty_drain();
        },
        on_settled: () => {},
        breaker: breaker(),
      },
      10
    );
    loop.schedule({ eventLimit: 5 });
    loop.stop();
    loop.schedule();
    await vi.advanceTimersByTimeAsync(10);
    expect(seen).toEqual([undefined]);
    loop.stop(true);
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
describe("settle loop paginates past inert windows", () => {
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

/**
 * #1329 — a settle pass records a circuit-breaker `passed()` only when
 * correlate really probed the store. It always does since #1487: correlate
 * scans for every app, so the pass that used to be a no-op early-return on a
 * static-reaction app (whose fictitious success re-closed an OPEN breaker
 * mid-outage and let the drain hammer the down store) is now a real store
 * query that fails when the store is down.
 */
describe("settle breaker success rides a real correlate probe", () => {
  const open_breaker = () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 60_000,
    });
    breaker.failed(1000, new Error("store down"));
    expect(breaker.state(1000)).toBe("open");
    return breaker;
  };

  /** Runs one pass, resolving whichever way the pass ends. */
  const run_pass = async (
    breaker: CircuitBreaker,
    correlate: () => Promise<{
      subscribed: number;
      last_id: number;
      scanned?: boolean;
    }>
  ) => {
    let done!: () => void;
    const finished = new Promise<void>((r) => {
      done = r;
    });
    const loop = new SettleLoop<Schemas>(
      {
        init: async () => {},
        checkpoint: () => 5,
        correlate: async (q) => {
          try {
            return await correlate();
          } finally {
            // The failing arm never reaches on_settled — release here so the
            // assertion runs either way. `q` keeps the signature honest.
            void q;
            setTimeout(done, 0);
          }
        },
        drain: async () => empty_drain(),
        on_settled: () => done(),
        breaker,
      },
      0
    );
    loop.schedule({ debounceMs: 0 });
    await finished;
    loop.stop();
  };

  it("closes the breaker when the scan returns (control)", async () => {
    const breaker = open_breaker();
    await run_pass(breaker, async () => ({
      subscribed: 0,
      last_id: 5,
      scanned: true,
    }));
    expect(breaker.state(1000)).toBe("closed");
  });

  it("leaves the breaker OPEN when correlate was disarmed and read nothing", async () => {
    // #1510: a disarmed pass returns without touching the store, so it is not
    // evidence the store is healthy. Recording it would re-close an OPEN
    // breaker mid-outage and let the drain hammer a store nobody has heard
    // from — the #1329 bug, reachable again now that correlate can skip.
    const breaker = open_breaker();
    await run_pass(breaker, async () => ({
      subscribed: 0,
      last_id: 5,
      scanned: false,
    }));
    expect(breaker.state(1000)).toBe("open");
  });

  it("leaves the breaker OPEN when the scan fails against a down store", async () => {
    const breaker = open_breaker();
    await run_pass(breaker, async () => {
      throw new Error("store down");
    });
    expect(breaker.state(1000)).toBe("open");
  });
});

describe("settled payload", () => {
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
describe("a throwing settled listener is contained", () => {
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
      .build({ autoSettle: false, ...opts } as never);

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

describe("a local change settles its own reactions", () => {
  const Ping = state({ Ping: z.object({ n: z.number() }) })
    .init(() => ({ n: 0 }))
    .emits({ Pinged: ZodEmpty, Noted: ZodEmpty })
    .patch({ Pinged: (_, s) => ({ n: s.n + 1 }), Noted: (_, s) => s })
    .on({ ping: ZodEmpty })
    .emit(() => ["Pinged", {}])
    .on({ note: ZodEmpty })
    .emit(() => ["Noted", {}])
    .build();
  const actor = { id: "a", name: "a" };

  const reacting = (ran: string[]) =>
    act()
      .withState(Ping)
      .on("Pinged")
      .do(async function track(event) {
        ran.push(event.stream);
      })
      .to("tracker")
      .build();

  afterEach(async () => {
    await dispose()();
  });

  it("runs the reaction with no settle wiring", async () => {
    const ran: string[] = [];
    const app = reacting(ran);
    await app.do("ping", { stream: "p1", actor }, {});
    await vi.waitFor(() => expect(ran).toEqual(["p1"]));
  });

  it("runs nothing on its own with autoSettle: false, until the caller walks the pipeline", async () => {
    const ran: string[] = [];
    const app = act()
      .withState(Ping)
      .on("Pinged")
      .do(async function track(event) {
        ran.push(event.stream);
      })
      .to("tracker")
      .build({ autoSettle: false });
    await app.do("ping", { stream: "p2", actor }, {});
    await new Promise((r) => setTimeout(r, 50));
    expect(ran).toEqual([]);
    await app.correlate();
    const drained = await app.drain();
    expect(drained.acked.map((l) => l.stream)).toEqual(["tracker"]);
    expect(ran).toEqual(["p2"]);
  });

  it("runs no reaction for a commit after shutdown", async () => {
    const ran: string[] = [];
    const app = reacting(ran);
    await app.shutdown();
    await app.do("ping", { stream: "late", actor }, {});
    await new Promise((r) => setTimeout(r, 50));
    expect(ran).toEqual([]);
  });

  it("replays a reset target with no settle call", async () => {
    const ran: string[] = [];
    const app = reacting(ran);
    await app.do("ping", { stream: "r1", actor }, {});
    await vi.waitFor(() => expect(ran).toEqual(["r1"]));
    expect(await app.reset(["tracker"])).toBe(1);
    await vi.waitFor(() => expect(ran).toEqual(["r1", "r1"]));
  });

  it("resumes an unblocked stream with no settle call", async () => {
    let fail = true;
    const ran: string[] = [];
    const app = act()
      .withState(Ping)
      .on("Pinged")
      .do(async function flaky(event) {
        if (fail) throw new NonRetryableError("down");
        ran.push(event.stream);
      })
      .to("flaky")
      .build();
    // Wait for the commit's own settle to finish, so nothing is running.
    const idle = new Promise((r) => app.on("settled", r));
    await app.do("ping", { stream: "u1", actor }, {});
    await idle;
    expect(await app.blocked_streams()).toHaveLength(1);
    fail = false;
    expect(await app.unblock(["flaky"])).toBe(1);
    await vi.waitFor(() => expect(ran).toEqual(["u1"]));
  });

  it("control — a reset that resets nothing schedules nothing", async () => {
    const settled = vi.fn();
    const app = reacting([]);
    app.on("settled", settled);
    expect(await app.reset(["nobody"])).toBe(0);
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).not.toHaveBeenCalled();
  });

  it("control — schedules nothing for an event no reaction handles", async () => {
    const settled = vi.fn();
    const app = reacting([]);
    app.on("settled", settled);
    await app.do("note", { stream: "p3", actor }, {});
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).not.toHaveBeenCalled();
  });
});
