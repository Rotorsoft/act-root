/**
 * Stream-aggregate procedures (ACT-1131).
 *
 * Covers `streams`, `streamStats`, `schemaEvolution`, and
 * `streamsForEvent`. Fixture seeds multiple streams with a mix of
 * current + deprecated event versions (`Foo` + `Foo_v2`) so the
 * `_v<n>` classification path is exercised.
 */
import type { InMemoryStore } from "@rotorsoft/act";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getActiveStore, inspectorRouter } from "../src/server/router.js";
import { seed, seedSequence } from "./helpers.js";

const caller = inspectorRouter.createCaller({});

let store: InMemoryStore;

beforeEach(async () => {
  await caller.disconnect();
  await caller.connect({ adapter: "inmemory" });
  store = getActiveStore() as InMemoryStore;
});

async function seedFixture() {
  // stream-a: 2× legacy "Opened", 1× current "Opened_v2", 1× "Closed"
  await seedSequence(store, "stream-a", [
    { name: "Opened" },
    { name: "Closed" },
    { name: "Opened_v2" },
    { name: "Opened" },
  ]);
  // stream-b: 1× "Opened" (legacy only), 1× standalone "Heartbeat"
  await seedSequence(store, "stream-b", [
    { name: "Opened" },
    { name: "Heartbeat" },
  ]);
  // Register both streams so `streamsForEvent` + drainStatus have
  // positions to read.
  await store.subscribe([
    { stream: "stream-a", source: "src-a", priority: 5 },
    { stream: "stream-b" },
  ]);
}

