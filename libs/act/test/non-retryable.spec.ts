import { z } from "zod";
import {
  act,
  dispose,
  NonRetryableError,
  sleep,
  state,
  ZodEmpty,
} from "../src/index.js";

const counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ ticked: ZodEmpty })
  .patch({ ticked: () => ({}) })
  .on({ tick: ZodEmpty })
  .emit(() => ["ticked", {}])
  .build();

const actor = { id: "a", name: "a" };

describe("NonRetryableError (class)", () => {
  it("sets name and exposes cause", () => {
    const cause = new Error("inner");
    const err = new NonRetryableError("outer", { cause });
    expect(err.name).toBe("ERR_NON_RETRYABLE");
    expect(err.message).toBe("outer");
    expect(err.cause).toBe(cause);
  });

  it("cause is optional", () => {
    const err = new NonRetryableError("plain");
    expect(err.cause).toBeUndefined();
  });

  it("is detected via instanceof", () => {
    const err: Error = new NonRetryableError("x");
    expect(err instanceof NonRetryableError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });
});

describe("NonRetryableError (drain integration)", () => {
  afterEach(async () => {
    await dispose()();
  });

  it("blocks on first attempt when blockOnError is true (default)", async () => {
    let attempts = 0;
    const handler = vi.fn().mockImplementation(async () => {
      attempts++;
      throw new NonRetryableError("permanent input");
    });
    Object.defineProperty(handler, "name", { value: "permanentFailure" });

    const app = act()
      .withState(counter)
      .on("ticked")
      .do(handler, {
        maxRetries: 5,
        backoff: { strategy: "fixed", baseMs: 100 },
      })
      .build();

    await app.do("tick", { stream: "s1", actor }, {});
    await app.correlate();

    const drained = await app.drain({ leaseMillis: 1 });
    expect(attempts).toBe(1);
    expect(drained.blocked.length).toBe(1);
    expect(drained.blocked[0].error).toContain("permanent input");
  });

  it("ignores NonRetryableError when blockOnError is false", async () => {
    let attempts = 0;
    const handler = vi.fn().mockImplementation(async () => {
      attempts++;
      if (attempts < 3) throw new NonRetryableError("not blocking, keep going");
    });
    Object.defineProperty(handler, "name", { value: "neverBlocks" });

    const app = act()
      .withState(counter)
      .on("ticked")
      .do(handler, { maxRetries: 99, blockOnError: false })
      .build();

    await app.do("tick", { stream: "s2", actor }, {});
    await app.correlate();

    // First drain — first attempt throws NonRetryable, but blockOnError:false
    // means we keep retrying.
    await app.drain({ leaseMillis: 1 });
    expect(attempts).toBe(1);
    await sleep(5);
    await app.drain({ leaseMillis: 1 });
    expect(attempts).toBe(2);
    await sleep(5);
    const drained = await app.drain({ leaseMillis: 1 });
    expect(attempts).toBe(3);
    expect(drained.acked.length).toBe(1);
    expect(drained.blocked.length).toBe(0);
  });

  it("plain Error keeps consuming retry budget", async () => {
    let attempts = 0;
    const handler = vi.fn().mockImplementation(async () => {
      attempts++;
      throw new Error("transient");
    });
    Object.defineProperty(handler, "name", { value: "transientThrow" });

    const app = act()
      .withState(counter)
      .on("ticked")
      .do(handler, { maxRetries: 2 })
      .build();

    await app.do("tick", { stream: "s3", actor }, {});
    await app.correlate();

    // Plain Error → drain retries up to maxRetries; only blocks when
    // retry >= maxRetries. Three drains exhaust the budget.
    const r1 = await app.drain({ leaseMillis: 1 });
    expect(attempts).toBe(1);
    expect(r1.blocked.length).toBe(0);
    const r2 = await app.drain({ leaseMillis: 1 });
    expect(attempts).toBe(2);
    expect(r2.blocked.length).toBe(0);
    const r3 = await app.drain({ leaseMillis: 1 });
    expect(attempts).toBe(3);
    expect(r3.blocked.length).toBe(1);
  });

  it("blocks immediately even with backoff configured (no deferral)", async () => {
    let attempts = 0;
    const handler = vi.fn().mockImplementation(async () => {
      attempts++;
      throw new NonRetryableError("permanent");
    });
    Object.defineProperty(handler, "name", { value: "permanentWithBackoff" });

    const app = act()
      .withState(counter)
      .on("ticked")
      .do(handler, {
        maxRetries: 10,
        backoff: { strategy: "exponential", baseMs: 1_000, maxMs: 30_000 },
      })
      .build();

    await app.do("tick", { stream: "s4", actor }, {});
    await app.correlate();

    const drained = await app.drain({ leaseMillis: 1 });
    expect(attempts).toBe(1);
    expect(drained.blocked.length).toBe(1);

    // A second drain shortly after must not re-attempt — the stream is
    // already blocked, not deferred.
    await sleep(5);
    await app.drain({ leaseMillis: 1 });
    expect(attempts).toBe(1);
  });

  it("blocks in batch mode too", async () => {
    let calls = 0;
    const handler = vi.fn().mockImplementation(async () => {
      calls++;
      throw new NonRetryableError("batch boom");
    });
    Object.defineProperty(handler, "name", { value: "batchBoom" });

    const app = act()
      .withState(counter)
      .on("ticked")
      .do(handler, { maxRetries: 5 })
      .build();

    await app.do("tick", { stream: "s5", actor }, {});
    await app.correlate();

    const drained = await app.drain({ leaseMillis: 1 });
    expect(calls).toBe(1);
    expect(drained.blocked.length).toBe(1);
  });
});
