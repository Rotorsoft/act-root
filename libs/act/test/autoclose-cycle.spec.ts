/**
 * Slice 2 of the online close-the-books foundation (#837 / epic #802).
 * Covers the pure cycle function (`run_autoclose_cycle`) against the
 * `InMemoryStore`: per-state iteration, predicate-eligible streams
 * close within the tick, predicate-ineligible streams are never
 * touched, per-state isolation, archive-while-guarded composition,
 * predicate-error handling under both `closeOnError` modes, and
 * pagination across multiple batches.
 *
 * Slice 3 wires the controller (cadence + lifecycle); slice 4 adds
 * the TCK + adapter coverage. This file proves the function shape.
 */
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import {
  act,
  cache,
  dispose,
  resolveAutocloseConfig,
  state,
  store,
  ZodEmpty,
} from "../src/index.js";
import { run_autoclose_cycle } from "../src/internal/autoclose-cycle.js";

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

// Sibling state with no autoclose policy — proves per-state isolation:
// the cycle never touches `Order` streams even if their head matches a
// `Ticket` predicate's truth condition.
const Order = state({ Order: z.object({ done: z.boolean() }) })
  .init(() => ({ done: false }))
  .emits({ OrderPlaced: ZodEmpty, OrderShipped: ZodEmpty })
  .patch({
    OrderPlaced: () => ({ done: false }),
    OrderShipped: () => ({ done: true }),
  })
  .on({ PlaceOrder: ZodEmpty })
  .emit(() => ["OrderPlaced", {}])
  .on({ ShipOrder: ZodEmpty })
  .emit(() => ["OrderShipped", {}])
  .build();

const actor = { id: "test", name: "test" };

function build_app() {
  return act().withState(Ticket).withState(Order).build();
}

function build_app_with_archive(
  archiver: (stream: string, head: { name: string }) => Promise<void>
) {
  const TicketWithArchive = state({ Ticket: z.object({ open: z.boolean() }) })
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
    .archives(archiver)
    .build();
  return act().withState(TicketWithArchive).build();
}

/**
 * Internal cycle invocation. The Act instance owns
 * `event_to_state` / `EsOps` / the logger via private fields;
 * slice 3 wires the controller. For slice 2's tests we reach in
 * deliberately and assemble the deps bag ourselves so the cycle
 * is exercised in isolation, without spinning the controller.
 */
function run_cycle(
  app: unknown,
  config_overrides?: Parameters<typeof resolveAutocloseConfig>[0]
) {
  // The Act instance owns several private fields the cycle reads
  // (`_event_to_state`, `_es`, `_logger`, `_reactive_events`); the
  // controller in slice 3 wires them. Reach in via an `unknown` →
  // `Record` cast so the test stays decoupled from the concrete
  // generic shape across the different Act flavors built per case.
  const a = app as Record<string, unknown> & {
    registry: {
      autoclose_policy: never;
      autoclose_archiver: never;
    };
  };
  const reactive = a._reactive_events as { size: number };
  const es = a._es as Record<string, never>;
  return run_autoclose_cycle({
    autoclose_policy: a.registry.autoclose_policy,
    autoclose_archiver: a.registry.autoclose_archiver,
    event_to_state: a._event_to_state as never,
    reactive_events_size: reactive.size,
    load: es.load,
    tombstone: es.tombstone,
    logger: a._logger as never,
    config: resolveAutocloseConfig(config_overrides),
    correlation: "autoclose-test-cycle",
  });
}

