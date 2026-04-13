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

    const result = await app.close([{ stream: "s1" }, { stream: "s2" }]);

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

    const archived: any[] = [];
    const result = await app.close([
      {
        stream: "arch",
        archive: async () => {
          const events = await app.query_array({
            stream: "arch",
            stream_exact: true,
            with_snaps: true,
          });
          archived.push(...events);
        },
      },
    ]);

    expect(result.closed).toEqual(["arch"]);
    expect(archived.length).toBeGreaterThanOrEqual(2);
    expect(archived.map((e) => e.name)).toContain("incremented");
  });

  it("should abort archive but leave streams guarded", async () => {
    await app.do("increment", { stream: "fail1", actor }, { by: 1 });
    await drainAll();

    await expect(
      app.close([
        {
          stream: "fail1",
          archive: () => Promise.reject(new Error("S3 down")),
        },
      ])
    ).rejects.toThrow("S3 down");

    // Stream is guarded (tombstoned) but NOT truncated
    const events: any[] = [];
    await store().query((e) => events.push(e), {
      stream: "fail1",
      stream_exact: true,
    });
    expect(events.filter((e) => e.name === "incremented").length).toBe(1);
    expect(events.filter((e) => e.name === TOMBSTONE_EVENT).length).toBe(1);

    // Writes rejected
    await expect(
      app.do("increment", { stream: "fail1", actor }, { by: 1 })
    ).rejects.toThrow(StreamClosedError);
  });

  it("should skip streams with pending reactions", async () => {
    await app.do("increment", { stream: "pending", actor }, { by: 1 });
    await app.correlate();

    const result = await app.close([{ stream: "pending" }]);

    expect(result.skipped).toEqual(["pending"]);
    expect(result.closed).toEqual([]);
  });

  it("should restart streams with snapshot at version 0", async () => {
    await app.do("increment", { stream: "restart", actor }, { by: 42 });
    await drainAll();

    const result = await app.close([{ stream: "restart", restart: true }]);

    expect(result.closed).toEqual(["restart"]);
    expect(result.restarted).toEqual(["restart"]);

    const snap = await app.load(counter, "restart");
    expect(snap.state.count).toBe(42);
    expect(snap.patches).toBe(0);

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

    const result = await app.close([
      { stream: "sel-a", restart: true },
      { stream: "sel-b" },
    ]);

    expect(result.restarted).toEqual(["sel-a"]);
    expect(result.closed).toEqual(["sel-a", "sel-b"]);

    const snapA = await app.load(counter, "sel-a");
    expect(snapA.state.count).toBe(10);

    await expect(
      app.do("increment", { stream: "sel-b", actor }, { by: 1 })
    ).rejects.toThrow(StreamClosedError);
  });

  it("should be idempotent — closing already-tombstoned streams is a no-op", async () => {
    await app.do("increment", { stream: "idem", actor }, { by: 1 });
    await drainAll();

    const r1 = await app.close([{ stream: "idem" }]);
    expect(r1.closed).toEqual(["idem"]);

    const r2 = await app.close([{ stream: "idem" }]);
    expect(r2.closed).toEqual([]);
    expect(r2.skipped).toEqual([]);
  });

  it("should throw StreamClosedError when writing to tombstoned stream", async () => {
    await app.do("increment", { stream: "tomb", actor }, { by: 1 });
    await drainAll();

    await app.close([{ stream: "tomb" }]);

    await expect(
      app.do("increment", { stream: "tomb", actor }, { by: 1 })
    ).rejects.toThrow(StreamClosedError);
  });

  it("should return empty result for empty targets array", async () => {
    const result = await app.close([]);
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
    await app.close([{ stream: "evt" }]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].closed).toEqual(["evt"]);
    app.off("closed", listener);
  });

  it("should close without archive callback", async () => {
    await app.do("increment", { stream: "noarch", actor }, { by: 7 });
    await drainAll();

    const result = await app.close([{ stream: "noarch" }]);
    expect(result.closed).toEqual(["noarch"]);
    expect(result.truncated).toBeGreaterThan(0);
  });

  it("should invalidate cache for tombstoned streams", async () => {
    await app.do("increment", { stream: "cached", actor }, { by: 5 });
    await app.load(counter, "cached");
    expect(await cache().get("cached")).toBeDefined();
    await drainAll();

    await app.close([{ stream: "cached" }]);
    expect(await cache().get("cached")).toBeUndefined();
  });

  it("should warm cache for restarted streams", async () => {
    await app.do("increment", { stream: "warm", actor }, { by: 5 });
    await drainAll();

    await app.close([{ stream: "warm", restart: true }]);

    const cached = await cache().get<{ count: number }>("warm");
    expect(cached).toBeDefined();
    expect(cached!.state.count).toBe(5);
    expect(cached!.version).toBe(0);
    expect(cached!.snaps).toBe(1);
  });

  it("should handle mixed results — some safe, some skipped", async () => {
    await app.do("increment", { stream: "mix-safe", actor }, { by: 1 });
    await drainAll();

    await app.do("increment", { stream: "mix-pending", actor }, { by: 2 });
    await app.correlate();

    const result = await app.close([
      { stream: "mix-safe" },
      { stream: "mix-pending" },
    ]);

    expect(result.closed).toContain("mix-safe");
    expect(result.skipped).toContain("mix-pending");
  });

  it("should skip streams with concurrent writes (ConcurrencyError on guard)", async () => {
    await app.do("increment", { stream: "race", actor }, { by: 1 });
    await drainAll();

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

    const result = await app.close([{ stream: "race" }]);
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

    const result = await srcApp.close([{ stream: "src-a" }]);
    expect(result.skipped).toEqual(["src-a"]);
    expect(result.closed).toEqual([]);
  });

  it("should handle closing empty stream while reactions exist for other streams", async () => {
    await app.do("increment", { stream: "has-events", actor }, { by: 1 });
    await app.correlate();

    const result = await app.close([
      { stream: "never-existed" },
      { stream: "has-events" },
    ]);

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

    const result = await noStateApp.close([{ stream: "raw-stream" }]);

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

  it("should truncate stream with no existing events", async () => {
    const result = await store().truncate([{ stream: "empty-stream" }]);
    expect(result.get("empty-stream")!.deleted).toBe(0);
    expect(result.get("empty-stream")!.committed.name).toBe(TOMBSTONE_EVENT);
  });

  it("should truncate directly without meta (fallback)", async () => {
    await store().commit("direct-trunc", [{ name: "Evt", data: { x: 1 } }], {
      correlation: "c",
      causation: {},
    });
    const result = await store().truncate([{ stream: "direct-trunc" }]);
    expect(result.get("direct-trunc")!.deleted).toBe(1);
    const events: any[] = [];
    await store().query((e) => events.push(e), {
      stream: "direct-trunc",
      stream_exact: true,
    });
    expect(events[0].name).toBe(TOMBSTONE_EVENT);
    expect(events[0].meta.correlation).toBe("");
  });

  it("should have empty tombstone data for closed streams", async () => {
    await app.do("increment", { stream: "tdata", actor }, { by: 99 });
    await drainAll();

    await app.close([{ stream: "tdata" }]);

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