describe("streams", () => {
  it("returns per-stream aggregates sorted by event count desc", async () => {
    await seedFixture();
    const { streams: rows } = await caller.streams({ limit: 100 });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.stream).toBe("stream-a");
    expect(rows[0]!.eventCount).toBe(4);
    expect(rows[1]!.stream).toBe("stream-b");
    expect(rows[1]!.eventCount).toBe(2);
    expect(rows[0]!.currentVersion).toBe(3);
    expect(rows[0]!.isClosed).toBe(false);
    expect(rows[0]!.nameCounts).toMatchObject({ Opened: 2, Opened_v2: 1 });
    expect(rows[0]!.firstEvent).toBeTypeOf("string");
  });

  it("returns an empty page for a fresh store", async () => {
    expect(await caller.streams()).toEqual({ streams: [], total: 0 });
  });

  it("honors `limit`", async () => {
    await seedFixture();
    const { streams: rows } = await caller.streams({ limit: 1 });
    expect(rows).toHaveLength(1);
  });

  // The page is sorted by event count descending, so the rows the cap
  // discards are the *least* active streams — exactly the population an
  // operator hunting a quiet or stalled stream is looking for. Without
  // an untruncated count the view cannot say the list was cut, and
  // "absent from the list" reads as "does not exist".
  it("reports the untruncated stream count alongside a capped page", async () => {
    await seedSequence(store, "busy-1", [
      { name: "Opened" },
      { name: "Opened" },
      { name: "Opened" },
    ]);
    await seedSequence(store, "busy-2", [
      { name: "Opened" },
      { name: "Opened" },
    ]);
    await seed(store, "quiet-one", "Opened");
    const page = await caller.streams({ limit: 2 });
    expect(page.streams.map((s) => s.stream)).toEqual(["busy-1", "busy-2"]);
    expect(page.total).toBe(3);
  });

  it("reports a total equal to the page size when nothing was cut", async () => {
    await seedFixture();
    const page = await caller.streams({ limit: 100 });
    expect(page.streams).toHaveLength(2);
    expect(page.total).toBe(2);
  });

  // The Streams view sorts its Age / Last columns lexically on these
  // strings. `Date.prototype.toString()` starts with the weekday
  // abbreviation, so a lexical sort would order Fri, Mon, Sat, Sun,
  // Thu, Tue, Wed instead of chronologically. ISO-8601 is the wire
  // format: it sorts lexically in chronological order, parses
  // everywhere, and doesn't depend on the server's locale or timezone.
  describe("timestamp wire format", () => {
    async function seedOnDates() {
      // Fake `Date` only — faking the timer functions too would stall
      // the store's own async plumbing and hang the commit.
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        for (const [stream, when] of [
          ["a-thu", "2026-08-20T12:00:00.000Z"],
          ["b-mon", "2026-08-24T12:00:00.000Z"],
          ["c-fri", "2026-08-28T12:00:00.000Z"],
        ] as const) {
          vi.setSystemTime(new Date(when));
          await seed(store, stream, "Opened");
        }
      } finally {
        vi.useRealTimers();
      }
    }

    it("sorts chronologically when `lastEvent` is compared lexically", async () => {
      await seedOnDates();
      const { streams } = await caller.streams();
      const lexical = [...streams]
        .sort((a, b) => a.lastEvent.localeCompare(b.lastEvent))
        .map((s) => s.stream);
      expect(lexical).toEqual(["a-thu", "b-mon", "c-fri"]);
    });

    it("emits ISO-8601 for `lastEvent` and `firstEvent`", async () => {
      await seedOnDates();
      const { streams } = await caller.streams();
      const row = streams.find((s) => s.stream === "a-thu")!;
      expect(row.lastEvent).toBe("2026-08-20T12:00:00.000Z");
      expect(row.firstEvent).toBe("2026-08-20T12:00:00.000Z");
    });
  });

  // Stream lifecycle affordances (#1174): closed / restarted / pruned /
  // close-scheduled, derived from head + tail + the subscriptions table.
  describe("lifecycle flags", () => {
    it("plain streams report every flag false", async () => {
      await seedFixture();
      const { streams: rows } = await caller.streams({ limit: 100 });
      for (const row of rows) {
        expect(row.isClosed).toBe(false);
        expect(row.isRestarted).toBe(false);
        expect(row.isPruned).toBe(false);
        expect(row.closeScheduled).toBe(false);
        expect(row.isRetired).toBe(false);
      }
    });

    it("flags a tombstoned stream as closed", async () => {
      await seedSequence(store, "lc-closed", [{ name: "Opened" }]);
      await store.truncate([{ stream: "lc-closed" }]);
      const { streams: rows } = await caller.streams({ limit: 100 });
      const row = rows.find((r) => r.stream === "lc-closed")!;
      expect(row.isClosed).toBe(true);
      expect(row.isRestarted).toBe(false);
      expect(row.isPruned).toBe(false);
    });

    it("flags a stream whose only remaining event is a tombstone as retired (#1535)", async () => {
      await seedSequence(store, "lc-retired", [
        { name: "Opened" },
        { name: "Closed" },
      ]);
      await store.truncate([{ stream: "lc-retired" }]);
      const { streams: rows } = await caller.streams({ limit: 100 });
      const row = rows.find((r) => r.stream === "lc-retired")!;
      expect(row.isRetired).toBe(true);
      // Retired is a narrowing of closed, not an alternative to it.
      expect(row.isClosed).toBe(true);
      expect(row.isRestarted).toBe(false);
      expect(row.isPruned).toBe(false);
    });

    it("does not flag a failed close as retired — the real events are still there", async () => {
      // What a close that committed its guard tombstone and then failed
      // to truncate leaves behind: a tombstone head over live history.
      // Closed, but its reactions may still have work pending, so
      // retiring it would hide a real subscription.
      await seedSequence(store, "lc-guarded", [
        { name: "Opened" },
        { name: "__tombstone__" },
      ]);
      const { streams: rows } = await caller.streams({ limit: 100 });
      const row = rows.find((r) => r.stream === "lc-guarded")!;
      expect(row.isClosed).toBe(true);
      expect(row.isRetired).toBe(false);
    });

    it("does not flag a restarted stream as retired — its seed is a snapshot", async () => {
      await seedSequence(store, "lc-reseeded", [{ name: "Opened" }]);
      await store.truncate([{ stream: "lc-reseeded", snapshot: { n: 1 } }]);
      const { streams: rows } = await caller.streams({ limit: 100 });
      const row = rows.find((r) => r.stream === "lc-reseeded")!;
      expect(row.isRetired).toBe(false);
      expect(row.isRestarted).toBe(true);
    });

    it("flags a full-close reseed as restarted (version-0 snapshot tail)", async () => {
      await seedSequence(store, "lc-restarted", [
        { name: "Opened" },
        { name: "Opened" },
      ]);
      await store.truncate([
        { stream: "lc-restarted", snapshot: { count: 2 } },
      ]);
      await seed(store, "lc-restarted", "Opened", {}, 0);
      const { streams: rows } = await caller.streams({ limit: 100 });
      const row = rows.find((r) => r.stream === "lc-restarted")!;
      expect(row.isRestarted).toBe(true);
      expect(row.isPruned).toBe(false);
      expect(row.isClosed).toBe(false);
    });

    it("flags a windowed close as pruned (boundary snapshot tail above version 0)", async () => {
      await seedSequence(store, "lc-pruned", [
        { name: "Opened" },
        { name: "Opened" },
        { name: "__snapshot__", data: { count: 2 } },
        { name: "Opened" },
      ]);
      await store.truncate([
        { stream: "lc-pruned", before: new Date(Date.now() + 60_000) },
      ]);
      const { streams: rows } = await caller.streams({ limit: 100 });
      const row = rows.find((r) => r.stream === "lc-pruned")!;
      expect(row.isPruned).toBe(true);
      expect(row.isRestarted).toBe(false);
      expect(row.isClosed).toBe(false);
      // The stream is live: eventCount is snapshot + tail, not zero.
      expect(row.eventCount).toBe(2);
    });

    it("flags streams with a parked autoclose reaction as close-scheduled", async () => {
      await seedSequence(store, "lc-scheduled", [{ name: "Opened" }]);
      // The framework registers one `__autoclose__:<aggregate>` position
      // per `.autocloses(...)` aggregate; the inspector reads the
      // subscriptions table, so registering the position directly is the
      // store-level equivalent.
      await store.subscribe([
        { stream: "__autoclose__:lc-scheduled", source: "lc-scheduled" },
      ]);
      const { streams: rows } = await caller.streams({ limit: 100 });
      const row = rows.find((r) => r.stream === "lc-scheduled")!;
      expect(row.closeScheduled).toBe(true);
    });

    it("drops close-scheduled once the stream is closed", async () => {
      await seedSequence(store, "lc-done", [{ name: "Opened" }]);
      await store.subscribe([
        { stream: "__autoclose__:lc-done", source: "lc-done" },
      ]);
      await store.truncate([{ stream: "lc-done" }]);
      const { streams: rows } = await caller.streams({ limit: 100 });
      const row = rows.find((r) => r.stream === "lc-done")!;
      expect(row.isClosed).toBe(true);
      expect(row.closeScheduled).toBe(false);
    });
  });
});

