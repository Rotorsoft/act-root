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

  it("recovers via app.unblock without replaying history", async () => {
    let permanent = true;
    let attempts = 0;
    const handler = vi.fn().mockImplementation(async () => {
      attempts++;
      if (permanent) throw new NonRetryableError("fix me");
    });
    Object.defineProperty(handler, "name", { value: "fixable" });

    const app = act()
      .withState(counter)
      .on("ticked")
      .do(handler, { maxRetries: 5 })
      .build();

    await app.do("tick", { stream: "s6", actor }, {});
    await app.correlate();

    // First drain — fails permanently, stream blocks.
    const blockedRes = await app.drain({ leaseMillis: 1 });
    expect(attempts).toBe(1);
    expect(blockedRes.blocked.length).toBe(1);

    // Further drains don't re-attempt — stream is blocked.
    await app.drain({ leaseMillis: 1 });
    expect(attempts).toBe(1);

    // Operator fixes the underlying issue, then unblocks.
    permanent = false;
    const unblocked = await app.unblock(["s6"]);
    expect(unblocked).toBe(1);

    // Next drain re-attempts at the same event (no replay from zero).
    const okRes = await app.drain({ leaseMillis: 1 });
    expect(attempts).toBe(2);
    expect(okRes.acked.length).toBe(1);
  });

  it("app.unblock returns 0 when nothing was blocked", async () => {
    const app = act()
      .withState(counter)
      .on("ticked")
      .do(async function noop() {}, { maxRetries: 5 })
      .build();

    await app.do("tick", { stream: "s7", actor }, {});
    await app.correlate();
    await app.drain({ leaseMillis: 1 });

    expect(await app.unblock(["s7"])).toBe(0);
    expect(await app.unblock(["unknown-stream"])).toBe(0);
  });

  it("app.unblock accepts a StreamFilter for bulk recovery", async () => {
    let permanent = true;
    const handler = vi.fn().mockImplementation(async () => {
      if (permanent) throw new NonRetryableError("temp bug");
    });
    Object.defineProperty(handler, "name", { value: "filterRecovery" });

    const app = act()
      .withState(counter)
      .on("ticked")
      .do(handler, { maxRetries: 5 })
      .build();

    // Three streams in the same family all block on a shared bug.
    for (const stream of ["fam-a", "fam-b", "fam-c"]) {
      await app.do("tick", { stream, actor }, {});
    }
    await app.correlate();
    const blocked = await app.drain({ leaseMillis: 1 });
    expect(blocked.blocked.length).toBe(3);

    // Operator confirms the bug is fixed.
    permanent = false;

    // Bulk recovery via filter — unblock the whole family in one call.
    const unblocked = await app.unblock({ stream: "^fam-" });
    expect(unblocked).toBe(3);

    // Next drain succeeds for all three.
    const ok = await app.drain({ leaseMillis: 1 });
    expect(ok.acked.length).toBe(3);
    expect(ok.blocked.length).toBe(0);
  });

  it("app.blocked_streams returns currently-blocked positions", async () => {
    const handler = vi.fn().mockImplementation(async () => {
      throw new NonRetryableError("permanent");
    });
    Object.defineProperty(handler, "name", { value: "alwaysBad" });

    const app = act()
      .withState(counter)
      .on("ticked")
      .do(handler, { maxRetries: 5 })
      .build();

    // Nothing blocked yet.
    expect((await app.blocked_streams()).length).toBe(0);

    // Block two streams.
    for (const stream of ["bad-1", "bad-2"]) {
      await app.do("tick", { stream, actor }, {});
    }
    await app.correlate();
    await app.drain({ leaseMillis: 1 });

    const blocked = await app.blocked_streams();
    expect(blocked.length).toBe(2);
    expect(blocked.map((p) => p.stream).sort()).toEqual(["bad-1", "bad-2"]);
    // Each position carries the error string set at block time.
    expect(blocked[0].error).toContain("permanent");

    // After recovery, the list goes back to empty.
    await app.unblock({ stream: "^bad-" });
    expect((await app.blocked_streams()).length).toBe(0);
  });

  it("blocks in the SAME cycle after partial progress — ack must not drop the block (#1296)", async () => {
    // A batch that succeeds on the first event and throws NonRetryable on the
    // second finalizes with `handled > 0` AND `block: true`. Because `ack`
    // releases the lease that `block`'s WHERE clause requires, acking before
    // blocking used to silently drop the block: the watermark advanced past
    // the succeeded prefix but the stream stayed live and re-ran its
    // permanently-failed tail on the next cycle. `block` now runs first.
    let attempts = 0;
    let seen = 0;
    const handler = vi.fn().mockImplementation(async () => {
      seen++;
      // Second event in the batch is the permanent failure.
      if (seen >= 2) {
        attempts++;
        throw new NonRetryableError("permanent on the tail");
      }
    });
    Object.defineProperty(handler, "name", { value: "partialThenBlock" });

    const app = act()
      .withState(counter)
      .on("ticked")
      .do(handler, { maxRetries: 5 })
      .build();

    // Two events on ONE stream, fetched together in one drain cycle.
    await app.do("tick", { stream: "partial-1", actor }, {});
    await app.do("tick", { stream: "partial-1", actor }, {});
    await app.correlate();

    const drained = await app.drain({ leaseMillis: 1 });
    // Lands in BOTH: the watermark advanced past the succeeded prefix AND the
    // stream is blocked in the same cycle.
    expect(drained.acked.length).toBe(1);
    expect(drained.blocked.length).toBe(1);
    expect(drained.blocked[0].error).toContain("permanent on the tail");
    expect(attempts).toBe(1);

    // The stream is blocked, so a second drain never re-invokes the
    // permanently-failed handler on the tail event.
    const again = await app.drain({ leaseMillis: 1 });
    expect(again.blocked.length).toBe(0);
    expect(attempts).toBe(1);
    expect((await app.blocked_streams()).map((p) => p.stream)).toEqual([
      "partial-1",
    ]);
  });
});
