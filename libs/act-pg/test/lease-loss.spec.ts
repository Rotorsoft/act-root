/**
 * #1418 — a handler that fails only by overrunning its lease, driven
 * end-to-end against a real Postgres store.
 *
 * This is the scenario the fix is about, so it is reproduced rather than
 * simulated: two `Act` instances drain the same store as competing
 * consumers (the faithful production shape minus the process boundary,
 * same as `contention.spec.ts`), the first takes a lease it overruns, the
 * second steals it after real expiry, and every claim / ack / block below
 * is the adapter's own SQL. Nothing is mocked — `log()` is observed, not
 * replaced with a fixture.
 *
 * Ordering is deterministic despite the concurrency: the slow handler
 * parks on a promise the test resolves, so the steal cannot race the
 * dispatch. The only wall-clock dependency is lease expiry, given a 50x
 * margin over the 1ms lease.
 *
 * Requires Postgres on :5431, like every other act-pg spec.
 */

import { randomUUID } from "node:crypto";
import {
  act,
  dispose,
  log,
  sleep,
  state,
  store,
  ZodEmpty,
} from "@rotorsoft/act";
import { z } from "zod";
import { PostgresStore } from "../src/postgres-store.js";
import { schema } from "./schema.js";

const PG = {
  port: 5431,
  schema: schema("lease_loss_test"),
  table: "events",
} as const;
const actor = { id: "a", name: "a" };

const counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ ticked: ZodEmpty })
  .patch({ ticked: () => ({}) })
  .on({ tick: ZodEmpty })
  .emit(() => ["ticked", {}])
  .build();

/** A promise the test resolves by hand — the handler's parking brake. */
const latch = () => {
  let open!: () => void;
  const held = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { held, open };
};

