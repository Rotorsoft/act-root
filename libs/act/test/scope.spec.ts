// ACT-501: per-Act scoped ports via `ActOptions.scoped` — bag is threaded
// through AsyncLocalStorage so internal `store()`/`cache()` resolve to the
// per-Act ports transparently. Adapters are unchanged.
import { z } from "zod";
import { act, dispose, projection, state, store } from "../src/index.js";
import { fixture, sandbox } from "../src/test/index.js";

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ by: z.number() }) })
  .patch({
    Incremented: (event, s) => ({ count: s.count + event.data.by }),
  })
  .on({ increment: z.object({ by: z.number() }) })
  .emit((a) => ["Incremented", { by: a.by }])
  .build();

const actor = { id: "a", name: "a" };
const counterBuilder = act().withState(Counter);

const counterTest = fixture(counterBuilder);

describe("scoped ports (ACT-501)", () => {
  it("two Acts with their own scoped ports — no cross-talk", async () => {
    const a = await sandbox(counterBuilder);
    const b = await sandbox(counterBuilder);

    await a.app.do("increment", { stream: "c-1", actor }, { by: 10 });
    await b.app.do("increment", { stream: "c-1", actor }, { by: 3 });

    expect((await a.app.load("Counter", "c-1")).state.count).toBe(10);
    expect((await b.app.load("Counter", "c-1")).state.count).toBe(3);

    const eventsA = await a.app.query_array({ stream: "c-1" });
    const eventsB = await b.app.query_array({ stream: "c-1" });
    expect(eventsA).toHaveLength(1);
    expect(eventsB).toHaveLength(1);
    expect((eventsA[0].data as { by: number }).by).toBe(10);
    expect((eventsB[0].data as { by: number }).by).toBe(3);

    await a.dispose();
    await b.dispose();
  });

  it("scoped cache keeps per-Act snapshots isolated", async () => {
    const a = await sandbox(counterBuilder);
    const b = await sandbox(counterBuilder);

    await a.app.do("increment", { stream: "c-1", actor }, { by: 100 });
    await b.app.do("increment", { stream: "c-1", actor }, { by: 7 });

    expect((await a.app.load("Counter", "c-1")).state.count).toBe(100);
    expect((await b.app.load("Counter", "c-1")).state.count).toBe(7);

    await a.dispose();
    await b.dispose();
  });

  counterTest(
    "invalidates the scoped cache on concurrency error",
    async ({ app }) => {
      await app.do("increment", { stream: "race-1", actor }, { by: 1 });

      // Force a concurrency conflict via stale expectedVersion.
      await expect(
        app.do(
          "increment",
          { stream: "race-1", actor, expectedVersion: -1 },
          { by: 99 }
        )
      ).rejects.toThrow();

      // Cache invalidated cleanly — subsequent load returns post-commit
      // state.
      const after = await app.load("Counter", "race-1");
      expect(after.state.count).toBe(1);
    }
  );

  it("interleaved concurrent calls keep their own scopes", async () => {
    // ALS guarantees: a Promise spawned inside scoped.run() keeps its
    // bag across every await it encounters, regardless of what other
    // scopes are running concurrently. This is the property that makes
    // the design useful for multi-tenant work in one process.
    const a = await sandbox(counterBuilder);
    const b = await sandbox(counterBuilder);

    // Fire interleaved actions across both tenants in flight at once,
    // using a unique stream per call so the test isolates ALS context
    // propagation from optimistic-concurrency collisions on a shared
    // stream.
    const work: Promise<unknown>[] = [];
    for (let i = 0; i < 50; i++) {
      work.push(a.app.do("increment", { stream: `a-${i}`, actor }, { by: 1 }));
      work.push(b.app.do("increment", { stream: `b-${i}`, actor }, { by: 2 }));
    }
    await Promise.all(work);

    let sumA = 0;
    let sumB = 0;
    for (let i = 0; i < 50; i++) {
      sumA += (await a.app.load("Counter", `a-${i}`)).state.count;
      sumB += (await b.app.load("Counter", `b-${i}`)).state.count;
    }
    expect(sumA).toBe(50);
    expect(sumB).toBe(100);

    // Cross-leak check: a's streams must NOT show up in b's store, and
    // vice versa. If ALS leaked, the wrong store would be committed
    // against.
    expect(
      (await a.app.query_array({ stream: "b-0", stream_exact: true })).length
    ).toBe(0);
    expect(
      (await b.app.query_array({ stream: "a-0", stream_exact: true })).length
    ).toBe(0);

    await a.dispose();
    await b.dispose();
  });

  it("reactions inside a scoped Act commit to the scoped store", async () => {
    // A reaction handler that calls `app.do(...)` should write to the
    // scoped store — the inner `do` is wrapped by `_scoped` too, so
    // the bag stays bound across the reaction chain.
    const Source = state({ Source: z.object({ n: z.number() }) })
      .init(() => ({ n: 0 }))
      .emits({ Sourced: z.object({ n: z.number() }) })
      .patch({ Sourced: (e, s) => ({ n: s.n + e.data.n }) })
      .on({ source: z.object({ n: z.number() }) })
      .emit((a) => ["Sourced", { n: a.n }])
      .build();

    const Mirror = state({ Mirror: z.object({ n: z.number() }) })
      .init(() => ({ n: 0 }))
      .emits({ Mirrored: z.object({ n: z.number() }) })
      .patch({ Mirrored: (e, s) => ({ n: s.n + e.data.n }) })
      .on({ mirror: z.object({ n: z.number() }) })
      .emit((a) => ["Mirrored", { n: a.n }])
      .build();

    const reflectBuilder = act()
      .withState(Source)
      .withState(Mirror)
      .on("Sourced")
      .do(async function reflect(event, _stream, a) {
        await a.do(
          "mirror",
          { stream: "mirror-1", actor },
          { n: event.data.n }
        );
      })
      .to(() => ({ target: "mirror-1" }));

    const { app, dispose } = await sandbox(reflectBuilder);

    await app.do("source", { stream: "source-1", actor }, { n: 7 });
    await app.correlate();
    await app.drain();

    const mirror = await app.load("Mirror", "mirror-1");
    expect(mirror.state.n).toBe(7);

    // The singleton store stays empty for these streams.
    const singletonEvents: unknown[] = [];
    await store().query((e) => singletonEvents.push(e), {
      stream: "mirror-1",
    });
    expect(singletonEvents).toHaveLength(0);

    await dispose();
  });

  it("settle() preserves the scope across the setTimeout boundary", async () => {
    // settle() schedules its work through setTimeout. AsyncLocalStorage
    // carries the bag across timers automatically — but only because
    // schedule() is called from inside the scoped wrap. This regression
    // test pins that contract.
    const Source = state({ Source: z.object({ n: z.number() }) })
      .init(() => ({ n: 0 }))
      .emits({ Sourced: z.object({ n: z.number() }) })
      .patch({ Sourced: (e, s) => ({ n: s.n + e.data.n }) })
      .on({ source: z.object({ n: z.number() }) })
      .emit((a) => ["Sourced", { n: a.n }])
      .build();

    const Mirror = state({ Mirror: z.object({ n: z.number() }) })
      .init(() => ({ n: 0 }))
      .emits({ Mirrored: z.object({ n: z.number() }) })
      .patch({ Mirrored: (e, s) => ({ n: s.n + e.data.n }) })
      .on({ mirror: z.object({ n: z.number() }) })
      .emit((a) => ["Mirrored", { n: a.n }])
      .build();

    const settleBuilder = act()
      .withState(Source)
      .withState(Mirror)
      .on("Sourced")
      .do(async function reflectSettle(event, _stream, a) {
        await a.do(
          "mirror",
          { stream: "mirror-1", actor },
          { n: event.data.n }
        );
      })
      .to(() => ({ target: "mirror-1" }));

    const { app, dispose } = await sandbox(settleBuilder);

    const settled = new Promise<void>((resolve) =>
      app.on("settled", () => resolve())
    );

    await app.do("source", { stream: "source-1", actor }, { n: 11 });
    app.settle({ debounceMs: 0 });
    await settled;

    const mirror = await app.load("Mirror", "mirror-1");
    expect(mirror.state.n).toBe(11);

    await dispose();
  });

  it("settle() subscribes static targets on the scoped store, not the singleton (ACT-1191)", async () => {
    // A static `.to("stream")` target is subscribed during correlate
    // init. That init ran outside `_scoped`, so `store().subscribe(...)`
    // resolved to the singleton — the scoped store never learned about
    // the static target. Assert the subscription lands on the scoped
    // store and the singleton stays untouched.
    const Src = state({ Src: z.object({ n: z.number() }) })
      .init(() => ({ n: 0 }))
      .emits({ Fired: z.object({ n: z.number() }) })
      .patch({ Fired: (e, s) => ({ n: s.n + e.data.n }) })
      .on({ fire: z.object({ n: z.number() }) })
      .emit((a) => ["Fired", { n: a.n }])
      .build();

    const staticBuilder = act()
      .withState(Src)
      .on("Fired")
      .do(async function noop() {
        // static target only needs to be subscribed, not handled
      })
      .to("react-target");

    // Singleton starts empty and must stay that way.
    await store().drop();

    const { app, store: scoped, dispose } = await sandbox(staticBuilder);

    const settled = new Promise<void>((resolve) =>
      app.on("settled", () => resolve())
    );
    app.settle({ debounceMs: 0 });
    await settled;

    const scoped_streams: string[] = [];
    await scoped.query_streams((p) => scoped_streams.push(p.stream));

    const singleton_streams: string[] = [];
    await store().query_streams((p) => singleton_streams.push(p.stream));

    // The static target must be subscribed on the scoped store.
    expect(scoped_streams).toContain("react-target");
    // The singleton must never have seen it.
    expect(singleton_streams).not.toContain("react-target");

    await dispose();
  });

  it("start_correlations polls against the scoped store, not the singleton (ACT-1191)", async () => {
    // The periodic correlation worker fires its correlate outside any
    // caller frame. Pre-fix it resolved `store()` to the singleton, so a
    // scoped Act's static targets were subscribed on the wrong store.
    const Src = state({ Src: z.object({ n: z.number() }) })
      .init(() => ({ n: 0 }))
      .emits({ Fired: z.object({ n: z.number() }) })
      .patch({ Fired: (e, s) => ({ n: s.n + e.data.n }) })
      .on({ fire: z.object({ n: z.number() }) })
      .emit((a) => ["Fired", { n: a.n }])
      .build();

    const pollBuilder = act()
      .withState(Src)
      .on("Fired")
      .do(async function noop() {})
      .to("poll-target");

    await store().drop();

    const { app, store: scoped, dispose } = await sandbox(pollBuilder);

    app.start_correlations({}, 5);
    // Let the polling timer fire a few times.
    await new Promise<void>((r) => setTimeout(r, 40));
    app.stop_correlations();

    const scoped_streams: string[] = [];
    await scoped.query_streams((p) => scoped_streams.push(p.stream));
    const singleton_streams: string[] = [];
    await store().query_streams((p) => singleton_streams.push(p.stream));

    expect(scoped_streams).toContain("poll-target");
    expect(singleton_streams).not.toContain("poll-target");

    await dispose();
  });

  it("lane worker ticks drain against the scoped store, not the singleton (ACT-1191)", async () => {
    // A `withLane({cycleMs})` auto-starts a per-lane worker whose tick
    // calls drain() outside any caller frame. Pre-fix that drain claimed
    // on the singleton, so a scoped commit was never picked up and the
    // reaction target never landed on the scoped store.
    const Src = state({ Src: z.object({ n: z.number() }) })
      .init(() => ({ n: 0 }))
      .emits({ Fired: z.object({ n: z.number() }) })
      .patch({ Fired: (e, s) => ({ n: s.n + e.data.n }) })
      .on({ fire: z.object({ n: z.number() }) })
      .emit((a) => ["Fired", { n: a.n }])
      .build();

    const Out = state({ Out: z.object({ n: z.number() }) })
      .init(() => ({ n: 0 }))
      .emits({ Landed: z.object({ n: z.number() }) })
      .patch({ Landed: (e, s) => ({ n: s.n + e.data.n }) })
      .on({ land: z.object({ n: z.number() }) })
      .emit((a) => ["Landed", { n: a.n }])
      .build();

    const laneBuilder = act()
      .withState(Src)
      .withState(Out)
      .withLane({ name: "fast", cycleMs: 5, leaseMillis: 100 })
      .on("Fired")
      .do(async function land(event, _stream, a) {
        await a.do("land", { stream: "lane-out", actor }, { n: event.data.n });
      })
      .to({ target: "lane-out", lane: "fast" });

    await store().drop();

    const { app, dispose } = await sandbox(laneBuilder);

    // Scoped commit — lands on the scoped store.
    await app.do("fire", { stream: "src-1", actor }, { n: 4 });
    // Correlate (scoped) arms the fast controller; the auto-started
    // worker tick must drain against the scoped store.
    await app.correlate();
    await new Promise<void>((r) => setTimeout(r, 60));

    // The reaction target must have been written on the scoped store.
    const out = await app.load("Out", "lane-out");
    expect(out.state.n).toBe(4);

    // And the singleton must stay empty for that stream.
    const singleton_events: unknown[] = [];
    await store().query((e) => singleton_events.push(e), {
      stream: "lane-out",
    });
    expect(singleton_events).toHaveLength(0);

    await dispose();
  });

  it("one builder, N tenants — build() is reusable", async () => {
    // The intended ergonomic pattern for multi-tenant / A-B-testing
    // setups: hold the builder in a constant (no `.build()` yet), then
    // call `.build({ scoped: ... })` once per tenant. The first call
    // does the one-time projection merge + deprecation scan; subsequent
    // calls reuse the merged registry. No reaction-name accumulation,
    // no duplicate startup log lines.
    let invocations = 0;
    const Tally = projection("tally")
      .on({ Incremented: z.object({ by: z.number() }) })
      .do(async function recordTally(_event) {
        invocations++;
      })
      .build();

    const tenantBuilder = act().withState(Counter).withProjection(Tally);

    // The projection registers exactly one reaction for `Incremented`.
    // If `merge_projection` ran a second time on the shared registry,
    // we'd see a `_p`-suffixed duplicate key after the second build().
    const firstReactionCount =
      tenantBuilder.events.Incremented?.reactions.size ?? 0;

    const tenants = ["t1", "t2", "t3"];
    type TenantApp = ReturnType<typeof tenantBuilder.build>;
    const ctxs = new Map<
      string,
      Awaited<ReturnType<typeof sandbox<TenantApp>>>
    >();
    for (const t of tenants) {
      ctxs.set(t, await sandbox(tenantBuilder));
    }

    // No reaction accumulation after N builds.
    expect(tenantBuilder.events.Incremented?.reactions.size).toBe(
      firstReactionCount
    );
    for (const key of tenantBuilder.events.Incremented!.reactions.keys()) {
      expect(key).not.toMatch(/_p(_p)*$/);
    }

    // Each tenant works against its own ports.
    for (const [t, ctx] of ctxs) {
      await ctx.app.do(
        "increment",
        { stream: `${t}-counter`, actor },
        { by: tenants.indexOf(t) + 1 }
      );
      await ctx.app.correlate();
      await ctx.app.drain();
      const snap = await ctx.app.load("Counter", `${t}-counter`);
      expect(snap.state.count).toBe(tenants.indexOf(t) + 1);
    }

    // Projection fired exactly once per tenant commit — proving the
    // merged-once reaction is what's running (not a duplicated stack).
    expect(invocations).toBe(tenants.length);

    for (const ctx of ctxs.values()) await ctx.dispose();
  });
});

describe("ACT-501 singleton backward compat", () => {
  // Intentionally touches the singleton — verifies the unscoped path
  // still routes through `store()` / `cache()` and that the
  // `store(adapter)` injection flow remains valid for existing apps.
  beforeEach(async () => {
    await store().drop();
  });

  afterAll(async () => {
    await dispose()();
  });

  it("default Act uses the singletons", async () => {
    const app = act().withState(Counter).build();
    await app.do("increment", { stream: "c-1", actor }, { by: 5 });

    const snap = await app.load("Counter", "c-1");
    expect(snap.state.count).toBe(5);

    const events: unknown[] = [];
    await store().query((e) => events.push(e), { stream: "c-1" });
    expect(events).toHaveLength(1);
  });
});
