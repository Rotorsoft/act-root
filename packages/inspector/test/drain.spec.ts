/**
 * `streamMeta` + `drainStatus` (ACT-1131).
 *
 * These two procedures both hang off `query_streams`, so they share a
 * fixture that exercises every branch of the drain-status aggregator:
 *
 * - healthy stream (caught up)
 * - lagging stream (gap > 10)
 * - blocked stream (via `Store.block`)
 * - leased stream (via `Store.claim`)
 * - non-default priority bucket
 * - non-default lane (#1103)
 */
import { randomUUID } from "node:crypto";
import type { InMemoryStore } from "@rotorsoft/act";
import type { Store } from "@rotorsoft/act/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getActiveStore, inspectorRouter } from "../src/server/router.js";
import { seed } from "./helpers.js";

/**
 * Correlate's job, done by hand: `claim` follows the work mark since #1488,
 * so a test that commits events has to say which of them resolve where.
 * Marks every subscription up to the log head, which is honest for these
 * fixtures — their sources carry the events under test.
 */
const mark_all = async (s: Store) => {
  const rows: {
    stream: string;
    at: number;
    priority: number;
    lane?: string;
  }[] = [];
  const { maxEventId } = await s.query_streams((p) =>
    rows.push({
      stream: p.stream,
      at: p.at,
      priority: p.priority,
      lane: p.lane,
    })
  );
  const marks = rows
    .filter((r) => r.at < maxEventId)
    .map((r) => ({
      stream: r.stream,
      priority: r.priority,
      lane: r.lane,
      correlated_at: maxEventId,
    }));
  if (marks.length) await s.subscribe(marks);
};

const caller = inspectorRouter.createCaller({});
let store: InMemoryStore;

