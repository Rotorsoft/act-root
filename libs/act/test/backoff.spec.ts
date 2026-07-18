import { z } from "zod";
import { act, dispose, sleep, state, store, ZodEmpty } from "../src/index.js";
import { compute_backoff_delay } from "../src/internal/backoff.js";
import { resolveBackoffConfig } from "../src/internal/config.js";
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

  it("throws on an off-union strategy instead of returning NaN (#1269)", () => {
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

describe("resolveBackoffConfig (#1269)", () => {
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

describe("backoff config is validated at build (#1269)", () => {
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
      .build();

    await app.do("tick", { stream: "s1", actor }, {});
    await app.correlate();

    // First attempt fails — controller now defers
    await app.drain({ leaseMillis: 1 });
    expect(attempts).toBe(1);

    // Immediate next drain: stream is in backoff, handler must not run
    await app.drain({ leaseMillis: 1 });
    expect(attempts).toBe(1);

    // Still inside window
    await sleep(50);
    await app.drain({ leaseMillis: 1 });
    expect(attempts).toBe(1);

    // After window — handler can run again
    await sleep(200);
    await app.drain({ leaseMillis: 1 });
    expect(attempts).toBe(2);
  });

  it("advances the watermark past the succeeded prefix AND persists the window on partial progress (#1278)", async () => {
    // Two `ticked` events land on one stream for a single backoff reaction.
    // The handler succeeds on the first event and throws on the second —
    // partial progress (handled > 0 AND error AND next_attempt_at set). The
    // finalize must (a) advance the watermark to the FIRST event (so the
    // handled prefix never re-runs on redelivery) AND (b) ride a `due` marker
    // so the durable, cross-worker backoff window from #1262 is persisted with
    // the climbing retry. Advance and defer are independent ack legs (#1278).
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
      .build();

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

    await app.drain({ leaseMillis: 1 });

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
      .build();

    await app.do("tick", { stream: "s2", actor }, {});
    await app.correlate();

    await app.drain({ leaseMillis: 1 });
    expect(attempts).toBe(1);

    await sleep(60);
    const drained = await app.drain({ leaseMillis: 1 });
    expect(attempts).toBe(2);
    expect(drained.acked.length).toBe(1);
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
      .build();

    await app.do("tick", { stream: "s3", actor }, {});
    await app.correlate();

    await app.drain({ leaseMillis: 1 });
    expect(attempts).toBe(1);

    await sleep(15);
    const drained = await app.drain({ leaseMillis: 1 });
    // retry=1, maxRetries=1 → block
    expect(attempts).toBe(2);
    expect(drained.blocked.length).toBe(1);
  });

  it("garbage-collects only entries whose window has elapsed", async () => {
    // Two streams enter backoff on the same drain cycle. The fixed 50ms
    // window means both expire ~50ms after their failure. We schedule
    // them ~30ms apart so when the timer fires for the first, the second
    // is still ~30ms from ready — exercising the "keep" branch of the
    // callback's per-entry check.
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
      .build();

    // Commit + correlate + drain "early" — backoff entry set at T+50.
    await app.do("tick", { stream: "early", actor }, {});
    await app.correlate();
    await app.drain({ leaseMillis: 1 });
    expect(attempts.early).toBe(1);

    // Commit + correlate + drain "late" 30ms later — entry set at T'+50.
    // Both entries are now in the map; the earliest timer reschedules.
    await sleep(30);
    await app.do("tick", { stream: "late", actor }, {});
    await app.correlate();
    await app.drain({ leaseMillis: 1 });
    expect(attempts.late).toBe(1);

    // ~25ms more lets `early`'s timer fire (~55ms total from its
    // failure) while `late` is only ~25ms in. The callback iterates the
    // map and must delete `early` but keep `late`.
    await sleep(25);
    await app.drain({ leaseMillis: 1 });
    expect(attempts.early).toBe(2);
    expect(attempts.late).toBe(1);
  });

  it("backoff window is honored precisely via persisted deferred_at, not the lease duration (#1262)", async () => {
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
      .build();

    // A real worker/commit keeps the controller armed; once a drain claims
    // nothing (the stream is deferred) it self-disarms, so we re-arm before
    // each probe to isolate the backoff gate from the arm flag.
    const ctrl = (
      app as unknown as {
        _drain_controllers: Map<string, { arm: () => void }>;
      }
    )._drain_controllers.get("default")!;

    await app.do("tick", { stream: "floor", actor }, {});
    await app.correlate();

    // First attempt fails — the stream is deferred for 50ms and the 500ms
    // lease is released (the due-ack persists the schedule and frees it).
    await app.drain({ leaseMillis: 500 });
    expect(attempts).toBe(1);

    // 20ms later: still inside the 50ms backoff window → deferred_at excludes
    // it from claim, so no re-attempt and no phantom retry bump.
    await sleep(20);
    ctrl.arm();
    await app.drain({ leaseMillis: 500 });
    expect(attempts).toBe(1);

    // 80ms total: past the 50ms backoff, well under the 500ms lease. The
    // short backoff is honored — the released lease does not floor it up.
    await sleep(60);
    ctrl.arm();
    await app.drain({ leaseMillis: 500 });
    expect(attempts).toBe(2);
  });

  it("default (no backoff) preserves current rapid-retry behavior", async () => {
    let attempts = 0;
    const handler = vi.fn().mockImplementation(async () => {
      attempts++;
      throw new Error("transient");
    });
    Object.defineProperty(handler, "name", { value: "noBackoff" });

    const app = act()
      .withState(counter)
      .on("ticked")
      .do(handler, { maxRetries: 2 })
      .build();

    await app.do("tick", { stream: "s4", actor }, {});
    await app.correlate();

    // Three drain calls back-to-back with no sleep — without backoff,
    // each lease (leaseMillis: 1) expires immediately and re-attempts.
    await app.drain({ leaseMillis: 1 });
    await sleep(5);
    await app.drain({ leaseMillis: 1 });
    await sleep(5);
    await app.drain({ leaseMillis: 1 });
    expect(attempts).toBe(3);
  });
});
