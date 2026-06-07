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