beforeEach(async () => {
  await caller.disconnect();
  await caller.connect({ adapter: "inmemory" });
  store = getActiveStore() as InMemoryStore;
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function fixture() {
  // Source events so subscriptions have something to chase.
  for (let i = 0; i < 20; i++) {
    await seed(store, "src-fast", "tick", { i }, i - 1);
  }
  // Subscribe four reaction streams with varied shape:
  //   healthy — caught up, no lease, default lane/priority
  //   lagging — never claimed, gap of 20
  //   blocked — blocked after a claim
  //   leased  — actively leased, premium lane + non-zero priority
  await store.subscribe([
    { stream: "sub-healthy", source: "src-fast" },
    { stream: "sub-lagging", source: "src-fast" },
    { stream: "sub-blocked", source: "src-fast" },
    {
      stream: "sub-leased",
      source: "src-fast",
      priority: 9,
      lane: "premium",
    },
  ]);

  // Bring sub-healthy fully caught up via ack so gap = 0.
  await mark_all(store);
  const claimed = await store.claim(10, 10, randomUUID(), 30_000);
  const healthy = claimed.find((l) => l.stream === "sub-healthy");
  if (healthy) {
    await store.ack([{ ...healthy, at: 19 }]);
  }
  // Block sub-blocked.
  const blocked = claimed.find((l) => l.stream === "sub-blocked");
  if (blocked) {
    await store.block([{ ...blocked, error: "boom" }]);
  }
  // Acquire an exclusive lease on sub-leased and leave it held — the
  // dashboard's "active leases" panel reads this row.
  await mark_all(store);
  await store.claim(10, 10, "worker-A", 60_000);
}

describe("streamMeta", () => {
  it("surfaces every subscribed position with lane + priority", async () => {
    await fixture();
    const positions = await caller.streamMeta();
    const by_stream = new Map(positions.map((p) => [p.stream, p]));
    expect(by_stream.get("sub-leased")!.priority).toBe(9);
    expect(by_stream.get("sub-leased")!.lane).toBe("premium");
    // InMemoryStore stores the default lane as the literal "default"
    // (vs PG/SQLite which use NULL); the router preserves whichever
    // shape the adapter returns.
    const healthyLane = by_stream.get("sub-healthy")!.lane;
    expect(healthyLane === null || healthyLane === "default").toBe(true);
    expect(by_stream.get("sub-blocked")!.blocked).toBe(true);
    expect(by_stream.get("sub-blocked")!.error).toBe("boom");
  });

  it("returns [] when there are no subscriptions", async () => {
    expect(await caller.streamMeta()).toEqual([]);
  });
});

/**
 * A failure is never data (#1552).
 *
 * Both of these read surfaces used to end in a bare catch that answered
 * with a healthy-looking value — a zeroed dashboard, an empty list — so a
 * store fault, or simply not being connected, read as "everything is
 * fine". Nothing is protected by swallowing here: the caller is a
 * read-only query and the client renders an error perfectly well.
 */
describe("faults reach the caller", () => {
  it("refuses drainStatus while disconnected, like every sibling read", async () => {
    await caller.disconnect();
    await expect(caller.drainStatus()).rejects.toThrow(
      "Not connected to a store"
    );
  });

  it("refuses streamMeta while disconnected", async () => {
    await caller.disconnect();
    await expect(caller.streamMeta()).rejects.toThrow(
      "Not connected to a store"
    );
  });

  it("surfaces a store fault instead of reporting nothing blocked", async () => {
    await fixture();
    // Control: the same fixture, read from a healthy store.
    expect((await caller.drainStatus()).blocked).toBe(1);

    const fault = vi
      .spyOn(store, "query_stats")
      .mockRejectedValue(new Error("store fault"));
    await expect(caller.drainStatus()).rejects.toThrow("store fault");

    // The data was never gone — only that one call path failed.
    fault.mockRestore();
    expect((await caller.drainStatus()).blocked).toBe(1);
  });

  it("surfaces a store fault from streamMeta", async () => {
    await fixture();
    expect((await caller.streamMeta()).length).toBeGreaterThan(0);
    vi.spyOn(store, "query_streams").mockRejectedValue(
      new Error("streams read failed")
    );
    await expect(caller.streamMeta()).rejects.toThrow("streams read failed");
  });
});

describe("drainStatus", () => {
  it("classifies streams into healthy / lagging / blocked / leased buckets", async () => {
    await fixture();
    const status = await caller.drainStatus();
    expect(status.total).toBe(4);
    expect(status.blocked).toBe(1);
    expect(status.leased).toBeGreaterThanOrEqual(1);
    expect(status.healthy + status.lagging).toBeGreaterThanOrEqual(1);
    expect(status.maxEventId).toBe(19);
    // Watermark histogram covers all the lag buckets the fixture spans.
    const histBuckets = status.histogram.reduce((acc, b) => acc + b.count, 0);
    expect(histBuckets).toBe(4);
    // Blocked + active-lease panels carry the right shape.
    expect(status.blockedStreams[0]).toMatchObject({
      stream: "sub-blocked",
      error: "boom",
    });
    expect(status.activeLeases.length).toBeGreaterThanOrEqual(1);
    expect(status.priorityCounts.find((p) => p.priority === 9)).toBeTruthy();
    expect(status.laneCounts.find((l) => l.lane === "premium")).toBeTruthy();
    expect(status.laneCounts.find((l) => l.lane === "default")).toBeTruthy();
    expect(status.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("reports pending work, not distance to the head (#1521)", async () => {
    // A reader that has consumed everything marked for it is healthy, however
    // far its watermark sits below the log's head. That is the ordinary shape
    // of a reaction handling a subset of a state's events: its watermark only
    // advances over events that resolve to it, so it is permanently behind
    // the head with nothing to do.
    for (let i = 0; i < 20; i++) {
      await seed(store, "src-quiet", "tick", { i }, i - 1);
    }
    await store.subscribe([
      // Marked well below the head, and caught up to that mark.
      { stream: "sub-caught-up", source: "src-quiet", correlated_at: 3 },
    ]);
    const claimed = await store.claim(10, 10, randomUUID(), 30_000);
    const mine = claimed.find((l) => l.stream === "sub-caught-up");
    if (mine) await store.ack([{ ...mine, at: 3 }]);

    const status = await caller.drainStatus();
    const row = status.histogram.reduce((acc, b) => acc + b.count, 0);
    expect(row).toBe(1);
    // Head distance is 16; pending work is 0. Counting the head distance
    // classified this as `lagging` and showed a backlog that does not exist.
    expect(status.maxEventId).toBe(19);
    expect(status.lagging).toBe(0);
    expect(status.healthy).toBe(1);
  });

  it("falls back to head distance for a row that carries no mark", async () => {
    // An install that predates the work-mark column, before `seed()` has
    // marked its rows: there is no mark to read, so the upper bound is the
    // best available answer and the number is what it always was.
    for (let i = 0; i < 20; i++) {
      await seed(store, "src-old", "tick", { i }, i - 1);
    }
    await store.subscribe([{ stream: "sub-unmarked", source: "src-old" }]);

    const status = await caller.drainStatus();
    expect(status.lagging).toBe(1);
    expect(status.healthy).toBe(0);
  });

  it("returns a zeroed snapshot when no streams are subscribed", async () => {
    const status = await caller.drainStatus();
    expect(status.total).toBe(0);
    expect(status.healthy).toBe(0);
    expect(status.blocked).toBe(0);
    expect(status.leased).toBe(0);
    expect(status.lagging).toBe(0);
    expect(status.retired).toBe(0);
    expect(status.retiredStreams).toEqual([]);
  });

  // Retired streams (#1535). Since #1527 a full close leaves the
  // subscription row in place, so the row keeps showing up here — inert,
  // permanently caught up, and indistinguishable from a live consumer
  // with nothing to do unless we say so.
  describe("retired streams", () => {
    /** Retire `stream` for good: delete its events, seed a tombstone. */
    const retire = async (stream: string) => {
      await store.truncate([{ stream }]);
    };

    it("counts retired rows apart from every health signal", async () => {
      await seed(store, "gone", "Opened", {}, -1);
      await seed(store, "live", "Opened", {}, -1);
      await store.subscribe([
        { stream: "gone", source: "src", priority: 7, lane: "premium" },
        { stream: "live", source: "src" },
      ]);
      await retire("gone");

      const status = await caller.drainStatus();
      // One live subscription; the retired one is counted on its own and
      // the health buckets still sum to `total`.
      expect(status.total).toBe(1);
      expect(status.retired).toBe(1);
      expect(
        status.healthy + status.lagging + status.blocked + status.leased
      ).toBe(status.total);
      // Out of the gap histogram…
      expect(status.histogram.reduce((acc, b) => acc + b.count, 0)).toBe(1);
      // …and out of the priority and lane tallies, so a retired stream
      // parked on a non-default lane doesn't inflate that lane's count.
      expect(status.priorityCounts.find((p) => p.priority === 7)).toBeFalsy();
      expect(status.laneCounts.find((l) => l.lane === "premium")).toBeFalsy();
    });

    it("never files a subscription with pending work as retired (#1553)", async () => {
      // Two namespaces, one string. A reaction targeting `order-1` and
      // reading from `src` blocks on a poison event; separately, the
      // *aggregate* stream `order-1` is closed for good. Matching the
      // subscription's target against the retired event streams by name
      // alone dropped this row out of `blocked`, `blockedStreams`,
      // `total`, the histogram and the tallies at once.
      //
      // The rule that holds: a row counts as retired only when it also
      // has nothing pending — `at >= correlated_at`, the store's own
      // claim predicate, and the property the framework relies on when
      // it calls a retired stream's subscription inert.
      await seed(store, "src", "Opened", {}, -1);
      await seed(store, "order-1", "Opened", {}, -1);
      await retire("order-1");
      await store.subscribe([{ stream: "order-1", source: "src" }]);
      await mark_all(store);
      const claimed = await store.claim(10, 10, randomUUID(), 30_000);
      const mine = claimed.find((l) => l.stream === "order-1")!;
      await store.block([{ ...mine, error: "poison" }]);

      const status = await caller.drainStatus();
      expect(status.blocked).toBe(1);
      expect(status.total).toBe(1);
      expect(status.retired).toBe(0);
      expect(status.blockedStreams[0]).toMatchObject({
        stream: "order-1",
        error: "poison",
      });
      // Ground truth, straight from the store.
      const rows: boolean[] = [];
      await store.query_streams((p) => rows.push(p.blocked));
      expect(rows.filter(Boolean)).toHaveLength(1);
    });

    it("still retires the per-aggregate saga it was written for", async () => {
      // The half that was always right: target == source, the stream is
      // closed for good, and the consumer has nothing left to do. The
      // extra "nothing pending" conjunct must not disturb this.
      await seed(store, "saga-1", "Opened", {}, -1);
      await store.subscribe([{ stream: "saga-1", source: "saga-1" }]);
      await mark_all(store);
      const claimed = await store.claim(10, 10, randomUUID(), 30_000);
      const mine = claimed.find((l) => l.stream === "saga-1")!;
      await store.ack([{ ...mine, at: 0 }]);
      await retire("saga-1");

      const status = await caller.drainStatus();
      expect(status.retired).toBe(1);
      expect(status.total).toBe(0);
    });

    it("reports each retired watermark as the record it is", async () => {
      await seed(store, "src-r", "Opened", {}, -1);
      await store.subscribe([{ stream: "retired-a", source: "src-r" }]);
      await seed(store, "retired-a", "Opened", {}, -1);
      await mark_all(store);
      const claimed = await store.claim(10, 10, randomUUID(), 30_000);
      const mine = claimed.find((l) => l.stream === "retired-a")!;
      await store.ack([{ ...mine, at: 1 }]);
      await retire("retired-a");

      const status = await caller.drainStatus();
      expect(status.retiredStreams).toHaveLength(1);
      expect(status.retiredStreams[0]).toMatchObject({
        stream: "retired-a",
        source: "src-r",
        at: 1,
      });
    });

    it("caps the sample of names while keeping the count exact", async () => {
      const streams = Array.from({ length: 55 }, (_, i) => `bulk-${i}`);
      for (const stream of streams) await seed(store, stream, "Opened", {}, -1);
      await store.subscribe(streams.map((stream) => ({ stream })));
      await store.truncate(streams.map((stream) => ({ stream })));

      const status = await caller.drainStatus();
      expect(status.retired).toBe(55);
      expect(status.retiredStreams).toHaveLength(50);
      // Alphabetical, so the sample is stable between polls.
      expect(status.retiredStreams[0]!.stream).toBe("bulk-0");
    });
  });
});
