import { z } from "zod";
import { act, dispose, sleep, state, ZodEmpty } from "../src/index.js";
import { compute_backoff_delay } from "../src/internal/backoff.js";
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

  it("defers retry until backoff window elapses (per-worker)", async () => {
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
