import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  act,
  type CloseResult,
  dispose,
  StoreError,
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

  // The close sink runs after the acks are durable, so a throwing
  // `closed` listener must not unwind into the drain's store-error catch —
  // the close-requesting event is already acked and the reaction never
  // re-fires, so the close would be lost permanently.
  it("contains a throwing closed listener without failing the cycle", async () => {
    const errors: unknown[] = [];
    const app = act()
      .withState(ticket({ is: "Resolved" }))
      .build();
    app.on("error", (e) => errors.push(e));
    app.on("closed", () => {
      throw new Error("listener bug");
    });

    await app.do("open", { stream: "t-throw", actor }, {});
    await app.do("resolve", { stream: "t-throw", actor }, {});
    await app.correlate();
    const drain = await app.drain();

    // The cycle completed normally: no fictitious store failure, and the
    // caller still gets its acks.
    expect(errors).toHaveLength(0);
    expect(drain.acked.length).toBeGreaterThan(0);
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

  // #1388 — `on_close` runs the close machinery, not an emit. A StoreError
  // from inside it must reach the breaker; wrapping the whole call in the
  // listener-containment helper meant a real outage produced no `error`
  // event, no cooldown, and a breaker that recorded a SUCCESS for the
  // failing cycle. Only the `closed` emit is contained (tested above).
  it("surfaces a store failure inside the close as an error event", async () => {
    const errors: unknown[] = [];
    const app = act()
      .withState(ticket({ is: "Resolved" }))
      .build();
    app.on("error", (e) => errors.push(e));

    const real = store().truncate.bind(store());
    const spy = vi
      .spyOn(store(), "truncate")
      .mockRejectedValue(new StoreError("truncate"));

    await app.do("open", { stream: "t-fail", actor }, {});
    await app.do("resolve", { stream: "t-fail", actor }, {});
    await app.correlate();
    await app.drain();

    expect(errors.length).toBeGreaterThan(0);
    spy.mockRestore();
    void real;
  });

  // #1389 — a close writes its tombstone guard first and truncates last.
  // An archive callback that throws leaves the stream guarded-but-intact,
  // which close-cycle.md documents as a safe state the caller can simply
  // retry. Phase 1 used to drop every tombstone-headed stream, so the
  // retry found nothing: an empty, error-free CloseResult, and a stream
  // that was write-dead, unarchived and untruncated forever.
  it("resumes a close whose archive callback threw", async () => {
    const archived: string[] = [];
    let failed = false;
    const app = act()
      .withState(
        base()
          .autocloses({ is: "Resolved" })
          .archives(async (stream) => {
            if (!failed) {
              failed = true;
              throw new Error("s3 down");
            }
            archived.push(stream);
          })
          .build()
      )
      .build();

    await app.do("open", { stream: "t-resume", actor }, {});
    await app.do("resolve", { stream: "t-resume", actor }, {});
    await app.correlate();
    await app.drain();

    // Interrupted: guarded but not truncated.
    const mid: string[] = [];
    await store().query((e) => mid.push(String(e.name)), {
      stream: "t-resume",
    });
    expect(mid).toContain("__tombstone__");
    expect(mid).toContain("Resolved");
    expect(archived).toEqual([]);

    // The documented recovery: retry the close. close-cycle.md promises
    // Phase 5 runs archive again, so the retry carries its own archiver
    // (`.archives` is autoclose-scoped; an explicit close supplies one via
    // CloseTarget.archive).
    const retry = await app.close([
      {
        stream: "t-resume",
        archive: async () => {
          archived.push("t-resume");
        },
      },
    ]);
    expect([...retry.truncated.keys()]).toContain("t-resume");
    expect(archived).toEqual(["t-resume"]);

    const after: string[] = [];
    await store().query((e) => after.push(String(e.name)), {
      stream: "t-resume",
    });
    expect(after).toEqual(["__tombstone__"]);
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

  it("does not defer to a PAST due-time when `after` has elapsed but the predicate is unmet (#1330)", async () => {
    const app = act()
      .withState(ticket({ is: "Resolved", after: { days: 1 } }))
      .build();
    // A non-terminal head (Opened) created 2 days ago — a long-lived open
    // ticket idle past the 1-day cooldown, restored with its source timestamp.
    const two_days_ago = new Date(Date.now() - 2 * 86_400_000);
    await store().restore?.(async (commit) => {
      await commit({
        id: 0,
        name: "Opened",
        data: {},
        stream: "t9",
        version: 0,
        created: two_days_ago,
        meta: { correlation: "c", causation: {} },
      } as never);
    });

    await app.correlate();
    await app.drain();

    // No stream may carry a deferred_at in the PAST — claim only excludes
    // future deferred_at, so a past defer would be re-claimed every cycle
    // (busy loop). The reaction returns and waits for the next event instead.
    const now = Date.now();
    let past_defer = false;
    await store().query_streams((p) => {
      if (p.deferred_at != null && p.deferred_at <= now) past_defer = true;
    });
    expect(past_defer).toBe(false);
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

  // #1356: a `__snapshot__` commits at a higher id right after the domain
  // event that tripped the snap predicate. The terminate-only path must key
  // on the domain head/count, not the trailing snapshot — otherwise `is`
  // never matches and `reaches` counts snapshot events toward the threshold.
  it("closes on the terminal event even when a snapshot trails it (`is`, #1356)", async () => {
    const closed: CloseResult[] = [];
    const app = act()
      .withState(
        base()
          .snap((s) => s.patches >= 2)
          .autocloses({ is: "Resolved" })
          .build()
      )
      .build();
    app.on("closed", (r) => closed.push(r));

    // Opened (patches=1), Resolved (patches=2 → a __snapshot__ trails Resolved).
    await app.do("open", { stream: "ts1", actor }, {});
    await app.do("resolve", { stream: "ts1", actor }, {});
    await app.correlate();
    await app.drain();

    expect(closed).toHaveLength(1);
    expect(closed[0].truncated.has("ts1")).toBe(true);
  });

  it("counts only domain events toward `reaches` when snapshots trail (#1356)", async () => {
    const closed: CloseResult[] = [];
    const app = act()
      .withState(
        base()
          .snap((s) => s.patches >= 2)
          .autocloses({ reaches: 3 })
          .build()
      )
      .build();
    app.on("closed", (r) => closed.push(r));

    // Two domain events (a __snapshot__ trails the 2nd) — the domain count is
    // 2, below the threshold of 3, so the snapshot must NOT inflate it.
    await app.do("open", { stream: "ts2", actor }, {});
    await app.do("resolve", { stream: "ts2", actor }, {});
    await app.correlate();
    await app.drain();
    expect(closed).toHaveLength(0);

    // Third domain event reaches the threshold of 3 real events.
    await app.do("open", { stream: "ts2", actor }, {});
    await app.correlate();
    await app.drain();
    expect(closed).toHaveLength(1);
    expect(closed[0].truncated.has("ts2")).toBe(true);
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

  it("parks an off-window tick until the window opens, then closes (#1175)", async () => {
    // The re-check is derived from the window itself — no polling
    // cadence. At 00:00 the {2, 6} window is closed and the reaction
    // defers to exactly 02:00; once the clock passes it, the next
    // trigger closes.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      const closed: CloseResult[] = [];
      const app = act()
        .withState(ticket({ reaches: 2 }))
        .build({ autocloseWindow: { start: 2, end: 6, timeZone: "UTC" } });
      app.on("closed", (r) => closed.push(r));

      await app.do("open", { stream: "t6", actor }, {});
      await app.do("resolve", { stream: "t6", actor }, {});
      await app.correlate();
      await app.drain();
      expect(closed).toHaveLength(0);

      vi.setSystemTime(new Date("2026-01-01T02:30:00Z"));
      await app.do("open", { stream: "t6", actor }, {});
      await app.drain();
      expect(closed).toHaveLength(1);
      expect(closed[0].truncated.has("t6")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
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
