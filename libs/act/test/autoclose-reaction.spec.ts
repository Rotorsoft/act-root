import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  act,
  type CloseResult,
  dispose,
  state,
  store,
  ZodEmpty,
} from "../src/index.js";

/**
 * Slice 1d Part 2 (#1090): `.autocloses` is a synthesized internal reaction
 * that rides the defer/close mechanic. These exercise the synthesized handler
 * directly against the in-memory store — the off-hours gate, the live-head
 * evaluation (reopen), the immediate-close (`is`), the time-gate park
 * (`after`), and the threshold close (`reaches`).
 */
describe("autoclose as a synthesized reaction", () => {
  const ticket = (
    policy: Parameters<ReturnType<typeof base>["autocloses"]>[0]
  ) => base().autocloses(policy).build();

  function base() {
    return state({ Ticket: z.object({ open: z.boolean() }) })
      .init(() => ({ open: false }))
      .emits({ Opened: ZodEmpty, Resolved: ZodEmpty })
      .patch({
        Opened: () => ({ open: true }),
        Resolved: () => ({ open: false }),
      })
      .on({ open: ZodEmpty })
      .emit(() => ["Opened", {}])
      .on({ resolve: ZodEmpty })
      .emit(() => ["Resolved", {}]);
  }

  const actor = { id: "a", name: "a" };

  afterEach(async () => {
    await dispose()();
  });

  it("closes immediately on the terminal event for an `is` policy", async () => {
    const closed: CloseResult[] = [];
    const app = act()
      .withState(ticket({ is: "Resolved" }))
      .build();
    app.on("closed", (r) => closed.push(r));

    await app.do("open", { stream: "t1", actor }, {});
    await app.do("resolve", { stream: "t1", actor }, {});
    await app.correlate();
    await app.drain();

    expect(closed).toHaveLength(1);
    expect(closed[0].truncated.has("t1")).toBe(true);
  });

  it("runs the .archives archiver while guarded, before truncating", async () => {
    const archived: string[] = [];
    const app = act()
      .withState(
        base()
          .autocloses({ is: "Resolved" })
          .archives(async (stream) => {
            archived.push(stream);
          })
          .build()
      )
      .build();

    await app.do("open", { stream: "ta", actor }, {});
    await app.do("resolve", { stream: "ta", actor }, {});
    await app.correlate();
    await app.drain();

    expect(archived).toEqual(["ta"]);
  });

  it("evaluates the live head — a reopened stream is not closed", async () => {
    const closed: CloseResult[] = [];
    const app = act()
      .withState(ticket({ is: "Resolved" }))
      .build();
    app.on("closed", (r) => closed.push(r));

    // Resolved then reopened: the live head is `Opened`, so `is: Resolved`
    // no longer holds and the stream must NOT be closed.
    await app.do("open", { stream: "t2", actor }, {});
    await app.do("resolve", { stream: "t2", actor }, {});
    await app.do("open", { stream: "t2", actor }, {});
    await app.correlate();
    await app.drain();

    expect(closed).toHaveLength(0);
  });

  it("parks on the cooldown instead of closing while `after` has not elapsed", async () => {
    const closed: CloseResult[] = [];
    // 1-minute floor window — far from elapsing during the test, so the
    // terminal event defers rather than closes.
    const app = act()
      .withState(ticket({ is: "Resolved", after: { days: 1 } }))
      .build();
    app.on("closed", (r) => closed.push(r));

    await app.do("open", { stream: "t3", actor }, {});
    await app.do("resolve", { stream: "t3", actor }, {});
    await app.correlate();
    await app.drain();

    expect(closed).toHaveLength(0);
    // The stream's events are still present (deferred, not truncated).
    const events = await app.query_array({ stream: "t3", stream_exact: true });
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => (e.name as string) !== "__tombstone__")).toBe(
      true
    );
  });

  it("closes on the threshold event for a `reaches` policy", async () => {
    const closed: CloseResult[] = [];
    const app = act()
      .withState(ticket({ reaches: 3 }))
      .build();
    app.on("closed", (r) => closed.push(r));

    // Two events: below threshold — no close.
    await app.do("open", { stream: "t4", actor }, {});
    await app.do("resolve", { stream: "t4", actor }, {});
    await app.correlate();
    await app.drain();
    expect(closed).toHaveLength(0);

    // Third event hits the threshold — closes.
    await app.do("open", { stream: "t4", actor }, {});
    await app.correlate();
    await app.drain();
    expect(closed).toHaveLength(1);
    expect(closed[0].truncated.has("t4")).toBe(true);
  });

  it("defensively skips closing when the live head has vanished mid-cycle", async () => {
    // Fault injection: simulate a competing worker truncating the stream
    // between the drain's fetch and the handler's query_stats — the handler
    // sees no live entry and must return without closing (the multi-worker
    // race guard), not throw.
    const closed: CloseResult[] = [];
    const app = act()
      .withState(ticket({ is: "Resolved" }))
      .build();
    app.on("closed", (r) => closed.push(r));

    await app.do("open", { stream: "tz", actor }, {});
    await app.do("resolve", { stream: "tz", actor }, {});
    await app.correlate();

    const s = store();
    const original = s.query_stats.bind(s);
    s.query_stats = (async () => new Map()) as typeof s.query_stats;
    try {
      await app.drain();
    } finally {
      s.query_stats = original;
    }

    expect(closed).toHaveLength(0);
  });

  it("respects the off-hours window — outside it, defers instead of closing", async () => {
    const closed: CloseResult[] = [];
    // A one-hour window that excludes the current hour, so the gate defers.
    const now = new Date();
    const h = now.getUTCHours();
    const start = (h + 2) % 24;
    const end = (h + 3) % 24;
    const app = act()
      .withState(ticket({ is: "Resolved" }))
      .build({ autocloseWindow: { start, end, timeZone: "UTC" } });
    app.on("closed", (r) => closed.push(r));

    await app.do("open", { stream: "t5", actor }, {});
    await app.do("resolve", { stream: "t5", actor }, {});
    await app.correlate();
    await app.drain();

    expect(closed).toHaveLength(0);
    const events = await app.query_array({ stream: "t5", stream_exact: true });
    expect(events.every((e) => (e.name as string) !== "__tombstone__")).toBe(
      true
    );
  });
});