describe("a handler that only ever loses its lease (#1418)", () => {
  beforeEach(async () => {
    store(new PostgresStore({ ...PG }));
    await store().drop();
    await store().seed();
  });

  afterEach(async () => {
    await dispose()("EXIT").catch(() => {});
  });

  /**
   * Build the two competing workers over the shared store. `slow` parks
   * inside its handler until the returned latch is opened; `fast` returns
   * immediately. Both react to the same event onto the same target
   * stream, so they compete for one lease.
   */
  const workers = (target: string, maxRetries: number, blockOnError = true) => {
    const entered = latch();
    const release = latch();
    let slow_attempts = 0;
    let fast_attempts = 0;

    const slow = act()
      .withState(counter)
      .on("ticked")
      .do(
        async function slowWorker() {
          slow_attempts++;
          entered.open();
          await release.held;
        },
        { maxRetries, blockOnError }
      )
      .to(target)
      .build();

    const fast = act()
      .withState(counter)
      .on("ticked")
      .do(
        async function fastWorker() {
          fast_attempts++;
        },
        { maxRetries, blockOnError }
      )
      .to(target)
      .build();

    return {
      slow,
      fast,
      entered,
      release,
      attempts: () => ({ slow: slow_attempts, fast: fast_attempts }),
    };
  };

  /** Read the live streams row the adapter maintains. */
  const row = async (stream: string) => {
    const rows: Array<{ at: number; retry: number; blocked: boolean }> = [];
    await store().query_streams((r) => rows.push(r), { stream });
    return rows[0]!;
  };

  it("blocks the stream once the budget is spent with no error raised", async () => {
    const target = `stuck-${randomUUID()}`;
    // maxRetries 0: the first claim (retry 0) is the one attempt allowed,
    // the second (retry 1) is past the budget.
    const w = workers(target, 0);
    // The dropped-ack report is `warn` (#1579) — that work is redelivered.
    // Blocking stays `error`: it needs `app.unblock` and never self-heals.
    const logged = vi.spyOn(log(), "warn");
    const errored = vi.spyOn(log(), "error");

    await w.slow.do("tick", { stream: `s-${randomUUID()}`, actor }, {});
    await w.slow.correlate();

    // The slow worker claims with a lease it will overrun, and parks.
    const inflight = w.slow.drain({ leaseMillis: 1 });
    await w.entered.held;
    expect((await row(target)).retry).toBe(0);

    // The lease lapses for real, then the competitor takes the stream.
    await sleep(50);
    await w.fast.correlate();
    const stolen = await w.fast.drain({ leaseMillis: 60_000 });

    // Terminal before dispatch — the second worker never runs the handler,
    // which is the unbounded side effect this stops.
    expect(w.attempts().fast).toBe(0);
    expect(stolen.blocked.length).toBe(1);
    expect(stolen.blocked[0].stream).toBe(target);
    expect(stolen.blocked[0].error).toContain("no acknowledged progress");
    expect(stolen.acked.length).toBe(0);

    const blocked_row = await row(target);
    expect(blocked_row.blocked).toBe(true);
    expect(blocked_row.at).toBe(-1); // nothing was ever acknowledged

    // The slow worker finally finishes; its ack is dropped by the
    // ownership guard and the drain reports the loss.
    w.release.open();
    await inflight;
    const drops = logged.mock.calls.filter((c) =>
      String(c[0]).includes("acks were dropped")
    );
    expect(drops.length).toBe(1);

    // The two severities are not interchangeable: the block is the part a
    // human must act on, so it stays at the level operators page on.
    expect(
      errored.mock.calls.filter((c) =>
        String(c[0]).includes("no acknowledged progress")
      ).length
    ).toBe(1);

    errored.mockRestore();
    logged.mockRestore();
    await w.slow.shutdown();
    await w.fast.shutdown();
  });

  it("reports the round of work the stolen lease discarded", async () => {
    const target = `dropped-${randomUUID()}`;
    // Budget left wide open so the claim-time guard stays out of the way
    // and the competitor actually runs and acks.
    const w = workers(target, 5);
    // `warn`, not `error` (#1579): the work is redelivered, so this occurrence
    // needs no operator action. Persistent drops are a sizing problem.
    const logged = vi.spyOn(log(), "warn");
    const errored = vi.spyOn(log(), "error");

    await w.slow.do("tick", { stream: `s-${randomUUID()}`, actor }, {});
    await w.slow.correlate();

    const inflight = w.slow.drain({ leaseMillis: 1 });
    await w.entered.held;
    await sleep(50);
    await w.fast.correlate();
    const stolen = await w.fast.drain({ leaseMillis: 60_000 });

    // The competitor did the work and advanced the watermark.
    expect(w.attempts().fast).toBe(1);
    expect(stolen.acked.length).toBe(1);

    // The original holder finishes without error, submits its ack, and the
    // adapter's `WHERE leased_by = by` guard silently rejects it. Before
    // #1418 that short return went unnoticed.
    w.release.open();
    const late = await inflight;
    expect(late.acked.length).toBe(0);

    const drops = logged.mock.calls.filter((c) =>
      String(c[0]).includes("acks were dropped")
    );
    expect(drops.length).toBe(1);

    // Budget wide open here, so nothing blocks — and with nothing to act on,
    // nothing may reach `error`.
    expect(errored).not.toHaveBeenCalled();

    errored.mockRestore();
    logged.mockRestore();
    await w.slow.shutdown();
    await w.fast.shutdown();
  });

  it("control — a claim at exactly maxRetries still gets its attempt", async () => {
    const target = `final-${randomUUID()}`;
    // maxRetries 1: the stolen claim arrives at retry 1, which is the
    // budget, not past it. It must run.
    const w = workers(target, 1);

    await w.slow.do("tick", { stream: `s-${randomUUID()}`, actor }, {});
    await w.slow.correlate();

    const inflight = w.slow.drain({ leaseMillis: 1 });
    await w.entered.held;
    await sleep(50);
    await w.fast.correlate();
    const stolen = await w.fast.drain({ leaseMillis: 60_000 });

    expect(w.attempts().fast).toBe(1);
    expect(stolen.blocked.length).toBe(0);
    expect(stolen.acked.length).toBe(1);
    expect((await row(target)).blocked).toBe(false);

    w.release.open();
    await inflight;
    await w.slow.shutdown();
    await w.fast.shutdown();
  });

  it("control — blockOnError:false still means retry forever", async () => {
    const target = `forever-${randomUUID()}`;
    const w = workers(target, 0, false);

    await w.slow.do("tick", { stream: `s-${randomUUID()}`, actor }, {});
    await w.slow.correlate();

    const inflight = w.slow.drain({ leaseMillis: 1 });
    await w.entered.held;
    await sleep(50);
    await w.fast.correlate();
    const stolen = await w.fast.drain({ leaseMillis: 60_000 });

    expect(w.attempts().fast).toBe(1);
    expect(stolen.blocked.length).toBe(0);
    expect((await row(target)).blocked).toBe(false);

    w.release.open();
    await inflight;
    await w.slow.shutdown();
    await w.fast.shutdown();
  });
});
