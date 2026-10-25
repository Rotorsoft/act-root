import { z } from "zod";
import { act, dispose, sleep, state, store, ZodEmpty } from "../src/index.js";
import { compute_backoff_delay } from "../src/internal/backoff.js";
import {
  DEFAULT_BACKOFF,
  resolveBackoffConfig,
} from "../src/internal/config.js";
import type { BackoffOptions } from "../src/types/index.js";

describe("compute_backoff_delay", () => {
  it("returns 0 when opts is undefined", () => {
    expect(compute_backoff_delay(0, undefined)).toBe(0);
    expect(compute_backoff_delay(5, undefined)).toBe(0);
  });

  it("returns 0 when baseMs is non-positive", () => {
    expect(compute_backoff_delay(3, { strategy: "fixed", baseMs: 0 })).toBe(0);
    expect(compute_backoff_delay(3, { strategy: "fixed", baseMs: -10 })).toBe(
      0
    );
  });

  it("fixed: returns baseMs regardless of retry", () => {
    const opts: BackoffOptions = { strategy: "fixed", baseMs: 100 };
    expect(compute_backoff_delay(0, opts)).toBe(100);
    expect(compute_backoff_delay(3, opts)).toBe(100);
    expect(compute_backoff_delay(99, opts)).toBe(100);
  });

  it("linear: scales by (retry + 1)", () => {
    const opts: BackoffOptions = { strategy: "linear", baseMs: 50 };
    expect(compute_backoff_delay(0, opts)).toBe(50);
    expect(compute_backoff_delay(1, opts)).toBe(100);
    expect(compute_backoff_delay(4, opts)).toBe(250);
  });

  it("exponential: doubles per retry", () => {
    const opts: BackoffOptions = { strategy: "exponential", baseMs: 100 };
    expect(compute_backoff_delay(0, opts)).toBe(100);
    expect(compute_backoff_delay(1, opts)).toBe(200);
    expect(compute_backoff_delay(3, opts)).toBe(800);
  });

  it("exponential: clamps to maxMs when provided", () => {
    const opts: BackoffOptions = {
      strategy: "exponential",
      baseMs: 100,
      maxMs: 500,
    };
    expect(compute_backoff_delay(3, opts)).toBe(500); // 800 → 500
    expect(compute_backoff_delay(10, opts)).toBe(500);
  });

  it("jitter: keeps delay in [floor(0.5 * d), d) bounds", () => {
    const opts: BackoffOptions = {
      strategy: "fixed",
      baseMs: 1000,
      jitter: true,
    };
    for (let i = 0; i < 100; i++) {
      const d = compute_backoff_delay(0, opts);
      expect(d).toBeGreaterThanOrEqual(500);
      expect(d).toBeLessThan(1500);
    }
  });

  it("clamps negative retry to 0", () => {
    const opts: BackoffOptions = { strategy: "exponential", baseMs: 100 };
    expect(compute_backoff_delay(-1, opts)).toBe(100);
    expect(compute_backoff_delay(-99, opts)).toBe(100);
  });

  it("throws on an off-union strategy instead of returning NaN", () => {
    // Defensive default: reachable only via an unvalidated direct call — the
    // builder validates at declaration. Must never silently emit NaN.
    expect(() =>
      compute_backoff_delay(0, {
        strategy: "expontential" as never,
        baseMs: 100,
      })
    ).toThrow(/unknown backoff strategy/);
  });
});

describe("resolveBackoffConfig", () => {
  it("passes undefined through untouched", () => {
    expect(resolveBackoffConfig(undefined)).toBeUndefined();
  });

  it("returns the validated config for a good bag", () => {
    const ok: BackoffOptions = {
      strategy: "exponential",
      baseMs: 10,
      maxMs: 200,
      jitter: true,
    };
    expect(resolveBackoffConfig(ok)).toEqual(ok);
    // baseMs: 0 is legal (means no delay).
    expect(resolveBackoffConfig({ strategy: "fixed", baseMs: 0 })).toEqual({
      strategy: "fixed",
      baseMs: 0,
    });
  });

  it("rejects an off-union strategy, non-finite/negative baseMs, and non-positive maxMs", () => {
    const bad: BackoffOptions[] = [
      { strategy: "expontential" as never, baseMs: 100 },
      { strategy: "fixed", baseMs: Number.NaN },
      { strategy: "fixed", baseMs: Number.POSITIVE_INFINITY },
      { strategy: "fixed", baseMs: -1 },
      { strategy: "exponential", baseMs: 10, maxMs: 0 },
      { strategy: "exponential", baseMs: 10, maxMs: Number.NaN },
    ];
    for (const b of bad) expect(() => resolveBackoffConfig(b)).toThrow();
  });
});

