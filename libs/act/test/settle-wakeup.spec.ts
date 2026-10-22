import { z } from "zod";
import {
  act,
  dispose,
  InMemoryStore,
  NonRetryableError,
  state,
  store,
  ZodEmpty,
} from "../src/index.js";
import { SettleLoop } from "../src/internal/settle.js";
import type { Committed, Drain, Query, Schemas } from "../src/types/index.js";

/**
 * SettleLoop.schedule must not drop a wake-up requested while a cycle is
 * running. A commit landing during the final no-progress pass would
 * otherwise be lost: its lanes stay armed, but nothing drains them on an
 * instance with no lane `cycleMs` and no polling. A wake-up mid-cycle sets
 * `_pending`, and the cycle's `finally` schedules one more pass.
 */

const empty_drain = (): Drain<Schemas> => ({
  fetched: [],
  leased: [],
  acked: [],
  blocked: [],
});

describe("settle loop wake-up during a running cycle", () => {
  it("runs a cycle for a schedule() that fires while a cycle is in flight", async () => {
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
        correlate: async () => ({ subscribed: 0, read: false }),
        drain: async () => {
          drains++;
          if (drains === 1) {
            // First cycle's drain is in flight — signal, then hold so the
            // second schedule() lands while the cycle is still in flight.
            started_signal();
            await gate;
          }
          return empty_drain();
        },
        on_settled: () => {},
      },
      0
    );

    // Kick off cycle 1.
    loop.schedule({ debounceMs: 0 });
    await started; // cycle 1's drain is running

    // Fire a wake-up while the cycle is running.
    loop.schedule({ debounceMs: 0 });
    // Let the wake-up's zero-delay timer fire while the cycle is still in
    // flight, the window a lost wake-up would fall in, before releasing it.
    await new Promise((r) => setTimeout(r, 10));

    // Let cycle 1 finish; its finally must re-arm the pending pass.
    gate_release();

    // Give the event loop time to run the re-armed cycle.

    await vi.waitFor(() => expect(drains).toBeGreaterThanOrEqual(2));
    loop.stop();
  });
});

