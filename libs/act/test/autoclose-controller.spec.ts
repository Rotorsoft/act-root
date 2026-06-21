/**
 * Slice 3 of the online close-the-books foundation (#837 / epic #802).
 * Covers the app-level controller: zero-cost when no state declared
 * `.autocloses(...)`, lifecycle wiring via `start_correlations()` /
 * `stop_correlations()`, single-instance reentrancy guard, `closed`
 * lifecycle-event emission per truncating tick, idempotent
 * start/stop, and per-tick correlation stamping.
 *
 * Slice 4 brings TCK + adapter coverage + docs.
 */
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { act, cache, dispose, state, store, ZodEmpty } from "../src/index.js";

const Ticket = state({ Ticket: z.object({ open: z.boolean() }) })
  .init(() => ({ open: false }))
  .emits({
    TicketOpened: z.object({ title: z.string() }),
    TicketResolved: ZodEmpty,
  })
  .patch({
    TicketOpened: () => ({ open: true }),
    TicketResolved: () => ({ open: false }),
  })
  .on({ OpenTicket: z.object({ title: z.string() }) })
  .emit((a) => ["TicketOpened", { title: a.title }])
  .on({ ResolveTicket: ZodEmpty })
  .emit(() => ["TicketResolved", {}])
  .autocloses((_stream, head) => head.name === "TicketResolved")
  .build();

const Inert = state({ Inert: z.object({ on: z.boolean() }) })
  .init(() => ({ on: false }))
  .emits({ Toggled: ZodEmpty })
  .patch({ Toggled: () => ({ on: true }) })
  .on({ Toggle: ZodEmpty })
  .emit(() => ["Toggled", {}])
  .build();

const actor = { id: "test", name: "test" };

function controller_of(app: unknown) {
  return (
    app as {
      _autoclose: {
        run_once: () => Promise<unknown>;
        start: () => boolean;
        stop: () => void;
        is_running: boolean;
        deps: { config: { autocloseCycleMs: number } };
      };
    }
  )._autoclose;
}

