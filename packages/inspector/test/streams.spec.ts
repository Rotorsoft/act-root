/**
 * Stream-aggregate procedures (ACT-1131).
 *
 * Covers `streams`, `streamStats`, `schemaEvolution`, and
 * `streamsForEvent`. Fixture seeds multiple streams with a mix of
 * current + deprecated event versions (`Foo` + `Foo_v2`) so the
 * `_v<n>` classification path is exercised.
 */
import type { InMemoryStore } from "@rotorsoft/act";
import { beforeEach, describe, expect, it } from "vitest";
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
    const rows = await caller.streams({ limit: 100 });
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

  it("returns an empty array for a fresh store", async () => {
    expect(await caller.streams()).toEqual([]);
  });

  it("honors `limit`", async () => {
    await seedFixture();
    const rows = await caller.streams({ limit: 1 });
    expect(rows).toHaveLength(1);
  });

  // Stream lifecycle affordances (#1174): closed / restarted / pruned /
  // close-scheduled, derived from head + tail + the subscriptions table.
  describe("lifecycle flags", () => {
    it("plain streams report every flag false", async () => {
      await seedFixture();
      const rows = await caller.streams({ limit: 100 });
      for (const row of rows) {
        expect(row.isClosed).toBe(false);
        expect(row.isRestarted).toBe(false);
        expect(row.isPruned).toBe(false);
        expect(row.closeScheduled).toBe(false);
      }
    });

    it("flags a tombstoned stream as closed", async () => {
      await seedSequence(store, "lc-closed", [{ name: "Opened" }]);
      await store.truncate([{ stream: "lc-closed" }]);
      const rows = await caller.streams({ limit: 100 });
      const row = rows.find((r) => r.stream === "lc-closed")!;
      expect(row.isClosed).toBe(true);
      expect(row.isRestarted).toBe(false);
      expect(row.isPruned).toBe(false);
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
      const rows = await caller.streams({ limit: 100 });
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
      const rows = await caller.streams({ limit: 100 });
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
      const rows = await caller.streams({ limit: 100 });
      const row = rows.find((r) => r.stream === "lc-scheduled")!;
      expect(row.closeScheduled).toBe(true);
    });

    it("drops close-scheduled once the stream is closed", async () => {
      await seedSequence(store, "lc-done", [{ name: "Opened" }]);
      await store.subscribe([
        { stream: "__autoclose__:lc-done", source: "lc-done" },
      ]);
      await store.truncate([{ stream: "lc-done" }]);
      const rows = await caller.streams({ limit: 100 });
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