/**
 * Rolling-window retention (#1011): `.autocloses({ keep })` stages
 * *windowed* closes through the same synthesized reaction — prune the
 * prefix older than `now − keep` behind the closest safe snapshot, defer
 * to `tail.created + keep` otherwise. Only Date is faked so the store
 * and drain keep their real timer behavior.
 */
describe("autoclose rolling window (keep)", () => {
  // Snapshot every 2 patches so streams grow real boundaries.
  function windowed_base() {
    return state({ WTicket: z.object({ n: z.number() }) })
      .init(() => ({ n: 0 }))
      .emits({ Bumped: ZodEmpty, Resolved: ZodEmpty })
      .patch({
        Bumped: (_, s) => ({ n: s.n + 1 }),
        Resolved: (_, s) => s,
      })
      .on({ bump: ZodEmpty })
      .emit(() => ["Bumped", {}])
      .on({ resolve: ZodEmpty })
      .emit(() => ["Resolved", {}])
      .snap((s) => s.patches >= 2);
  }

  const actor = { id: "a", name: "a" };
  const T0 = new Date("2026-01-01T00:00:00Z");

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await dispose()();
  });

  it("defers while the window holds, prunes once the tail ages out", async () => {
    const closed: CloseResult[] = [];
    const app = act()
      .withState(
        windowed_base()
          .autocloses({ keep: { days: 1 } })
          .build()
      )
      .build();
    app.on("closed", (r) => closed.push(r));

    for (let i = 0; i < 4; i++)
      await app.do("bump", { stream: "k1", actor }, {});
    await app.correlate();
    await app.drain();
    // Everything is younger than the window — deferred, nothing closed.
    expect(closed).toHaveLength(0);

    // Two days later the oldest domain event has aged out. A fresh event
    // re-arms the drain (the deferred due-time has passed, so the parked
    // reaction re-evaluates) and the prune is staged.
    vi.setSystemTime(new Date("2026-01-03T00:00:00Z"));
    await app.do("bump", { stream: "k1", actor }, {});
    await app.drain();

    expect(closed).toHaveLength(1);
    const entry = closed[0].truncated.get("k1");
    expect(entry?.before).toBeInstanceOf(Date);
    expect(entry?.committed.name).toBe("__snapshot__");

    // Prefix pruned behind the boundary snapshot; the stream stays live.
    const events = await app.query_array({
      stream: "k1",
      stream_exact: true,
      with_snaps: true,
      after: -1,
    });
    expect(events[0].name).toBe("__snapshot__");
    expect(events.every((e) => (e.name as string) !== "__tombstone__")).toBe(
      true
    );
    await app.do("bump", { stream: "k1", actor }, {});
  });

  it("passes the cutoff to the archiver on a windowed close", async () => {
    const calls: Array<{ stream: string; before?: Date }> = [];
    const app = act()
      .withState(
        windowed_base()
          .autocloses({ keep: { days: 1 } })
          .archives(async (stream, _head, before) => {
            calls.push({ stream, before });
          })
          .build()
      )
      .build();

    for (let i = 0; i < 4; i++)
      await app.do("bump", { stream: "k2", actor }, {});
    await app.correlate();
    await app.drain();
    expect(calls).toHaveLength(0);

    vi.setSystemTime(new Date("2026-01-03T00:00:00Z"));
    await app.do("bump", { stream: "k2", actor }, {});
    await app.drain();

    expect(calls).toHaveLength(1);
    expect(calls[0].stream).toBe("k2");
    expect(calls[0].before).toBeInstanceOf(Date);
  });

  it("terminate and prune stay independent — `is` full-closes even with keep declared", async () => {
    const closed: CloseResult[] = [];
    const app = act()
      .withState(
        windowed_base()
          .autocloses({ is: "Resolved", keep: { days: 1 } })
          .build()
      )
      .build();
    app.on("closed", (r) => closed.push(r));

    // Two bumps fire the snap predicate; the resolve lands after the
    // snapshot so the stream head is the terminal domain event (a
    // trailing snapshot would defer the guarded full close to the next
    // trigger).
    await app.do("bump", { stream: "k3", actor }, {});
    await app.do("bump", { stream: "k3", actor }, {});
    await app.do("resolve", { stream: "k3", actor }, {});
    await app.correlate();
    await app.drain();

    expect(closed).toHaveLength(1);
    const entry = closed[0].truncated.get("k3");
    expect(entry?.before).toBeUndefined();
    expect(entry?.committed.name).toBe("__tombstone__");
  });

  it("skips the prune when no snapshot qualifies, retrying next trigger", async () => {
    const closed: CloseResult[] = [];
    const app = act()
      .withState(
        windowed_base()
          .autocloses({ keep: { days: 1 } })
          .build()
      )
      .build();
    app.on("closed", (r) => closed.push(r));

    // A single event — the snap predicate (patches >= 2) never fired,
    // so there is no boundary to prune behind.
    await app.do("bump", { stream: "k4", actor }, {});
    await app.correlate();
    await app.drain();

    // A fresh event re-arms the drain. It also fires the snap predicate
    // (patches >= 2), but the new snapshot's `created` is *inside* the
    // window, so it never qualifies as a boundary — the prune still
    // no-ops and the stream is reported skipped.
    vi.setSystemTime(new Date("2026-01-03T00:00:00Z"));
    await app.do("bump", { stream: "k4", actor }, {});
    await app.drain();

    expect(closed).toHaveLength(1);
    expect(closed[0].truncated.size).toBe(0);
    expect(closed[0].skipped).toEqual(["k4"]);
    const events = await app.query_array({ stream: "k4", stream_exact: true });
    expect(events).toHaveLength(2);
  });
});
