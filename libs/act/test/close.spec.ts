import { z } from "zod";
import {
  act,
  ConcurrencyError,
  cache,
  dispose,
  log,
  SNAP_EVENT,
  StreamClosedError,
  sensitive,
  state,
  store,
  TOMBSTONE_EVENT,
} from "../src/index.js";
import { run_close_cycle } from "../src/internal/close-cycle.js";

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
    let d = await app.drain();
    while (d.acked.length) {
      d = await app.drain();
    }
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

    const { truncated, skipped } = await app.close([
      { stream: "s1" },
      { stream: "s2" },
    ]);

    expect(truncated.size).toBe(2);
    expect(truncated.get("s1")!.deleted).toBeGreaterThan(0);
    expect(truncated.get("s2")!.deleted).toBeGreaterThan(0);
    expect(skipped).toEqual([]);

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
    const { truncated } = await app.close([
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

    expect(truncated.has("arch")).toBe(true);
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

    await expect(
      app.do("increment", { stream: "fail1", actor }, { by: 1 })
    ).rejects.toThrow(StreamClosedError);
  });

  it("should skip streams with pending reactions", async () => {
    await app.do("increment", { stream: "pending", actor }, { by: 1 });
    await app.correlate();

    const { truncated, skipped } = await app.close([{ stream: "pending" }]);

    expect(skipped).toEqual(["pending"]);
    expect(truncated.size).toBe(0);
  });

  it("should restart streams with snapshot at version 0", async () => {
    await app.do("increment", { stream: "restart", actor }, { by: 42 });
    await drainAll();

    const { truncated } = await app.close([
      { stream: "restart", restart: true },
    ]);

    expect(truncated.has("restart")).toBe(true);
    expect(truncated.get("restart")!.committed.name).toBe(SNAP_EVENT);

    const snap = await app.load(counter, "restart");
    expect(snap.state.count).toBe(42);
    expect(snap.patches).toBe(0);
  });

  it("should restart streams using the state that owns each stream's events (multi-state app)", async () => {
    const Order = state({
      Order: z.object({ items: z.array(z.string()), total: z.number() }),
    })
      .init(() => ({ items: [], total: 0 }))
      .emits({
        ItemAdded: z.object({ item: z.string(), price: z.number() }),
      })
      .patch({
        ItemAdded: ({ data }, s) => ({
          items: [...s.items, data.item],
          total: s.total + data.price,
        }),
      })
      .on({ addItem: z.object({ item: z.string(), price: z.number() }) })
      .emit("ItemAdded")
      .build();

    const Inventory = state({
      Inventory: z.object({ stock: z.record(z.string(), z.number()) }),
    })
      .init(() => ({ stock: {} }))
      .emits({ StockSet: z.object({ sku: z.string(), qty: z.number() }) })
      .patch({
        StockSet: ({ data }, s) => ({
          stock: { ...s.stock, [data.sku]: data.qty },
        }),
      })
      .on({ setStock: z.object({ sku: z.string(), qty: z.number() }) })
      .emit("StockSet")
      .build();

    const multiApp = act().withState(Order).withState(Inventory).build();

    await multiApp.do(
      "addItem",
      { stream: "ms-order-1", actor },
      { item: "x", price: 5 }
    );
    await multiApp.do(
      "setStock",
      { stream: "ms-inv-1", actor },
      { sku: "x", qty: 10 }
    );

    // Simulate cold cache (LRU eviction, process restart): close() must
    // replay events from the store through the right state's reducers.
    await cache().clear();

    await multiApp.close([
      { stream: "ms-order-1", restart: true },
      { stream: "ms-inv-1", restart: true },
    ]);

    // Each stream's seed must reflect the state that owns its events
    const orderSnap = await multiApp.load(Order, "ms-order-1");
    expect(orderSnap.state.items).toEqual(["x"]);
    expect(orderSnap.state.total).toBe(5);

    const invSnap = await multiApp.load(Inventory, "ms-inv-1");
    expect(invSnap.state.stock).toEqual({ x: 10 });
  });

  it("should log error and tombstone restart streams whose events have no owning state", async () => {
    // Use an isolated app with no reactions to bypass the safety-check
    // wildcard issue (covered by task #10) — focus this test on seed loading.
    const isolatedApp = act().withState(counter).build();

    // Commit an event under a name that no registered state owns
    await store().commit(
      "orphan",
      [{ name: "UnregisteredEvent", data: { foo: 1 } }],
      { correlation: "test", causation: {} }
    );

    const errSpy = vi.spyOn(log(), "error");

    const { truncated } = await isolatedApp.close([
      { stream: "orphan", restart: true },
    ]);

    // No state owns "UnregisteredEvent" — restart degrades to tombstone
    expect(truncated.get("orphan")!.committed.name).toBe(TOMBSTONE_EVENT);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Cannot seed restart for "orphan": no registered state owns event "UnregisteredEvent"'
      )
    );
    errSpy.mockRestore();
  });

  it("should handle selective restart (some snapshot, some tombstone)", async () => {
    await app.do("increment", { stream: "sel-a", actor }, { by: 10 });
    await app.do("increment", { stream: "sel-b", actor }, { by: 20 });
    await drainAll();

    const { truncated } = await app.close([
      { stream: "sel-a", restart: true },
      { stream: "sel-b" },
    ]);

    expect(truncated.get("sel-a")!.committed.name).toBe(SNAP_EVENT);
    expect(truncated.get("sel-b")!.committed.name).toBe(TOMBSTONE_EVENT);

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
    expect(r1.truncated.has("idem")).toBe(true);

    const r2 = await app.close([{ stream: "idem" }]);
    expect(r2.truncated.size).toBe(0);
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
    const { truncated, skipped } = await app.close([]);
    expect(truncated.size).toBe(0);
    expect(skipped).toEqual([]);
  });

  it("should emit 'closed' lifecycle event", async () => {
    await app.do("increment", { stream: "evt", actor }, { by: 1 });
    await drainAll();

    const listener = vi.fn();
    app.on("closed", listener);
    await app.close([{ stream: "evt" }]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].truncated.has("evt")).toBe(true);
    app.off("closed", listener);
  });

  it("should close without archive callback", async () => {
    await app.do("increment", { stream: "noarch", actor }, { by: 7 });
    await drainAll();

    const { truncated } = await app.close([{ stream: "noarch" }]);
    expect(truncated.get("noarch")!.deleted).toBeGreaterThan(0);
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

    const { truncated } = await app.close([{ stream: "warm", restart: true }]);

    const committed = truncated.get("warm")!.committed;
    const cached = await cache().get<{ count: number }>("warm");
    expect(cached).toBeDefined();
    expect(cached!.state.count).toBe(5);
    expect(cached!.version).toBe(committed.version);
    expect(cached!.event_id).toBe(committed.id);
    expect(cached!.snaps).toBe(1);
  });

  it("should handle mixed results — some safe, some skipped", async () => {
    await app.do("increment", { stream: "mix-safe", actor }, { by: 1 });
    await drainAll();

    await app.do("increment", { stream: "mix-pending", actor }, { by: 2 });
    await app.correlate();

    const { truncated, skipped } = await app.close([
      { stream: "mix-safe" },
      { stream: "mix-pending" },
    ]);

    expect(truncated.has("mix-safe")).toBe(true);
    expect(skipped).toContain("mix-pending");
  });

  it("should detect pending reactions without calling claim() (read-only probe)", async () => {
    // close()'s safety check used to call claim()+ack() on every subscribed
    // stream as a side-effecting probe — claim() bumps retry, ack() resets
    // it to -1, silently destroying retry state of unrelated reactions.
    // The fix is to use query_streams() (read-only).
    await app.do("increment", { stream: "probe-safe", actor }, { by: 1 });
    await drainAll();

    const claimSpy = vi.spyOn(store(), "claim");
    const ackSpy = vi.spyOn(store(), "ack");

    const { truncated } = await app.close([{ stream: "probe-safe" }]);
    expect(truncated.has("probe-safe")).toBe(true);

    expect(claimSpy).not.toHaveBeenCalled();
    expect(ackSpy).not.toHaveBeenCalled();

    claimSpy.mockRestore();
    ackSpy.mockRestore();
  });

  it("should skip streams with concurrent writes (ConcurrencyError on guard)", async () => {
    await app.do("increment", { stream: "race", actor }, { by: 1 });
    await drainAll();

    const originalCommit = store().commit.bind(store());
    vi.spyOn(store(), "commit").mockImplementation(
      async (stream, msgs, meta, expectedVersion) => {
        if (msgs[0]?.name === TOMBSTONE_EVENT && stream === "race") {
          throw new ConcurrencyError(stream, 0, msgs, expectedVersion ?? -1);
        }
        return originalCommit(stream, msgs, meta, expectedVersion);
      }
    );

    const { truncated, skipped } = await app.close([{ stream: "race" }]);
    expect(skipped).toContain("race");
    expect(truncated.size).toBe(0);

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

    const { truncated, skipped } = await srcApp.close([{ stream: "src-a" }]);
    expect(skipped).toEqual(["src-a"]);
    expect(truncated.size).toBe(0);
  });

  it("reuses one compiled regex across subscriptions sharing a source", async () => {
    // Two dynamic targets resolve to the SAME source pattern, so the
    // close-cycle safety probe sees two subscription positions with an
    // identical `source` string — the second hits the compiled-regex
    // cache (`get_regex`) instead of recompiling. Both positions lag the
    // source stream, so it's correctly skipped.
    const sharedApp = act()
      .withState(counter)
      .on("incremented")
      .do(async function fanOut() {
        await Promise.resolve();
      })
      .to((e) => ({ target: `proj-${e.data.by}`, source: "shared-src" }))
      .build();

    await sharedApp.do("increment", { stream: "shared-src", actor }, { by: 1 });
    await sharedApp.do("increment", { stream: "shared-src", actor }, { by: 2 });
    await sharedApp.correlate();

    const { skipped, truncated } = await sharedApp.close([
      { stream: "shared-src" },
    ]);
    expect(skipped).toEqual(["shared-src"]);
    expect(truncated.size).toBe(0);
  });

  it("safety probe paginates past the first page to find lagging reactions", async () => {
    // Two dynamic subscriptions sort onto separate pages (probe_page_size:
    // 1). The page-1 subscription sources from an unrelated stream so it
    // never matches the close target; the lagging page-2 subscription
    // sources from the close target. Only a probe that pages past page 1
    // sees it and skips the close.
    const pagedApp = act()
      .withState(counter)
      .on("incremented")
      .do(async function fanOut() {
        await Promise.resolve();
      })
      .to((e) =>
        e.data.by === 1
          ? { target: "a-unrelated", source: "other-src" }
          : { target: "z-lagging", source: "paged-src" }
      )
      .build();

    await pagedApp.do("increment", { stream: "paged-src", actor }, { by: 1 });
    await pagedApp.do("increment", { stream: "paged-src", actor }, { by: 2 });
    await pagedApp.correlate();

    const a = pagedApp as unknown as Record<string, unknown>;
    const reactive = a._reactive_events as { size: number };
    const es = a._es as Record<string, never>;
    const result = await run_close_cycle([{ stream: "paged-src" }], {
      reactive_events_size: reactive.size,
      event_to_state: a._event_to_state as never,
      load: es.load,
      tombstone: es.tombstone,
      logger: a._logger as never,
      correlation: "probe-pagination-test",
      probe_page_size: 1,
    });

    expect(result.skipped).toEqual(["paged-src"]);
    expect(result.truncated.size).toBe(0);
  });

  it("should handle closing empty stream while reactions exist for other streams", async () => {
    await app.do("increment", { stream: "has-events", actor }, { by: 1 });
    await app.correlate();

    const { truncated, skipped } = await app.close([
      { stream: "never-existed" },
      { stream: "has-events" },
    ]);

    expect(truncated.size).toBe(0);
    expect(skipped).toEqual(["has-events"]);
  });

  it("should close streams on an app with no registered states", async () => {
    await store().drop();
    const noStateApp = act().build();

    await store().commit(
      "raw-stream",
      [{ name: "SomeEvent", data: { x: 1 } }],
      { correlation: "c1", causation: {} }
    );

    const { truncated } = await noStateApp.close([{ stream: "raw-stream" }]);

    expect(truncated.has("raw-stream")).toBe(true);
    expect(truncated.get("raw-stream")!.committed.name).toBe(TOMBSTONE_EVENT);
    expect(truncated.get("raw-stream")!.committed.data).toEqual({});
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
    expect(result.get("direct-trunc")!.committed.meta.correlation).toBe("");
  });

  it("should have empty tombstone data for closed streams", async () => {
    await app.do("increment", { stream: "tdata", actor }, { by: 99 });
    await drainAll();

    const { truncated } = await app.close([{ stream: "tdata" }]);
    expect(truncated.get("tdata")!.committed.data).toEqual({});
  });
});

