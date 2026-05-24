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
import { beforeEach, describe, expect, it } from "vitest";
import { getActiveStore, inspectorRouter } from "../src/server/router.js";
import { seed } from "./helpers.js";

const caller = inspectorRouter.createCaller({});
let store: InMemoryStore;

beforeEach(async () => {
  await caller.disconnect();
  await caller.connect({ adapter: "inmemory" });
  store = getActiveStore() as InMemoryStore;
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
  await store.claim(10, 10, "worker-A", 60_000);
}

describe("streamMeta", () => {
  it("surfaces every subscribed position with lane + priority", async () => {
    await fixture();
    const positions = await caller.streamMeta();
    const byStream = new Map(positions.map((p) => [p.stream, p]));
    expect(byStream.get("sub-leased")!.priority).toBe(9);
    expect(byStream.get("sub-leased")!.lane).toBe("premium");
    // InMemoryStore stores the default lane as the literal "default"
    // (vs PG/SQLite which use NULL); the router preserves whichever
    // shape the adapter returns.
    const healthyLane = byStream.get("sub-healthy")!.lane;
    expect(healthyLane === null || healthyLane === "default").toBe(true);
    expect(byStream.get("sub-blocked")!.blocked).toBe(true);
    expect(byStream.get("sub-blocked")!.error).toBe("boom");
  });

  it("returns [] when there are no subscriptions", async () => {
    expect(await caller.streamMeta()).toEqual([]);
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

  it("returns a zeroed snapshot when no streams are subscribed", async () => {
    const status = await caller.drainStatus();
    expect(status.total).toBe(0);
    expect(status.healthy).toBe(0);
    expect(status.blocked).toBe(0);
    expect(status.leased).toBe(0);
    expect(status.lagging).toBe(0);
  });
});