describe("a scheduled settle pass is never reset or replaced", () => {
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
        correlate: async () => ({ subscribed: 0, read: false }),
        drain: async (options) => {
          seen.push(options.eventLimit);
          if (seen.length === 1) {
            started();
            await gate;
          }
          return empty_drain();
        },
        on_settled: () => {},
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
        correlate: async () => ({ subscribed: 0, read: false }),
        drain,
        on_settled: () => {},
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

  it("a pass queued mid-cycle keeps the caller's delay", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const drain = vi.fn(async () => {
      if (drain.mock.calls.length === 1) await gate;
      return empty_drain();
    });
    const loop = new SettleLoop<Schemas>(
      {
        correlate: async () => ({ subscribed: 0, read: false }),
        drain,
        on_settled: () => {},
      },
      1000
    );
    loop.schedule({ debounceMs: 0 });
    await vi.advanceTimersByTimeAsync(0); // the first cycle holds in drain
    loop.schedule({ debounceMs: 0 }); // the caller, mid-cycle
    release();
    await vi.advanceTimersByTimeAsync(1);
    expect(drain).toHaveBeenCalledTimes(2); // not 1000ms later
    loop.stop(true);
  });

  it("brings a scheduled pass forward for a shorter delay", async () => {
    vi.useFakeTimers();
    const drain = vi.fn(async () => empty_drain());
    const loop = new SettleLoop<Schemas>(
      {
        correlate: async () => ({ subscribed: 0, read: false }),
        drain,
        on_settled: () => {},
      },
      10
    );
    loop.schedule({ debounceMs: 5000 }); // a caller's long delay
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
        correlate: async () => ({ subscribed: 0, read: false }),
        drain: async (options) => {
          seen.push(options.eventLimit);
          return empty_drain();
        },
        on_settled: () => {},
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
 * SettleLoop must keep paginating while correlate advances its
 * checkpoint, even when a window subscribes/drains nothing.
 *
 * The loop used to derive progress solely from subscribe/ack/block counts,
 * discarding how far correlate read. A bounded correlate window (`limit`)
 * full of globally-inert events advanced the checkpoint but registered "no
 * progress", so the loop broke before the next window — holding a reactive
 * event — was ever scanned. Counting a pass that read events as progress
 * fixes it; it terminates because ids are monotonic and finite.
 */
describe("settle loop paginates past inert windows", () => {
  it("keeps correlating while last_id advances, though nothing subscribes or drains", async () => {
    const MAX = 4; // inert events exist at ids 0..4
    let checkpoint = -1;
    let correlate_calls = 0;
    let settled_signal!: () => void;
    const settled = new Promise<void>((r) => {
      settled_signal = r;
    });

    const loop = new SettleLoop<Schemas>(
      {
        correlate: async ({ limit }) => {
          correlate_calls++;
          // Scan a `limit`-sized window past its own checkpoint, like the
          // real CorrelateCycle — but subscribe nothing (all events inert).
          const next = Math.min(checkpoint + (limit ?? 2), MAX);
          const read = next > checkpoint;
          checkpoint = next;
          return { subscribed: 0, read };
        },
        drain: async () => empty_drain(),
        on_settled: () => settled_signal(),
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

// A throwing `settled` listener must not look like the store going away:
// that would be a spurious `error` event on every settle, and at
// `failureThreshold: 1` an OPEN breaker that returned EMPTY_DRAIN for the
// whole cooldown, re-tripping on each half-open recovery, so a broken
// metrics bridge would stall the reaction pipeline indefinitely.
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

  it("keeps a caller's settle options while start_correlations polls", async () => {
    const app = act()
      .withState(Ping)
      .on("Pinged")
      .do(async function track() {})
      .to("tracker")
      .build({ autoSettle: false });
    const acks: string[][] = [];
    app.on("acked", (leases) => acks.push(leases.map((l) => l.stream)));
    for (let i = 0; i < 3; i++)
      await app.do("ping", { stream: "p", actor }, {});
    app.start_correlations({ limit: 5 }, 5);
    try {
      // The 5ms tick brings the pass forward; it must keep the caller's
      // eventLimit, so the three events ack one per pass.
      app.settle({ eventLimit: 1, debounceMs: 60 });
      await vi.waitFor(() =>
        expect(acks.filter((a) => a.includes("tracker"))).toHaveLength(3)
      );
    } finally {
      app.stop_correlations();
    }
  });

  it("scans with the poll's limit only while the poll runs", async () => {
    const app = reacting([]);
    const scanned = vi.spyOn(app as never, "_correlate_pass") as unknown as {
      mock: { calls: Array<[{ limit?: number }]> };
    };
    const limit = () => scanned.mock.calls.at(-1)?.[0].limit;
    app.start_correlations({ limit: 5 }, 5);
    await vi.waitFor(() => expect(limit()).toBe(5));
    app.stop_correlations();
    app.settle({ correlate: { limit: 7 } });
    await vi.waitFor(() => expect(limit()).toBe(7));
    app.settle();
    await vi.waitFor(() => expect(limit()).toBe(100));
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

describe("a wake that lands during an empty scan or claim is kept", () => {
  /** Holds the next empty `claim` or full-log `query` until the test lets it go. */
  class PausingStore extends InMemoryStore {
    hold: "claim" | "query" | undefined;
    held?: () => void;
    go?: () => void;
    private async _hold() {
      this.hold = undefined;
      const gate = new Promise<void>((r) => (this.go = r));
      this.held?.();
      await gate;
    }
    override async claim(...args: Parameters<InMemoryStore["claim"]>) {
      const leases = await super.claim(...args);
      if (this.hold === "claim" && leases.length === 0) await this._hold();
      return leases;
    }
    override async query<E extends Schemas>(
      callback: (event: Committed<E, keyof E>) => void,
      query?: Query
    ) {
      const n = await super.query(callback, query);
      if (this.hold === "query" && n === 0 && !query?.stream)
        await this._hold();
      return n;
    }
  }
  const Tick = state({ Tick: z.object({ n: z.number() }) })
    .init(() => ({ n: 0 }))
    .emits({ Ticked: ZodEmpty })
    .patch({ Ticked: (_, s) => ({ n: s.n + 1 }) })
    .on({ tick: ZodEmpty })
    .emit(() => ["Ticked", {}])
    .build();
  const actor = { id: "a", name: "a" };
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  afterEach(async () => {
    await dispose()();
  });

  const unblocked = async (during_claim: boolean) => {
    const s = new PausingStore();
    store(s);
    let fail = true;
    const ran: number[] = [];
    const app = act()
      .withState(Tick)
      .on("Ticked")
      .do(async function react(event) {
        if (fail) throw new NonRetryableError("poison");
        ran.push(event.id);
      })
      .to("target")
      .build();
    const blocked = new Promise<void>((r) => app.on("blocked", () => r()));
    await app.do("tick", { stream: "c", actor }, {});
    await blocked;
    await pause(50);
    fail = false;
    if (during_claim) {
      s.hold = "claim";
      const held = new Promise<void>((r) => (s.held = r));
      // The blocked target's claim comes back empty and is held in flight.
      await app.do("tick", { stream: "c", actor }, {});
      await held;
      expect(await app.unblock(["target"])).toBe(1);
      s.go!();
    } else {
      await app.do("tick", { stream: "c", actor }, {});
      await pause(100);
      expect(await app.unblock(["target"])).toBe(1);
    }
    return ran;
  };

  it("drains a stream unblocked while an empty claim is in flight", async () => {
    const ran = await unblocked(true);
    await vi.waitFor(() => expect(ran).toHaveLength(2));
  });

  it("control — drains a stream unblocked after the pass", async () => {
    const ran = await unblocked(false);
    await vi.waitFor(() => expect(ran).toHaveLength(2));
  });

  const committed = async (during_scan: boolean) => {
    const s = new PausingStore();
    store(s);
    const ran: number[] = [];
    const app = act()
      .withState(Tick)
      .on("Ticked")
      .do(async function react(event) {
        ran.push(event.id);
      })
      .to("target")
      .build();
    await app.do("tick", { stream: "c", actor }, {});
    await vi.waitFor(() => expect(ran).toHaveLength(1));
    await pause(50);
    if (during_scan) {
      s.hold = "query";
      const held = new Promise<void>((r) => (s.held = r));
      await app.do("tick", { stream: "c", actor }, {});
      // The pass's confirming scan comes back empty and is held in flight.
      await held;
      await app.do("tick", { stream: "c", actor }, {});
      s.go!();
    } else {
      await app.do("tick", { stream: "c", actor }, {});
      await app.do("tick", { stream: "c", actor }, {});
    }
    return ran;
  };

  it("reacts to a commit that lands while an empty scan is in flight", async () => {
    const ran = await committed(true);
    await vi.waitFor(() => expect(ran).toHaveLength(3));
  });

  it("control — reacts to commits that land between passes", async () => {
    const ran = await committed(false);
    await vi.waitFor(() => expect(ran).toHaveLength(3));
  });
});