describe("close restart on a sensitive-bearing state", () => {
  const actor = { id: "a", name: "a" };

  const Person = state({
    Person: z.object({ email: z.string(), n: z.number() }),
  })
    .init(() => ({ email: "", n: 0 }))
    .emits({
      registered: z.object({ email: sensitive(z.string()), n: z.number() }),
    })
    .patch({ registered: ({ data }) => ({ email: data.email, n: data.n }) })
    .on({ register: z.object({ email: sensitive(z.string()), n: z.number() }) })
    .emit((p) => ["registered", p])
    .discloses(() => true)
    .build();

  afterEach(async () => {
    await dispose()();
  });

  // The seed load is actorless, so every sensitive field folds to the
  // redaction sentinel — and the truncate then deletes the real events and
  // their pii sidecars, so the originals are unrecoverable. Loading the seed
  // privileged instead would write plaintext into __snapshot__.data, which
  // forget_pii cannot reach — the very thing the build guard on .snap()
  // prevents. A pii-aware state cannot be restarted at all.
  it("refuses the close entirely rather than tombstoning", async () => {
    const pii_app = act().withState(Person).build();
    await pii_app.do(
      "register",
      { stream: "p1", actor },
      { email: "a@b.com", n: 1 }
    );

    const before = await pii_app.load(Person, { stream: "p1", actor });
    expect(before.state.email).toBe("a@b.com");

    const result = await pii_app.close([{ stream: "p1", restart: true }]);

    // Nothing was closed, nothing was written: the caller asked to keep
    // the aggregate alive, and tombstoning it instead would be strictly
    // more destructive than what was requested.
    expect([...result.truncated.keys()]).toEqual([]);
    expect(result.skipped).toContain("p1");

    const names: string[] = [];
    await store().query((e) => names.push(String(e.name)), {
      stream: "p1",
      with_snaps: true,
    });
    expect(names).not.toContain(SNAP_EVENT);
    expect(names).not.toContain(TOMBSTONE_EVENT);

    // The stream is untouched — plaintext intact and still writable.
    const after = await pii_app.load(Person, { stream: "p1", actor });
    expect(after.state.email).toBe("a@b.com");
    await pii_app.do(
      "register",
      { stream: "p1", actor },
      { email: "c@d.com", n: 2 }
    );

    await pii_app.shutdown();
  });

  it("closes without restart normally", async () => {
    const pii_app = act().withState(Person).build();
    await pii_app.do(
      "register",
      { stream: "p2", actor },
      { email: "a@b.com", n: 1 }
    );

    const result = await pii_app.close([{ stream: "p2" }]);
    expect([...result.truncated.keys()]).toEqual(["p2"]);

    const names: string[] = [];
    await store().query((e) => names.push(String(e.name)), { stream: "p2" });
    expect(names).toEqual([TOMBSTONE_EVENT]);

    await pii_app.shutdown();
  });

  it("ignores a restart target for a stream with no events", async () => {
    const pii_app = act().withState(Person).build();
    // No stream_info entry exists for an empty stream, so the pii check
    // has nothing to inspect — it must not throw.
    const result = await pii_app.close([{ stream: "ghost", restart: true }]);
    expect([...result.truncated.keys()]).toEqual([]);
    await pii_app.shutdown();
  });
});

