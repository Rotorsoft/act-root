import { z } from "zod";
import {
  act,
  cache,
  dispose,
  state,
  store,
  StreamClosedError,
  TOMBSTONE_EVENT,
} from "../src/index.js";

describe("close", () => {
  const counter = state({ Counter: z.object({ count: z.number() }) })
    .init(() => ({ count: 0 }))
    .emits({ incremented: z.object({ by: z.number() }) })
    .patch({
      incremented: ({ data }, s) => ({ count: s.count + data.by }),
    })
    .on({ increment: z.object({ by: z.number() }) })
    .emit((action) => ["incremented", { by: action.by }])
    .build();

  const app = act()
    .withState(counter)
    .on("incremented")
    .do(async function onIncremented() {
      await Promise.resolve();
    })
    .to("reaction-target")
    .build();

  const actor = { id: "test", name: "Test" };

  beforeEach(async () => {
    await store().seed();
    await cache().clear();
  });

  afterAll(async () => {
    await dispose()();
  });

  it("should close streams and truncate events", async () => {
    await app.do("increment", { stream: "s1", actor }, { by: 1 });
    await app.do("increment", { stream: "s1", actor }, { by: 2 });
    await app.do("increment", { stream: "s2", actor }, { by: 5 });

    // Drain reactions so streams are caught up
    await app.correlate();
    let d;
    do {
      d = await app.drain();
    } while (d.acked.length);

    const result = await app.close({ streams: ["s1", "s2"] });

    expect(result.closed).toEqual(["s1", "s2"]);
    expect(result.truncated).toBeGreaterThan(0);
    expect(result.skipped).toEqual([]);
    expect(result.restarted).toEqual([]);

    // Events should be gone (only tombstones remain)
    const events: any[] = [];
    await store().query((e) => events.push(e), {
      stream: "s1",
      stream_exact: true,
    });
    expect(events.length).toBe(1);
    expect(events[0].name).toBe(TOMBSTONE_EVENT);
  });

  it("should call archive callback with all events before truncation", async () => {
    await app.do("increment", { stream: "arch", actor }, { by: 10 });
    await app.do("increment", { stream: "arch", actor }, { by: 20 });

    await app.correlate();
    let d;
    do {
      d = await app.drain();
    } while (d.acked.length);

    const archived: Record<string, any[]> = {};
    const result = await app.close({
      streams: ["arch"],
      archive: async (stream) => {
        const events = await app.query_array({
          stream,
          stream_exact: true,
          with_snaps: true,
        });
        archived[stream] = events;
      },
    });

    expect(result.closed).toEqual(["arch"]);
    expect(archived["arch"]).toBeDefined();
    expect(archived["arch"].length).toBeGreaterThanOrEqual(2);
    // Events should include both incremented events
    const names = archived["arch"].map((e: any) => e.name);
    expect(names).toContain("incremented");
  });

  it("should abort entirely when archive callback throws", async () => {
    await app.do("increment", { stream: "fail1", actor }, { by: 1 });
    await app.do("increment", { stream: "fail2", actor }, { by: 2 });

    await app.correlate();
    let d;
    do {
      d = await app.drain();
    } while (d.acked.length);

    let callCount = 0;
    await expect(
      app.close({
        streams: ["fail1", "fail2"],
        archive: () => {
          callCount++;
          if (callCount === 1) return Promise.reject(new Error("S3 down"));
          return Promise.resolve();
        },
      })
    ).rejects.toThrow("S3 down");

    // Events should still exist — nothing was truncated
    const events: any[] = [];
    await store().query((e) => events.push(e), {
      stream: "fail1",
      stream_exact: true,
    });
    expect(events.length).toBeGreaterThan(0);
    // No tombstones should exist
    expect(events.some((e) => e.name === TOMBSTONE_EVENT)).toBe(false);
  });

  it("should skip streams with pending reactions", async () => {
    await app.do("increment", { stream: "pending", actor }, { by: 1 });

    // Correlate but do NOT drain — reaction target has pending work
    await app.correlate();

    const result = await app.close({ streams: ["pending"] });

    // The stream should be skipped since the reaction target hasn't caught up
    expect(result.skipped).toEqual(["pending"]);
    expect(result.closed).toEqual([]);

    // Events should still exist
    const events: any[] = [];
    await store().query((e) => events.push(e), {
      stream: "pending",
      stream_exact: true,
    });
    expect(events.length).toBeGreaterThan(0);
  });

  it("should restart streams with opening event at version 0", async () => {
    await app.do("increment", { stream: "restart", actor }, { by: 42 });

    await app.correlate();
    let d;
    do {
      d = await app.drain();
    } while (d.acked.length);

    const result = await app.close({
      streams: ["restart"],
      snapshots: { restart: { count: 42 } },
    });

    expect(result.closed).toEqual(["restart"]);
    expect(result.restarted).toEqual(["restart"]);

    // Stream should be alive with the restarted state (seeded via snapshot)
    const snap = await app.load(counter, "restart");
    expect(snap.state.count).toBe(42);
    expect(snap.patches).toBe(0); // snapshot only, no domain events yet

    // No tombstone should remain
    const events: any[] = [];
    await store().query((e) => events.push(e), {
      stream: "restart",
      stream_exact: true,
    });
    expect(events.every((e) => e.name !== TOMBSTONE_EVENT)).toBe(true);
  });

  it("should handle selective restart (some restart, some stay closed)", async () => {
    await app.do("increment", { stream: "sel-a", actor }, { by: 10 });
    await app.do("increment", { stream: "sel-b", actor }, { by: 20 });

    await app.correlate();
    let d;
    do {
      d = await app.drain();
    } while (d.acked.length);

    const result = await app.close({
      streams: ["sel-a", "sel-b"],
      snapshots: { "sel-a": { count: 10 } }, // restart sel-a, tombstone sel-b
    });

    expect(result.restarted).toEqual(["sel-a"]);
    expect(result.closed).toEqual(["sel-a", "sel-b"]);

    // sel-a should be alive with carried-forward state
    const snapA = await app.load(counter, "sel-a");
    expect(snapA.state.count).toBe(10);

    // sel-b should be tombstoned
    await expect(
      app.do("increment", { stream: "sel-b", actor }, { by: 1 })
    ).rejects.toThrow(StreamClosedError);
  });

  it("should be idempotent — closing already-truncated streams is a no-op", async () => {
    await app.do("increment", { stream: "idem", actor }, { by: 1 });

    await app.correlate();
    let d;
    do {
      d = await app.drain();
    } while (d.acked.length);

    // First close
    const r1 = await app.close({ streams: ["idem"] });
    expect(r1.closed).toEqual(["idem"]);

    // Second close — stream was already tombstoned+truncated, has no domain events
    // The tombstone stream now exists but has maxId pointing at tombstone only
    const r2 = await app.close({ streams: ["idem"] });
    // Should be empty — no domain events to close
    expect(r2.closed).toEqual([]);
    expect(r2.skipped).toEqual([]);
  });

  it("should throw StreamClosedError when writing to tombstoned stream", async () => {
    await app.do("increment", { stream: "tomb", actor }, { by: 1 });

    await app.correlate();
    let d;
    do {
      d = await app.drain();
    } while (d.acked.length);

    await app.close({ streams: ["tomb"] });

    await expect(
      app.do("increment", { stream: "tomb", actor }, { by: 1 })
    ).rejects.toThrow(StreamClosedError);
  });

  it("should return empty result for empty streams array", async () => {
    const result = await app.close({ streams: [] });
    expect(result).toEqual({
      closed: [],
      truncated: 0,
      skipped: [],
      restarted: [],
    });
  });

  it("should emit 'closed' lifecycle event", async () => {
    await app.do("increment", { stream: "evt", actor }, { by: 1 });

    await app.correlate();
    let d;
    do {
      d = await app.drain();
    } while (d.acked.length);

    const listener = vi.fn();
    app.on("closed", listener);

    await app.close({ streams: ["evt"] });

    expect(listener).toHaveBeenCalledTimes(1);
    const result = listener.mock.calls[0][0];
    expect(result.closed).toEqual(["evt"]);

    app.off("closed", listener);
  });

  it("should close without archive callback (direct truncation)", async () => {
    await app.do("increment", { stream: "noarch", actor }, { by: 7 });

    await app.correlate();
    let d;
    do {
      d = await app.drain();
    } while (d.acked.length);

    const result = await app.close({ streams: ["noarch"] });
    expect(result.closed).toEqual(["noarch"]);
    expect(result.truncated).toBeGreaterThan(0);
  });

  it("should invalidate cache for closed streams", async () => {
    await app.do("increment", { stream: "cached", actor }, { by: 5 });

    // Ensure it's cached
    await app.load(counter, "cached");
    const cached = await cache().get("cached");
    expect(cached).toBeDefined();

    await app.correlate();
    let d;
    do {
      d = await app.drain();
    } while (d.acked.length);

    await app.close({ streams: ["cached"] });

    // Cache should be invalidated
    const afterClose = await cache().get("cached");
    expect(afterClose).toBeUndefined();
  });

  it("should handle mixed results — some safe, some skipped", async () => {
    // safe stream: fully drained
    await app.do("increment", { stream: "mix-safe", actor }, { by: 1 });
    await app.correlate();
    let d;
    do {
      d = await app.drain();
    } while (d.acked.length);

    // pending stream: not drained
    await app.do("increment", { stream: "mix-pending", actor }, { by: 2 });
    await app.correlate();

    const result = await app.close({
      streams: ["mix-safe", "mix-pending"],
    });

    expect(result.closed).toContain("mix-safe");
    expect(result.skipped).toContain("mix-pending");
  });

  it("should preserve tombstone data with final state", async () => {
    await app.do("increment", { stream: "tdata", actor }, { by: 99 });

    await app.correlate();
    let d;
    do {
      d = await app.drain();
    } while (d.acked.length);

    // Without restart, tombstone is a marker with empty data (no state loaded)
    await app.close({ streams: ["tdata"] });

    const events: any[] = [];
    await store().query((e) => events.push(e), {
      stream: "tdata",
      stream_exact: true,
    });
    const tombstone = events.find((e) => e.name === TOMBSTONE_EVENT);
    expect(tombstone).toBeDefined();
    expect(tombstone.data).toEqual({});
  });

  it("should skip streams with source-filtered pending reactions", async () => {
    // Build an app where the reaction has a source filter
    const srcApp = act()
      .withState(counter)
      .on("incremented")
      .do(async function projectStream() {
        await Promise.resolve();
      })
      .to((e) => ({ target: `proj-${e.stream}`, source: e.stream }))
      .build();

    await srcApp.do("increment", { stream: "src-a", actor }, { by: 1 });
    await srcApp.correlate();
    // Don't drain — reaction target proj-src-a has pending work sourced from "src-a"

    const result = await srcApp.close({ streams: ["src-a"] });
    expect(result.skipped).toEqual(["src-a"]);
    expect(result.closed).toEqual([]);
  });

  it("should handle closing empty stream while reactions exist for other streams", async () => {
    // Create events on one stream so reactions exist, but close a different
    // non-existent stream — covers maxId < 0 continue branch in safety check
    await app.do("increment", { stream: "has-events", actor }, { by: 1 });
    await app.correlate();
    // Don't drain — reaction target has pending work

    // Close a stream that has no events alongside the pending one
    const result = await app.close({
      streams: ["never-existed", "has-events"],
    });

    // never-existed has no events (maxId < 0) → silently excluded
    // has-events has pending reactions → skipped
    expect(result.closed).toEqual([]);
    expect(result.skipped).toEqual(["has-events"]);
  });

  it("should close streams on an app with no registered states", async () => {
    // Use a clean store so no reaction streams from earlier tests interfere
    await store().drop();

    // Build an app with no states — close() must handle missing mergedState
    const noStateApp = act().build();

    // Commit events directly to the store (bypass app.do)
    await store().commit(
      "raw-stream",
      [{ name: "SomeEvent", data: { x: 1 } }],
      { correlation: "c1", causation: {} }
    );

    const result = await noStateApp.close({ streams: ["raw-stream"] });

    expect(result.closed).toEqual(["raw-stream"]);
    expect(result.truncated).toBeGreaterThan(0);

    // Tombstone should have empty data (no state to capture)
    const events: any[] = [];
    await store().query((e) => events.push(e), {
      stream: "raw-stream",
      stream_exact: true,
    });
    const tombstone = events.find((e) => e.name === TOMBSTONE_EVENT);
    expect(tombstone).toBeDefined();
    expect(tombstone.data).toEqual({});
  });
});
