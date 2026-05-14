import { z } from "zod";
import { act, dispose, sleep, state, ZodEmpty } from "../src/index.js";
import { computeBackoffDelay } from "../src/internal/backoff.js";
import type { BackoffOptions } from "../src/types/index.js";

describe("computeBackoffDelay", () => {
  it("returns 0 when opts is undefined", () => {
    expect(computeBackoffDelay(0, undefined)).toBe(0);
    expect(computeBackoffDelay(5, undefined)).toBe(0);
  });

  it("returns 0 when baseMs is non-positive", () => {
    expect(computeBackoffDelay(3, { strategy: "fixed", baseMs: 0 })).toBe(0);
    expect(computeBackoffDelay(3, { strategy: "fixed", baseMs: -10 })).toBe(0);
  });

  it("fixed: returns baseMs regardless of retry", () => {
    const opts: BackoffOptions = { strategy: "fixed", baseMs: 100 };
    expect(computeBackoffDelay(0, opts)).toBe(100);
    expect(computeBackoffDelay(3, opts)).toBe(100);
    expect(computeBackoffDelay(99, opts)).toBe(100);
  });

  it("linear: scales by (retry + 1)", () => {
    const opts: BackoffOptions = { strategy: "linear", baseMs: 50 };
    expect(computeBackoffDelay(0, opts)).toBe(50);
    expect(computeBackoffDelay(1, opts)).toBe(100);
    expect(computeBackoffDelay(4, opts)).toBe(250);
  });

  it("exponential: doubles per retry", () => {
    const opts: BackoffOptions = { strategy: "exponential", baseMs: 100 };
    expect(computeBackoffDelay(0, opts)).toBe(100);
    expect(computeBackoffDelay(1, opts)).toBe(200);
    expect(computeBackoffDelay(3, opts)).toBe(800);
  });

  it("exponential: clamps to maxMs when provided", () => {
    const opts: BackoffOptions = {
      strategy: "exponential",
      baseMs: 100,
      maxMs: 500,
    };
    expect(computeBackoffDelay(3, opts)).toBe(500); // 800 → 500
    expect(computeBackoffDelay(10, opts)).toBe(500);
  });

  it("jitter: keeps delay in [floor(0.5 * d), d) bounds", () => {
    const opts: BackoffOptions = {
      strategy: "fixed",
      baseMs: 1000,
      jitter: true,
    };
    for (let i = 0; i < 100; i++) {
      const d = computeBackoffDelay(0, opts);
      expect(d).toBeGreaterThanOrEqual(500);
      expect(d).toBeLessThan(1500);
    }
  });

  it("clamps negative retry to 0", () => {
    const opts: BackoffOptions = { strategy: "exponential", baseMs: 100 };
    expect(computeBackoffDelay(-1, opts)).toBe(100);
    expect(computeBackoffDelay(-99, opts)).toBe(100);
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