describe("streamStats", () => {
  it("returns full per-stream stats for an existing stream", async () => {
    await seedFixture();
    const stats = await caller.streamStats({ stream: "stream-a" });
    expect(stats).not.toBeNull();
    expect(stats!.eventCount).toBe(4);
    expect(stats!.head.name).toBe("Opened");
    expect(stats!.head.version).toBe(3);
    expect(stats!.tail).not.toBeNull();
    expect(stats!.tail!.version).toBe(0);
    expect(stats!.asOf).toBeNull();
    expect(stats!.nameCounts).toMatchObject({ Opened: 2, Opened_v2: 1 });
  });

  it("returns null for an unknown stream", async () => {
    await seedFixture();
    expect(await caller.streamStats({ stream: "ghost" })).toBeNull();
  });

  it("threads `before` through as a time-travel cutoff", async () => {
    await seedFixture();
    const stats = await caller.streamStats({ stream: "stream-a", before: 2 });
    expect(stats).not.toBeNull();
    expect(stats!.asOf).toBe(2);
    // Only events with id < 2 qualify → first two of stream-a (versions 0, 1).
    expect(stats!.eventCount).toBe(2);
  });
});

describe("schemaEvolution", () => {
  it("classifies events as current / deprecated / active", async () => {
    await seedFixture();
    const result = await caller.schemaEvolution();
    const by_name = new Map(result.events.map((e) => [e.name, e]));
    // `Opened` is the legacy version of `Opened_v2` — deprecated.
    expect(by_name.get("Opened")!.status).toBe("deprecated");
    expect(by_name.get("Opened")!.currentVersion).toBe("Opened_v2");
    expect(by_name.get("Opened_v2")!.status).toBe("current");
    expect(by_name.get("Closed")!.status).toBe("active");
    expect(by_name.get("Heartbeat")!.status).toBe("active");
    // Deprecated rows sort first.
    expect(result.events[0]!.status).toBe("deprecated");
    // Summary totals.
    expect(result.summary.totalEvents).toBe(6);
    expect(result.summary.deprecatedEvents).toBe(3); // 2 from stream-a + 1 from stream-b
    expect(result.summary.distinctNames).toBe(4);
    expect(result.summary.deprecatedNames).toBe(1);
  });
});

describe("streamsForEvent", () => {
  it("returns every stream holding a given event with subscription metadata", async () => {
    await seedFixture();
    const result = await caller.streamsForEvent({ name: "Opened" });
    expect(result.event).toBe("Opened");
    expect(result.totalEventsOfName).toBe(3);
    expect(result.streams).toHaveLength(2);
    const a = result.streams.find((s) => s.stream === "stream-a")!;
    expect(a.eventCount).toBe(2);
    // InMemoryStore defaults `lane` to the literal string "default"
    // when subscribe doesn't pass one; PG/SQLite encode it as NULL and
    // the router's `?? null` collapses both to null only for the
    // undefined case. Accept either shape here.
    expect(a.lane === null || a.lane === "default").toBe(true);
    expect(a.priority).toBe(5);
    const b = result.streams.find((s) => s.stream === "stream-b")!;
    expect(b.eventCount).toBe(1);
    expect(b.priority).toBe(0);
  });

  it("returns an empty list when no stream holds the event", async () => {
    await seedFixture();
    const result = await caller.streamsForEvent({ name: "NeverHappened" });
    expect(result.streams).toEqual([]);
    expect(result.totalEventsOfName).toBe(0);
  });

  it("gracefully handles missing subscription positions", async () => {
    // Commit without subscribing — streamsForEvent must still report
    // the stream, with priority defaulting to 0.
    await seed(store, "orphan-stream", "Lonely");
    const result = await caller.streamsForEvent({ name: "Lonely" });
    expect(result.streams).toHaveLength(1);
    expect(result.streams[0]!.priority).toBe(0);
  });
});