describe("AutocloseController — slice 3", () => {
  beforeEach(async () => {
    await store().drop();
    await cache().clear();
  });

  afterAll(async () => {
    await dispose()();
  });

  test("never constructed when no state declares `.autocloses(...)`", () => {
    const app = act().withState(Inert).build();
    expect(
      (app as unknown as { _autoclose: unknown })._autoclose
    ).toBeUndefined();
  });

  test("constructed when at least one state declares `.autocloses(...)`", () => {
    const app = act().withState(Ticket).withState(Inert).build();
    expect(
      (app as unknown as { _autoclose: unknown })._autoclose
    ).toBeDefined();
  });

  test("`start_correlations()` starts the autoclose ticker", () => {
    const app = act().withState(Ticket).build();
    const c = controller_of(app);
    expect(c.is_running).toBe(false);
    app.start_correlations();
    expect(c.is_running).toBe(true);
    app.stop_correlations();
  });

  test("`stop_correlations()` stops the autoclose ticker", () => {
    const app = act().withState(Ticket).build();
    const c = controller_of(app);
    app.start_correlations();
    expect(c.is_running).toBe(true);
    app.stop_correlations();
    expect(c.is_running).toBe(false);
  });

  test("start is idempotent — second start returns false without stacking timers", () => {
    const app = act().withState(Ticket).build();
    const c = controller_of(app);
    expect(c.start()).toBe(true);
    expect(c.start()).toBe(false);
    c.stop();
  });

  test("stop is idempotent — second stop is a no-op", () => {
    const app = act().withState(Ticket).build();
    const c = controller_of(app);
    c.start();
    c.stop();
    c.stop();
    expect(c.is_running).toBe(false);
  });

  test("`start_correlations` / `stop_correlations` are no-ops on apps without autoclose policy", () => {
    const app = act().withState(Inert).build();
    // No `_autoclose` controller — these calls must not throw.
    app.start_correlations();
    app.stop_correlations();
  });

  test("a tick that finds eligible streams emits the `closed` lifecycle event", async () => {
    const app = act().withState(Ticket).build();
    const closed_events: unknown[] = [];
    app.on("closed", (result) => closed_events.push(result));

    await app.do("OpenTicket", { stream: "t-1", actor }, { title: "a" });
    await app.do("ResolveTicket", { stream: "t-1", actor }, {});

    const c = controller_of(app);
    const result = await c.run_once();

    expect(result).not.toBeNull();
    expect(closed_events).toHaveLength(1);
    const close_result = closed_events[0] as {
      truncated: Map<string, unknown>;
    };
    expect(close_result.truncated.has("t-1")).toBe(true);
  });

  test("a tick that closes nothing skips the `closed` emission", async () => {
    const app = act().withState(Ticket).build();
    const closed_events: unknown[] = [];
    app.on("closed", (r) => closed_events.push(r));

    await app.do("OpenTicket", { stream: "t-1", actor }, { title: "a" });
    // No `Resolve` — predicate returns false.

    const c = controller_of(app);
    await c.run_once();

    expect(closed_events).toHaveLength(0);
  });

  test("reentrancy guard: overlapping `run_once` drops the second call", async () => {
    const app = act().withState(Ticket).build();
    const c = controller_of(app);

    // First call runs; second concurrent call short-circuits to null.
    const p1 = c.run_once();
    const p2 = c.run_once();

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).not.toBeNull();
    expect(r2).toBeNull();
  });

  test("ticker cycle errors are swallowed and logged via the breaker", async () => {
    const app = act().withState(Ticket).build();
    const c = controller_of(app);

    // Force the cycle to throw by stubbing query_stats.
    const original = store().query_stats.bind(store());
    (store() as unknown as { query_stats: typeof original }).query_stats =
      async () => {
        throw new Error("boom");
      };
    const logger_error = vi
      .spyOn(
        (app as unknown as { _logger: { error: (m: string) => void } })._logger,
        "error"
      )
      .mockImplementation(() => undefined);

    try {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      c.start();
      vi.advanceTimersByTime(c.deps.config.autocloseCycleMs + 100);
      // Wait for the fire-and-forget tick to settle.
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
      c.stop();
      expect(logger_error).toHaveBeenCalled();
    } finally {
      logger_error.mockRestore();
      (store() as unknown as { query_stats: typeof original }).query_stats =
        original;
    }
  });

  test("non-Error throws from the ticker reach the breaker's logging", async () => {
    const app = act().withState(Ticket).build();
    const c = controller_of(app);

    const original = store().query_stats.bind(store());
    (store() as unknown as { query_stats: typeof original }).query_stats =
      async () => {
        throw "raw-string-throw";
      };
    const logger_error = vi
      .spyOn(
        (app as unknown as { _logger: { error: (m: string) => void } })._logger,
        "error"
      )
      .mockImplementation(() => undefined);

    try {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      c.start();
      vi.advanceTimersByTime(c.deps.config.autocloseCycleMs + 100);
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
      c.stop();
      expect(logger_error).toHaveBeenCalledWith(
        expect.stringContaining("raw-string-throw")
      );
    } finally {
      logger_error.mockRestore();
      (store() as unknown as { query_stats: typeof original }).query_stats =
        original;
    }
  });

  test("`shutdown()` stops the autoclose ticker", async () => {
    const app = act().withState(Ticket).build();
    const c = controller_of(app);
    app.start_correlations();
    expect(c.is_running).toBe(true);
    await app.shutdown();
    expect(c.is_running).toBe(false);
  });

  // ACT-984: the autoclose ticker is a periodic store poller and shares the
  // orchestrator circuit breaker with the drain loop.
  test("skips the tick while the circuit breaker is open", async () => {
    const app = act()
      .withState(Ticket)
      .build({ circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000 } });
    const c = controller_of(app);
    const query_stats = vi.spyOn(store(), "query_stats");
    // Open the shared breaker (threshold 1).
    (
      app as unknown as { _breaker: { failed: (n: number) => void } }
    )._breaker.failed(Date.now());
    const result = await c.run_once();
    expect(result).toBeNull(); // skipped — store not touched
    expect(query_stats).not.toHaveBeenCalled();
    query_stats.mockRestore();
  });

  test("records a store failure on the breaker and emits `error`", async () => {
    const app = act()
      .withState(Ticket)
      .build({ circuitBreaker: { failureThreshold: 2, cooldownMs: 60_000 } });
    const c = controller_of(app);
    const errors: { error: unknown; circuit: string }[] = [];
    app.on("error", (e) => errors.push(e));
    const original = store().query_stats.bind(store());
    (store() as unknown as { query_stats: unknown }).query_stats = () =>
      Promise.reject(new Error("stats down"));
    try {
      await c.run_once().catch(() => {});
      expect(errors).toHaveLength(1);
      expect(errors[0].circuit).toBe("closed"); // 1 failure < threshold 2
    } finally {
      (store() as unknown as { query_stats: typeof original }).query_stats =
        original;
    }
  });
});