describe("run_autoclose_cycle — slice 2", () => {
  beforeEach(async () => {
    await store().drop();
    await cache().clear();
  });

  afterAll(async () => {
    await dispose()();
  });

  test("closes streams whose head matches the predicate", async () => {
    const app = build_app();
    await app.do("OpenTicket", { stream: "t-1", actor }, { title: "a" });
    await app.do("ResolveTicket", { stream: "t-1", actor }, {});

    const result = await run_cycle(app);

    expect(result.inspected).toBeGreaterThanOrEqual(1);
    expect(result.evaluated).toBe(1);
    expect(result.predicate_errors).toBe(0);
    expect(result.close_result.truncated.has("t-1")).toBe(true);
  });

  test("leaves streams whose head doesn't match the predicate intact", async () => {
    const app = build_app();
    await app.do("OpenTicket", { stream: "t-1", actor }, { title: "a" });
    // No resolve — head is `TicketOpened`, predicate returns false.

    const result = await run_cycle(app);

    expect(result.evaluated).toBe(1);
    expect(result.close_result.truncated.size).toBe(0);
  });

  test("per-state isolation: never touches streams owned by states without `.autocloses(...)`", async () => {
    const app = build_app();
    // Both streams committed; only Ticket has an autoclose policy.
    await app.do("OpenTicket", { stream: "t-1", actor }, { title: "a" });
    await app.do("ResolveTicket", { stream: "t-1", actor }, {});
    await app.do("PlaceOrder", { stream: "o-1", actor }, {});
    await app.do("ShipOrder", { stream: "o-1", actor }, {});

    const result = await run_cycle(app);

    expect(result.close_result.truncated.has("t-1")).toBe(true);
    expect(result.close_result.truncated.has("o-1")).toBe(false);
    // `o-1` was paginated through (`inspected` counts it) but
    // `evaluated` only counts streams whose owning state has a
    // policy — Order doesn't.
    expect(result.evaluated).toBe(1);
  });

  test("runs the archiver before truncate when `.archives(fn)` is declared", async () => {
    const calls: Array<[string, { name: string }]> = [];
    const archiver = async (stream: string, head: { name: string }) => {
      calls.push([stream, head]);
    };
    const app = build_app_with_archive(archiver);
    await app.do("OpenTicket", { stream: "t-1", actor }, { title: "a" });
    await app.do("ResolveTicket", { stream: "t-1", actor }, {});

    const result = await run_cycle(app);

    expect(result.close_result.truncated.has("t-1")).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("t-1");
    expect(calls[0][1].name).toBe("TicketResolved");
  });

  test("archiver throw leaves the stream guarded but un-truncated (no data loss)", async () => {
    const archiver = async () => {
      throw new Error("archive failed");
    };
    const app = build_app_with_archive(archiver);
    await app.do("OpenTicket", { stream: "t-1", actor }, { title: "a" });
    await app.do("ResolveTicket", { stream: "t-1", actor }, {});

    // The existing close-cycle propagates archiver throws; the
    // autoclose cycle inherits that.
    await expect(run_cycle(app)).rejects.toThrow(/archive failed/);

    // Stream still has its events — no partial truncate.
    const events: string[] = [];
    await store().query((e) => {
      events.push(String(e.name));
    });
    expect(events.includes("TicketResolved")).toBe(true);
  });

  test("predicate exceptions are caught + logged; default `closeOnError=false` skips the stream", async () => {
    const ThrowingTicket = state({
      ThrowingTicket: z.object({ open: z.boolean() }),
    })
      .init(() => ({ open: false }))
      .emits({
        ThrowingTicketOpened: ZodEmpty,
        ThrowingTicketResolved: ZodEmpty,
      })
      .patch({
        ThrowingTicketOpened: () => ({ open: true }),
        ThrowingTicketResolved: () => ({ open: false }),
      })
      .on({ OpenThrowingTicket: ZodEmpty })
      .emit(() => ["ThrowingTicketOpened", {}])
      .on({ ResolveThrowingTicket: ZodEmpty })
      .emit(() => ["ThrowingTicketResolved", {}])
      .autocloses(() => {
        throw new Error("predicate boom");
      })
      .build();
    const app = act().withState(ThrowingTicket).build();
    await app.do("OpenThrowingTicket", { stream: "x-1", actor }, {});
    await app.do("ResolveThrowingTicket", { stream: "x-1", actor }, {});

    const result = await run_cycle(app);

    expect(result.predicate_errors).toBe(1);
    expect(result.close_result.truncated.has("x-1")).toBe(false);
  });

  test("`closeOnError=true` truncates streams whose predicate threw", async () => {
    const ThrowingTicket = state({
      ThrowingTicket: z.object({ open: z.boolean() }),
    })
      .init(() => ({ open: false }))
      .emits({
        ThrowingTicketOpened: ZodEmpty,
        ThrowingTicketResolved: ZodEmpty,
      })
      .patch({
        ThrowingTicketOpened: () => ({ open: true }),
        ThrowingTicketResolved: () => ({ open: false }),
      })
      .on({ OpenThrowingTicket: ZodEmpty })
      .emit(() => ["ThrowingTicketOpened", {}])
      .on({ ResolveThrowingTicket: ZodEmpty })
      .emit(() => ["ThrowingTicketResolved", {}])
      .autocloses(() => {
        throw new Error("predicate boom");
      })
      .build();
    const app = act().withState(ThrowingTicket).build();
    await app.do("OpenThrowingTicket", { stream: "y-1", actor }, {});

    const internals = app as unknown as {
      _event_to_state: Map<string, unknown>;
      _es: { load: unknown; tombstone: unknown };
      _logger: never;
      _reactive_events: ReadonlySet<string>;
    };
    const result = await run_autoclose_cycle({
      autoclose_policy: app.registry.autoclose_policy as never,
      autoclose_archiver: app.registry.autoclose_archiver as never,
      event_to_state: internals._event_to_state as never,
      reactive_events_size: internals._reactive_events.size,
      load: internals._es.load as never,
      tombstone: internals._es.tombstone as never,
      logger: internals._logger,
      config: resolveAutocloseConfig({ closeOnError: true }),
      correlation: "autoclose-test-cycle-closeOnError",
    });

    expect(result.predicate_errors).toBe(1);
    expect(result.close_result.truncated.has("y-1")).toBe(true);
  });

  test("one run drains the whole store, paging in `closeBatchSize` batches", async () => {
    const app = build_app();
    // Five resolvable streams; closeBatchSize = 2 means the run pages
    // through them two at a time. A single run closes all five (it loops
    // pages internally until a short page ends the sweep).
    for (let i = 0; i < 5; i++) {
      await app.do("OpenTicket", { stream: `t-${i}`, actor }, { title: "a" });
      await app.do("ResolveTicket", { stream: `t-${i}`, actor }, {});
    }

    const result = await run_cycle(app, { closeBatchSize: 2 });

    expect(result.inspected).toBe(5);
    expect(result.close_result.truncated.size).toBe(5);
  });

  test("yields after a batch when `closeYieldMs > 0`", async () => {
    const app = build_app();
    await app.do("OpenTicket", { stream: "t-1", actor }, { title: "a" });
    await app.do("ResolveTicket", { stream: "t-1", actor }, {});

    const internals = app as unknown as {
      _event_to_state: Map<string, unknown>;
      _es: { load: unknown; tombstone: unknown };
      _logger: never;
      _reactive_events: ReadonlySet<string>;
    };
    const t0 = Date.now();
    const result = await run_autoclose_cycle({
      autoclose_policy: app.registry.autoclose_policy as never,
      autoclose_archiver: app.registry.autoclose_archiver as never,
      event_to_state: internals._event_to_state as never,
      reactive_events_size: internals._reactive_events.size,
      load: internals._es.load as never,
      tombstone: internals._es.tombstone as never,
      logger: internals._logger,
      config: resolveAutocloseConfig({ closeYieldMs: 50 }),
      correlation: "autoclose-test-cycle-yield",
    });
    const elapsed = Date.now() - t0;

    expect(result.close_result.truncated.size).toBe(1);
    // The post-batch yield (ms > 0) ran.
    expect(elapsed).toBeGreaterThanOrEqual(50);
  });

  test("forwards `skipped` streams from the underlying close cycle", async () => {
    // Streams with pending reactions in flight are skipped by
    // `run_close_cycle`'s safety partition. The autoclose cycle
    // forwards those names so the operator's observability sidecar
    // can react. Trigger this by committing events without draining
    // — `result.skipped` ends up non-empty.
    const TicketWithReaction = state({
      Ticket: z.object({ open: z.boolean() }),
    })
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
    const app = act()
      .withState(TicketWithReaction)
      .on("TicketResolved")
      .do(async function on_resolved() {
        // Reaction handler — never drained, so the close-cycle's
        // safety partition skips streams with this reaction
        // pending.
      })
      .to("ticket-followups")
      .build();
    await app.do("OpenTicket", { stream: "t-1", actor }, { title: "a" });
    await app.do("ResolveTicket", { stream: "t-1", actor }, {});
    // Correlate so the subscription exists; **do not** drain — the
    // subscription's watermark stays behind the stream's head, so
    // the safety partition flags the stream as "pending reactions
    // in flight" and skips it.
    await app.correlate();

    const result = await run_cycle(app);

    expect(result.close_result.skipped).toContain("t-1");
    expect(result.close_result.truncated.has("t-1")).toBe(false);
  });

  test("empty store returns the no-op result", async () => {
    const app = build_app();
    const result = await run_cycle(app);
    expect(result.inspected).toBe(0);
    expect(result.evaluated).toBe(0);
    expect(result.predicate_errors).toBe(0);
    expect(result.close_result.truncated.size).toBe(0);
  });

  test("falls back to count=0 when the store omits the count field", async () => {
    // Defensive fallback for adapters / stubs that return
    // `StreamStats` without `count` even when asked. The cycle always
    // requests `count: true`, so this stubs `query_stats` to omit
    // `count` and verifies the cycle still threads a value (0) into the
    // predicate without throwing.
    let observed_count: number | undefined;
    const PassThrough = state({ Passthrough: z.object({ open: z.boolean() }) })
      .init(() => ({ open: false }))
      .emits({ Marked: ZodEmpty })
      .patch({ Marked: () => ({ open: true }) })
      .on({ Mark: ZodEmpty })
      .emit(() => ["Marked", {}])
      .autocloses((_stream, _head, count) => {
        observed_count = count;
        return false;
      })
      .build();
    const app = act().withState(PassThrough).build();
    await app.do("Mark", { stream: "p-1", actor }, {});

    const original = store().query_stats.bind(store());
    // Strip `count` from each entry before returning.
    type Stats = Awaited<ReturnType<typeof original>>;
    (store() as unknown as { query_stats: typeof original }).query_stats =
      (async (...args: Parameters<typeof original>) => {
        const stats = (await original(...args)) as Stats;
        const stripped = new Map();
        for (const [k, v] of stats) {
          const { count: _count, ...rest } = v as { count?: number };
          stripped.set(k, rest);
        }
        return stripped;
      }) as typeof original;

    try {
      await run_cycle(app);
      expect(observed_count).toBe(0);
    } finally {
      (store() as unknown as { query_stats: typeof original }).query_stats =
        original;
    }
  });

  test("non-Error predicate throws are still caught + counted", async () => {
    const StringThrower = state({
      StringThrower: z.object({ open: z.boolean() }),
    })
      .init(() => ({ open: false }))
      .emits({ Opened: ZodEmpty, Closed: ZodEmpty })
      .patch({
        Opened: () => ({ open: true }),
        Closed: () => ({ open: false }),
      })
      .on({ OpenIt: ZodEmpty })
      .emit(() => ["Opened", {}])
      .on({ CloseIt: ZodEmpty })
      .emit(() => ["Closed", {}])
      .autocloses(() => {
        // Throwing a bare string is a JS-runtime footgun the cycle's
        // catch block has to tolerate — `err instanceof Error` is
        // false, but the log message + accounting should still fire.
        throw "raw string thrown";
      })
      .build();
    const app = act().withState(StringThrower).build();
    await app.do("OpenIt", { stream: "s-1", actor }, {});

    const result = await run_cycle(app);

    expect(result.predicate_errors).toBe(1);
    expect(result.close_result.truncated.has("s-1")).toBe(false);
  });

  test("streams whose head event has no owning state are skipped", async () => {
    const app = build_app();
    await app.do("OpenTicket", { stream: "t-1", actor }, { title: "a" });

    // Drop the event-to-state mapping for `TicketOpened` so the
    // cycle's owner lookup returns undefined — simulates a state
    // that was removed from the build between deployments.
    const internals = app as unknown as {
      _event_to_state: Map<string, unknown>;
    };
    const original = new Map(internals._event_to_state);
    internals._event_to_state.delete("TicketOpened");

    try {
      const result = await run_cycle(app);
      // Stream paginated but evaluated count is zero (no owner).
      expect(result.inspected).toBeGreaterThanOrEqual(1);
      expect(result.evaluated).toBe(0);
      expect(result.close_result.truncated.size).toBe(0);
    } finally {
      internals._event_to_state.clear();
      for (const [k, v] of original)
        (internals._event_to_state as Map<string, unknown>).set(k, v);
    }
  });
});