describe("backoff config is validated at build", () => {
  const counter = state({ Counter: z.object({ count: z.number() }) })
    .init(() => ({ count: 0 }))
    .emits({ ticked: ZodEmpty })
    .patch({ ticked: () => ({}) })
    .on({ tick: ZodEmpty })
    .emit(() => ["ticked", {}])
    .build();

  it("throws on a reaction with a bad backoff strategy", () => {
    async function react() {}
    expect(() =>
      act()
        .withState(counter)
        .on("ticked")
        .do(react, {
          backoff: { strategy: "expontential" as never, baseMs: 1 },
        })
        .build()
    ).toThrow();
  });

  it("throws on an action with a NaN baseMs backoff", () => {
    expect(() =>
      state({ S: z.object({ n: z.number() }) })
        .init(() => ({ n: 0 }))
        .emits({ e: ZodEmpty })
        .patch({ e: () => ({}) })
        .on(
          { act: ZodEmpty },
          { backoff: { strategy: "fixed", baseMs: Number.NaN } }
        )
        .emit(() => ["e", {}])
        .build()
    ).toThrow();
  });
});

describe("per-reaction backoff (integration)", () => {
  const counter = state({ Counter: z.object({ count: z.number() }) })
    .init(() => ({ count: 0 }))
    .emits({ ticked: ZodEmpty })
    .patch({ ticked: () => ({}) })
    .on({ tick: ZodEmpty })
    .emit(() => ["ticked", {}])
    .build();

  const actor = { id: "a", name: "a" };

  afterEach(async () => {
    await dispose()();
  });

  it("defers retry until backoff window elapses (persisted schedule)", async () => {
    let attempts = 0;
    const handler = vi.fn().mockImplementation(async () => {
      attempts++;
      throw new Error("transient");
    });
    Object.defineProperty(handler, "name", { value: "flakyHandler" });

    const app = act()
      .withState(counter)
      .on("ticked")
      .do(handler, {
        maxRetries: 5,
        backoff: { strategy: "fixed", baseMs: 200 },
      })
      .build({ autoSettle: false });

    // Only `Date` is faked: "inside the window" holds however slow the
    // runner is, and the wake's real timer still fires.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await app.do("tick", { stream: "s1", actor }, {});
      await app.correlate();

      // First attempt fails — controller now defers
      await app.drain();
      expect(attempts).toBe(1);

      // Next drain, still inside the window: the stream is in backoff
      vi.setSystemTime(Date.now() + 50);
      await app.drain();
      expect(attempts).toBe(1);

      // Past the window — the wake runs the retry
      vi.setSystemTime(Date.now() + 200);
      await vi.waitFor(() => expect(attempts).toBe(2));
    } finally {
      vi.useRealTimers();
    }
  });

  // A reaction with no backoff is paced by the default one, not by the lease
  // of whichever drain claimed it. Only `Date` is faked, so the store's async
  // work runs on real timers while the clock jumps past the default.
  describe("with no backoff configured", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });
    const past_default_backoff = () =>
      vi.setSystemTime(Date.now() + DEFAULT_BACKOFF.baseMs + 1);

    it("retries after the default backoff, whatever the drain's lease", async () => {
      let attempts = 0;
      const app = act()
        .withState(counter)
        .on("ticked")
        .do(
          async function alwaysFails() {
            attempts++;
            throw new Error("transient");
          },
          { maxRetries: 5 }
        )
        .build({ autoSettle: false });

      await app.do("tick", { stream: "s1", actor }, {});
      await app.correlate();
      await app.drain();
      expect(attempts).toBe(1);

      // The schedule is persisted, so a lapsed 1ms lease changes nothing.
      let deferred_at: number | undefined;
      await store().query_streams((p) => {
        if (p.stream === "s1") deferred_at = p.deferred_at;
      });
      expect(deferred_at).toBeGreaterThanOrEqual(
        Date.now() + DEFAULT_BACKOFF.baseMs - 50
      );
      await sleep(20);
      await app.drain();
      expect(attempts).toBe(1);

      // That empty claim disarmed the drain; the wake would re-arm it at the
      // due-time, but its timer runs on the real clock.
      past_default_backoff();
      (
        app as unknown as {
          _drain_controllers: Map<string, { arm(): void }>;
        }
      )._drain_controllers
        .get("default")!
        .arm();
      await app.drain();
      expect(attempts).toBe(2);
    });

    it("spends the whole retry budget and blocks", async () => {
      let attempts = 0;
      const blocked: string[] = [];
      const app = act()
        .withState(counter)
        .on("ticked")
        .do(
          async function alwaysFails() {
            attempts++;
            throw new Error("transient");
          },
          { maxRetries: 2, blockOnError: true }
        )
        .build({ autoSettle: false });
      app.on("blocked", (leases) => {
        for (const l of leases as { stream: string }[]) blocked.push(l.stream);
      });

      await app.do("tick", { stream: "s1", actor }, {});
      await app.correlate();
      for (let i = 0; i < 6; i++) {
        await app.drain();
        past_default_backoff();
      }
      expect(attempts).toBe(3);
      expect(blocked).toEqual(["s1"]);
    });
  });

  it("advances the watermark past the succeeded prefix AND persists the window on partial progress", async () => {
    // Two `ticked` events land on one stream for a single backoff reaction.
    // The handler succeeds on the first event and throws on the second —
    // partial progress (handled > 0 AND error AND next_attempt_at set). The
    // finalize must (a) advance the watermark to the FIRST event (so the
    // handled prefix never re-runs on redelivery) AND (b) ride a `due` marker
    // so the durable, cross-worker backoff window is persisted with
    // the climbing retry. Advance and defer are independent ack legs.
    let calls = 0;
    const handler = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls >= 2) throw new Error("transient");
    });
    Object.defineProperty(handler, "name", { value: "partialThenFail" });

    const app = act()
      .withState(counter)
      .on("ticked")
      .do(handler, {
        maxRetries: 5,
        backoff: { strategy: "fixed", baseMs: 5000 },
      })
      .build({ autoSettle: false });

    const ack_spy = vi.spyOn(store(), "ack");

    // Two events on the same stream → both fetched in one claim → one handle()
    // runs the handler twice (partial progress).
    await app.do("tick", { stream: "s-partial", actor }, {});
    await app.do("tick", { stream: "s-partial", actor }, {});
    await app.correlate();

    // The first (succeeded) event's id — the watermark must land here.
    const [firstEvent] = await app.query_array({
      stream: "s-partial",
      stream_exact: true,
    });
    const firstId = firstEvent.id;

    await app.drain();

    // Partial progress actually happened: first succeeded, second threw.
    expect(calls).toBe(2);

    // The finalize batch advances AND defers in one entry: exactly one entry
    // carries a future `due`, advances `at` to the succeeded event, and is NOT
    // a plain defer (retry !== -1, so the budget keeps accruing).
    const ack_arg = (ack_spy.mock.calls.at(-1)?.[0] ?? []) as Array<{
      stream: string;
      at: number;
      due?: number;
      retry: number;
    }>;
    const deferred = ack_arg.filter((e) => e.due !== undefined);
    expect(deferred).toHaveLength(1);
    expect(deferred[0].stream).toBe("s-partial");
    expect(deferred[0].at).toBe(firstId); // advanced past the succeeded event
    expect(deferred[0].due).toBeGreaterThan(Date.now());
    expect(deferred[0].retry).not.toBe(-1);

    // Durable state: query_streams surfaces BOTH the advanced watermark (the
    // handled prefix won't re-run) and the persisted window (what a fresh
    // worker's claim honors).
    let pos: { at?: number; deferred_at?: number } | undefined;
    await store().query_streams((p) => {
      if (p.stream === "s-partial") pos = p;
    });
    expect(pos?.at).toBe(firstId);
    expect(pos?.deferred_at).toBeGreaterThan(Date.now());
  });

  it("clears backoff entry on successful ack", async () => {
    let attempts = 0;
    const handler = vi.fn().mockImplementation(async () => {
      attempts++;
      if (attempts < 2) throw new Error("transient");
    });
    Object.defineProperty(handler, "name", { value: "selfHealing" });

    const app = act()
      .withState(counter)
      .on("ticked")
      .do(handler, {
        maxRetries: 5,
        backoff: { strategy: "fixed", baseMs: 50 },
      })
      .build({ autoSettle: false });

    await app.do("tick", { stream: "s2", actor }, {});
    await app.correlate();

    const acked: string[] = [];
    app.on("acked", (leases) => acked.push(...leases.map((l) => l.stream)));
    await app.drain();
    expect(attempts).toBe(1);

    // The wake runs the retry once the backoff window elapses.
    await vi.waitFor(() => {
      expect(attempts).toBe(2);
      expect(acked).toEqual(["s2"]);
    });
  });

  it("preserves blocking behavior when retries are exhausted", async () => {
    let attempts = 0;
    const handler = vi.fn().mockImplementation(async () => {
      attempts++;
      throw new Error("permanent");
    });
    Object.defineProperty(handler, "name", { value: "alwaysFails" });

    const app = act()
      .withState(counter)
      .on("ticked")
      .do(handler, {
        maxRetries: 1,
        backoff: { strategy: "fixed", baseMs: 10 },
      })
      .build({ autoSettle: false });

    await app.do("tick", { stream: "s3", actor }, {});
    await app.correlate();

    const blocked: string[] = [];
    app.on("blocked", (leases) => blocked.push(...leases.map((l) => l.stream)));
    await app.drain();
    expect(attempts).toBe(1);

    // The wake runs the retry: retry=1, maxRetries=1 → block
    await vi.waitFor(() => {
      expect(attempts).toBe(2);
      expect(blocked).toEqual(["s3"]);
    });
  });

  it("a wake for the earlier backoff leaves the later one parked", async () => {
    // Two streams back off 30ms apart on a frozen clock, then the clock
    // moves to where only the first is due. Whenever the wake fires, it
    // retries the first and leaves the second parked.
    const attempts: Record<string, number> = { early: 0, late: 0 };
    const handler = vi
      .fn()
      .mockImplementation(async (event: { stream: string }) => {
        attempts[event.stream]++;
        throw new Error("transient");
      });
    Object.defineProperty(handler, "name", { value: "multiStream" });

    const app = act()
      .withState(counter)
      .on("ticked")
      .do(handler, {
        maxRetries: 5,
        backoff: { strategy: "fixed", baseMs: 50 },
      })
      .build({ autoSettle: false });

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // "early" fails at T: due at T+50.
      await app.do("tick", { stream: "early", actor }, {});
      await app.correlate();
      await app.drain();
      expect(attempts.early).toBe(1);

      // "late" fails at T+30: due at T+80. A drain finding a pass in flight
      // claims nothing, so drain until `late` ran.
      vi.setSystemTime(Date.now() + 30);
      await app.do("tick", { stream: "late", actor }, {});
      await app.correlate();
      await vi.waitFor(async () => {
        await app.drain();
        expect(attempts.late).toBe(1);
      });

      // At T+60 only "early" is due.
      vi.setSystemTime(Date.now() + 30);
      await vi.waitFor(() => expect(attempts.early).toBe(2), { interval: 5 });
      expect(attempts.late).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("backoff window is honored precisely via persisted deferred_at, not the lease duration", async () => {
    // A retry-with-backoff persists `deferred_at = now + backoff` and
    // releases the lease, so the store gates the next attempt on the backoff
    // window — independent of `leaseMillis`. A backoff far shorter than the
    // lease is honored (the released lease no longer floors it), and no
    // in-window re-claim can phantom-bump the retry counter.
    let attempts = 0;
    const handler = vi.fn().mockImplementation(async () => {
      attempts++;
      throw new Error("transient");
    });
    Object.defineProperty(handler, "name", { value: "backoffPaced" });

    const app = act()
      .withState(counter)
      .on("ticked")
      .do(handler, {
        maxRetries: 5,
        backoff: { strategy: "fixed", baseMs: 50 },
      })
      .build({ autoSettle: false });

    // A real worker/commit keeps the controller armed; once a drain claims
    // nothing (the stream is deferred) it self-disarms, so we re-arm before
    // each probe to isolate the backoff gate from the arm flag.
    const ctrl = (
      app as unknown as {
        _drain_controllers: Map<string, { arm: () => void }>;
      }
    )._drain_controllers.get("default")!;

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await app.do("tick", { stream: "floor", actor }, {});
      await app.correlate();

      // First attempt fails — the stream is deferred for 50ms and the 500ms
      // lease is released (the due-ack persists the schedule and frees it).
      await app.drain({ leaseMillis: 500 });
      expect(attempts).toBe(1);

      // 20ms later: still inside the 50ms backoff window → deferred_at
      // excludes it from claim, so no re-attempt and no phantom retry bump.
      vi.setSystemTime(Date.now() + 20);
      ctrl.arm();
      await app.drain({ leaseMillis: 500 });
      expect(attempts).toBe(1);

      // 80ms total: past the 50ms backoff, well under the 500ms lease. The
      // short backoff is honored — the released lease does not floor it up.
      // The wake may run it first; either way it runs exactly once more.
      vi.setSystemTime(Date.now() + 60);
      ctrl.arm();
      await app.drain({ leaseMillis: 500 });
      await vi.waitFor(() => expect(attempts).toBe(2));
    } finally {
      vi.useRealTimers();
    }
  });
});
