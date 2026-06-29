import { afterEach, describe, expect, it } from "vitest";
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
