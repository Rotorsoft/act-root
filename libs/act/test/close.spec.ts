import { z } from "zod";
import {
  act,
  cache,
  dispose,
  SNAP_EVENT,
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

  /** Helper: drain all pending reactions */
  async function drainAll() {
    await app.correlate();
    let d;
    do {
      d = await app.drain();
    } while (d.acked.length);
  }

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
    await drainAll();

    const result = await app.close({ streams: ["s1", "s2"] });

    expect(result.closed).toEqual(["s1", "s2"]);
    expect(result.truncated).toBeGreaterThan(0);
    expect(result.skipped).toEqual([]);
    expect(result.restarted).toEqual([]);

    // Only tombstones remain
    const events: any[] = [];
    await store().query((e) => events.push(e), {
      stream: "s1",
      stream_exact: true,
    });
    expect(events.length).toBe(1);
    expect(events[0].name).toBe(TOMBSTONE_EVENT);
  });

  it("should archive events while streams are guarded", async () => {
    await app.do("increment", { stream: "arch", actor }, { by: 10 });
    await app.do("increment", { stream: "arch", actor }, { by: 20 });
    await drainAll();

    const archived: Record<string, any[]> = {};
    const result = await app.close({
      streams: ["arch"],
      archive: async (stream) => {
        // Stream is guarded — archive sees all events including the guard tombstone
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
    const names = archived["arch"].map((e: any) => e.name);
    expect(names).toContain("incremented");
  });

  it("should abort archive but leave streams guarded (tombstoned)", async () => {
    await app.do("increment", { stream: "fail1", actor }, { by: 1 });
    await app.do("increment", { stream: "fail2", actor }, { by: 2 });
    await drainAll();

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

    // Streams are guarded (tombstoned) but NOT truncated — events still exist
    const events: any[] = [];
    await store().query((e) => events.push(e), {
      stream: "fail1",
      stream_exact: true,
    });
    // Original events + tombstone guard
    expect(events.filter((e) => e.name === "incremented").length).toBe(1);
    expect(events.filter((e) => e.name === TOMBSTONE_EVENT).length).toBe(1);

    // Stream is guarded — writes rejected
    await expect(
      app.do("increment", { stream: "fail1", actor }, { by: 1 })
    ).rejects.toThrow(StreamClosedError);
  });

  it("should skip streams with pending reactions", async () => {
    await app.do("increment", { stream: "pending", actor }, { by: 1 });
    await app.correlate();
    // Don't drain — reaction target has pending work

    const result = await app.close({ streams: ["pending"] });

    expect(result.skipped).toEqual(["pending"]);
    expect(result.closed).toEqual([]);

    // Events untouched
    const events: any[] = [];
    await store().query((e) => events.push(e), {
      stream: "pending",
      stream_exact: true,
    });
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.name === TOMBSTONE_EVENT)).toBe(false);
  });

  it("should restart streams with snapshot at version 0", async () => {
    await app.do("increment", { stream: "restart", actor }, { by: 42 });
    await drainAll();

    const result = await app.close({
      streams: ["restart"],
      snapshots: { restart: { count: 42 } },
    });

    expect(result.closed).toEqual(["restart"]);
    expect(result.restarted).toEqual(["restart"]);

    // Stream alive with snapshot state
    const snap = await app.load(counter, "restart");
    expect(snap.state.count).toBe(42);
    expect(snap.patches).toBe(0);

    // Only snapshot remains, no tombstone
    const events: any[] = [];
    await store().query((e) => events.push(e), {
      stream: "restart",
      stream_exact: true,
      with_snaps: true,
    });
    expect(events.length).toBe(1);
    expect(events[0].name).toBe(SNAP_EVENT);
  });

  it("should handle selective restart (some snapshot, some tombstone)", async () => {
    await app.do("increment", { stream: "sel-a", actor }, { by: 10 });
    await app.do("increment", { stream: "sel-b", actor }, { by: 20 });
    await drainAll();

    const result = await app.close({
      streams: ["sel-a", "sel-b"],
      snapshots: { "sel-a": { count: 10 } },
    });

    expect(result.restarted).toEqual(["sel-a"]);
    expect(result.closed).toEqual(["sel-a", "sel-b"]);

    // sel-a alive
    const snapA = await app.load(counter, "sel-a");
    expect(snapA.state.count).toBe(10);

    // sel-b tombstoned
    await expect(
      app.do("increment", { stream: "sel-b", actor }, { by: 1 })
    ).rejects.toThrow(StreamClosedError);
  });

  it("should be idempotent — closing already-tombstoned streams is a no-op", async () => {
    await app.do("increment", { stream: "idem", actor }, { by: 1 });
    await drainAll();

    const r1 = await app.close({ streams: ["idem"] });
    expect(r1.closed).toEqual(["idem"]);

    // Second close — tombstone-only stream, no domain events
    const r2 = await app.close({ streams: ["idem"] });
    expect(r2.closed).toEqual([]);
    expect(r2.skipped).toEqual([]);
  });

  it("should throw StreamClosedError when writing to tombstoned stream", async () => {
    await app.do("increment", { stream: "tomb", actor }, { by: 1 });
    await drainAll();

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
    await drainAll();

    const listener = vi.fn();
    app.on("closed", listener);
    await app.close({ streams: ["evt"] });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].closed).toEqual(["evt"]);
    app.off("closed", listener);
  });

  it("should close without archive callback", async () => {
    await app.do("increment", { stream: "noarch", actor }, { by: 7 });
    await drainAll();

    const result = await app.close({ streams: ["noarch"] });
    expect(result.closed).toEqual(["noarch"]);
    expect(result.truncated).toBeGreaterThan(0);
  });

  it("should invalidate cache for tombstoned streams", async () => {
    await app.do("increment", { stream: "cached", actor }, { by: 5 });
    await app.load(counter, "cached");
    expect(await cache().get("cached")).toBeDefined();
    await drainAll();

    await app.close({ streams: ["cached"] });
    expect(await cache().get("cached")).toBeUndefined();
  });

  it("should warm cache for restarted streams", async () => {
    await app.do("increment", { stream: "warm", actor }, { by: 5 });
    await drainAll();

    await app.close({
      streams: ["warm"],
      snapshots: { warm: { count: 99 } },
    });

    const cached = await cache().get<{ count: number }>("warm");
    expect(cached).toBeDefined();
    expect(cached!.state.count).toBe(99);
    expect(cached!.version).toBe(0);
    expect(cached!.snaps).toBe(1);
  });

  it("should handle mixed results — some safe, some skipped", async () => {
    await app.do("increment", { stream: "mix-safe", actor }, { by: 1 });
    await drainAll();

    // pending stream: not drained
    await app.do("increment", { stream: "mix-pending", actor }, { by: 2 });
    await app.correlate();

    const result = await app.close({
      streams: ["mix-safe", "mix-pending"],
    });

    expect(result.closed).toContain("mix-safe");
    expect(result.skipped).toContain("mix-pending");
  });

  it("should skip streams with concurrent writes (ConcurrencyError on guard)", async () => {
    await app.do("increment", { stream: "race", actor }, { by: 1 });
    await drainAll();

    // Mock commit to fail with ConcurrencyError on the guard tombstone
    const originalCommit = store().commit.bind(store());
    let guardAttempts = 0;
    vi.spyOn(store(), "commit").mockImplementation(
      async (stream, msgs, meta, expectedVersion) => {
        if (msgs[0]?.name === TOMBSTONE_EVENT && stream === "race") {
          guardAttempts++;
          throw new Error("ConcurrencyError");
        }
        return originalCommit(stream, msgs, meta, expectedVersion);
      }
    );

    const result = await app.close({ streams: ["race"] });
    expect(result.skipped).toContain("race");
    expect(result.closed).toEqual([]);
    expect(guardAttempts).toBe(1);

    vi.restoreAllMocks();
  });

  it("should skip streams with source-filtered pending reactions", async () => {
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

    const result = await srcApp.close({ streams: ["src-a"] });
    expect(result.skipped).toEqual(["src-a"]);
    expect(result.closed).toEqual([]);
  });

  it("should handle closing empty stream while reactions exist for other streams", async () => {
    await app.do("increment", { stream: "has-events", actor }, { by: 1 });
    await app.correlate();

    const result = await app.close({
      streams: ["never-existed", "has-events"],
    });

    expect(result.closed).toEqual([]);
    expect(result.skipped).toEqual(["has-events"]);
  });

  it("should close streams on an app with no registered states", async () => {
    await store().drop();
    const noStateApp = act().build();

    await store().commit(
      "raw-stream",
      [{ name: "SomeEvent", data: { x: 1 } }],
      { correlation: "c1", causation: {} }
    );

    const result = await noStateApp.close({ streams: ["raw-stream"] });

    expect(result.closed).toEqual(["raw-stream"]);
    expect(result.truncated).toBeGreaterThan(0);

    const events: any[] = [];
    await store().query((e) => events.push(e), {
      stream: "raw-stream",
      stream_exact: true,
    });
    const tombstone = events.find((e) => e.name === TOMBSTONE_EVENT);
    expect(tombstone).toBeDefined();
    expect(tombstone.data).toEqual({});
  });

  it("should tombstone data be empty for closed streams", async () => {
    await app.do("increment", { stream: "tdata", actor }, { by: 99 });
    await drainAll();

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
});