describe("close and reaction subscriptions (#1398)", () => {
  const sub_actor = { id: "a", name: "a" };
  let seen: string[] = [];

  const Thing = state({ Thing: z.object({ n: z.number() }) })
    .init(() => ({ n: 0 }))
    .emits({ Bumped: z.object({}) })
    .patch({ Bumped: (_e, s) => ({ n: s.n + 1 }) })
    .on({ bump: z.object({}) })
    .emit(() => ["Bumped", {}])
    .build();

  // The subscriptions table is keyed by TARGET; truncate deleted by event
  // STREAM name. The documented per-aggregate shape makes those namespaces
  // collide, so closing a stream silently killed its own reaction — no
  // block, no error, nothing in blocked_streams.
  const build_app = () =>
    act()
      .withState(Thing)
      .on("Bumped")
      .do(async function react(event) {
        seen.push(`${event.stream}#${event.id}`);
      })
      .to((event) => ({ target: event.stream }))
      .build();

  afterEach(async () => {
    await dispose()();
  });

  it("keeps delivering to a restarted stream's per-aggregate reaction", async () => {
    seen = [];
    const app = build_app();

    await app.do("bump", { stream: "R", actor: sub_actor }, {});
    await app.do("bump", { stream: "C", actor: sub_actor }, {});
    await app.correlate();
    await app.drain();

    await app.close([{ stream: "R", restart: true }]);

    await app.do("bump", { stream: "R", actor: sub_actor }, {});
    await app.do("bump", { stream: "C", actor: sub_actor }, {});
    await app.correlate();
    await app.drain();
    await app.correlate();
    await app.drain();

    const onR = seen.filter((s) => s.startsWith("R#")).length;
    const onC = seen.filter((s) => s.startsWith("C#")).length;
    expect(onC).toBe(2); // control
    expect(onR).toBe(2); // restarted stream keeps working
    await app.shutdown();
  });

  it("re-subscribes a fully-closed stream when it sees new activity", async () => {
    seen = [];
    const app = build_app();

    await app.do("bump", { stream: "F", actor: sub_actor }, {});
    await app.correlate();
    await app.drain();
    expect(seen.filter((s) => s.startsWith("F#")).length).toBe(1);

    // A full close retires the stream and drops its subscription row —
    // correct. The in-process dedup must forget it too, or a later
    // re-opened stream of the same name never gets a subscription.
    await app.close([{ stream: "F" }]);

    await app.do("bump", { stream: "F2", actor: sub_actor }, {});
    await app.correlate();
    await app.drain();
    expect(seen.filter((s) => s.startsWith("F2#")).length).toBe(1);
    await app.shutdown();
  });

  // Static targets are subscribed once by init() and recorded at +Infinity
  // so the dynamic path never re-opens them. Evicting one from the dedup
  // would achieve nothing — correlate only re-subscribes dynamic
  // resolutions — so `forget_subscribed` deliberately skips them, and a
  // full close retires the target as asked.
  it("retires a static reaction target on a full close", async () => {
    const hits: string[] = [];
    const app = act()
      .withState(Thing)
      .on("Bumped")
      .do(async function react(event) {
        hits.push(`${event.stream}#${event.id}`);
      })
      // Target IS the source stream, so it carries events and is closable.
      .to("SS")
      .build();

    await app.do("bump", { stream: "SS", actor: sub_actor }, {});
    await app.correlate();
    await app.drain();
    expect(hits.length).toBe(1);

    const result = await app.close([{ stream: "SS" }]);
    expect([...result.truncated.keys()]).toContain("SS");

    const rows: string[] = [];
    await store().query_streams((p) => rows.push(p.stream), { limit: 100 });
    expect(rows).not.toContain("SS");
    await app.shutdown();
  });
});
