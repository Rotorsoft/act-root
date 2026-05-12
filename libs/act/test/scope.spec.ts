// ACT-501: per-Act scoped ports via `ActOptions.scoped` — bag is threaded
// through AsyncLocalStorage so internal `store()`/`cache()` resolve to the
// per-Act ports transparently. Adapters are unchanged.
import { z } from "zod";
import { InMemoryCache } from "../src/adapters/in-memory-cache.js";
import { InMemoryStore } from "../src/adapters/in-memory-store.js";
import { act, dispose, projection, state, store } from "../src/index.js";

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

describe("scoped ports (ACT-501)", () => {
  beforeEach(async () => {
    await store().drop();
  });

  afterAll(async () => {
    await dispose()();
  });

  it("two Acts with their own scoped ports — no cross-talk", async () => {
    const storeA = new InMemoryStore();
    const storeB = new InMemoryStore();
    const cacheA = new InMemoryCache();
    const cacheB = new InMemoryCache();
    await storeA.seed();
    await storeB.seed();

    const tenantA = act()
      .withState(Counter)
      .build({ scoped: { store: storeA, cache: cacheA } });
    const tenantB = act()
      .withState(Counter)
      .build({ scoped: { store: storeB, cache: cacheB } });

    await tenantA.do("increment", { stream: "c-1", actor }, { by: 10 });
    await tenantB.do("increment", { stream: "c-1", actor }, { by: 3 });

    const a = await tenantA.load("Counter", "c-1");
    const b = await tenantB.load("Counter", "c-1");

    expect(a.state.count).toBe(10);
    expect(b.state.count).toBe(3);

    const eventsA = await tenantA.query_array({ stream: "c-1" });
    const eventsB = await tenantB.query_array({ stream: "c-1" });
    expect(eventsA).toHaveLength(1);
    expect(eventsB).toHaveLength(1);
    expect((eventsA[0].data as { by: number }).by).toBe(10);
    expect((eventsB[0].data as { by: number }).by).toBe(3);

    await storeA.dispose();
    await storeB.dispose();
    await cacheA.dispose();
    await cacheB.dispose();
  });

  it("default Act uses the singletons (backward compat)", async () => {
    const app = act().withState(Counter).build();
    await app.do("increment", { stream: "c-1", actor }, { by: 5 });

    const snap = await app.load("Counter", "c-1");
    expect(snap.state.count).toBe(5);

    const events: unknown[] = [];
    await store().query((e) => events.push(e), { stream: "c-1" });
    expect(events).toHaveLength(1);
  });

  it("scoped cache keeps per-Act snapshots isolated", async () => {
    const storeA = new InMemoryStore();
    const storeB = new InMemoryStore();
    const cacheA = new InMemoryCache();
    const cacheB = new InMemoryCache();
    await storeA.seed();
    await storeB.seed();

    const a = act()
      .withState(Counter)
      .build({ scoped: { store: storeA, cache: cacheA } });
    const b = act()
      .withState(Counter)
      .build({ scoped: { store: storeB, cache: cacheB } });

    await a.do("increment", { stream: "c-1", actor }, { by: 100 });
    await b.do("increment", { stream: "c-1", actor }, { by: 7 });

    expect((await a.load("Counter", "c-1")).state.count).toBe(100);
    expect((await b.load("Counter", "c-1")).state.count).toBe(7);

    await storeA.dispose();
    await storeB.dispose();
    await cacheA.dispose();
    await cacheB.dispose();
  });

  it("invalidates the scoped cache on concurrency error", async () => {
    const tenantStore = new InMemoryStore();
    const tenantCache = new InMemoryCache();
    await tenantStore.seed();
    const tenant = act()
      .withState(Counter)
      .build({ scoped: { store: tenantStore, cache: tenantCache } });

    await tenant.do("increment", { stream: "race-1", actor }, { by: 1 });

    // Force a concurrency conflict via stale expectedVersion.
    await expect(
      tenant.do(
        "increment",
        { stream: "race-1", actor, expectedVersion: -1 },
        { by: 99 }
      )
    ).rejects.toThrow();

    const after = await tenant.load("Counter", "race-1");
    expect(after.state.count).toBe(1);

    await tenantStore.dispose();
    await tenantCache.dispose();
  });

  it("interleaved concurrent calls keep their own scopes", async () => {
    // ALS guarantees: a Promise spawned inside scoped.run() keeps its
    // bag across every await it encounters, regardless of what other
    // scopes are running concurrently. This is the property that makes
    // the design useful for multi-tenant work in one process.
    const storeA = new InMemoryStore();
    const storeB = new InMemoryStore();
    const cacheA = new InMemoryCache();
    const cacheB = new InMemoryCache();
    await storeA.seed();
    await storeB.seed();

    const tenantA = act()
      .withState(Counter)
      .build({ scoped: { store: storeA, cache: cacheA } });
    const tenantB = act()
      .withState(Counter)
      .build({ scoped: { store: storeB, cache: cacheB } });

    // Fire interleaved actions across both tenants in flight at once,
    // using a unique stream per call so the test isolates ALS context
    // propagation from optimistic-concurrency collisions on a shared
    // stream.
    const work: Promise<unknown>[] = [];
    for (let i = 0; i < 50; i++) {
      work.push(
        tenantA.do("increment", { stream: `a-${i}`, actor }, { by: 1 })
      );
      work.push(
        tenantB.do("increment", { stream: `b-${i}`, actor }, { by: 2 })
      );
    }
    await Promise.all(work);

    let sumA = 0;
    let sumB = 0;
    for (let i = 0; i < 50; i++) {
      sumA += (await tenantA.load("Counter", `a-${i}`)).state.count;
      sumB += (await tenantB.load("Counter", `b-${i}`)).state.count;
    }
    expect(sumA).toBe(50);
    expect(sumB).toBe(100);

    // Cross-leak check: tenantA's streams must NOT show up in tenantB's
    // store, and vice versa. If ALS leaked, the wrong store would be
    // committed against.
    expect(
      (await tenantA.query_array({ stream: "b-0", stream_exact: true })).length
    ).toBe(0);
    expect(
      (await tenantB.query_array({ stream: "a-0", stream_exact: true })).length
    ).toBe(0);

    await storeA.dispose();
    await storeB.dispose();
    await cacheA.dispose();
    await cacheB.dispose();
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

    const tenantStore = new InMemoryStore();
    const tenantCache = new InMemoryCache();
    await tenantStore.seed();

    const tenant = act()
      .withState(Source)
      .withState(Mirror)
      .on("Sourced")
      .do(async function reflect(event, _stream, app) {
        await app.do(
          "mirror",
          { stream: "mirror-1", actor },
          { n: event.data.n }
        );
      })
      .to(() => ({ target: "mirror-1" }))
      .build({ scoped: { store: tenantStore, cache: tenantCache } });

    await tenant.do("source", { stream: "source-1", actor }, { n: 7 });
    await tenant.correlate();
    await tenant.drain();

    // Both the source AND the mirror event must live in the scoped store
    // — never in the singleton.
    const mirror = await tenant.load("Mirror", "mirror-1");
    expect(mirror.state.n).toBe(7);

    // The singleton store stays empty for these streams.
    const singletonEvents: unknown[] = [];
    await store().query((e) => singletonEvents.push(e), {
      stream: "mirror-1",
    });
    expect(singletonEvents).toHaveLength(0);

    await tenantStore.dispose();
    await tenantCache.dispose();
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

    const tenantStore = new InMemoryStore();
    const tenantCache = new InMemoryCache();
    await tenantStore.seed();

    const tenant = act()
      .withState(Source)
      .withState(Mirror)
      .on("Sourced")
      .do(async function reflect(event, _stream, app) {
        await app.do(
          "mirror",
          { stream: "mirror-1", actor },
          { n: event.data.n }
        );
      })
      .to(() => ({ target: "mirror-1" }))
      .build({ scoped: { store: tenantStore, cache: tenantCache } });

    const settled = new Promise<void>((resolve) =>
      tenant.on("settled", () => resolve())
    );

    await tenant.do("source", { stream: "source-1", actor }, { n: 11 });
    tenant.settle({ debounceMs: 0 });
    await settled;

    const mirror = await tenant.load("Mirror", "mirror-1");
    expect(mirror.state.n).toBe(11);

    tenant.stop_settling();
    await tenantStore.dispose();
    await tenantCache.dispose();
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
    // If `mergeProjection` ran a second time on the shared registry,
    // we'd see a `_p`-suffixed duplicate key after the second build().
    const firstReactionCount =
      tenantBuilder.events.Incremented?.reactions.size ?? 0;

    const tenants = ["t1", "t2", "t3"];
    const apps = new Map<string, ReturnType<typeof tenantBuilder.build>>();
    const stores: InMemoryStore[] = [];
    const caches: InMemoryCache[] = [];
    for (const t of tenants) {
      const s = new InMemoryStore();
      const c = new InMemoryCache();
      await s.seed();
      stores.push(s);
      caches.push(c);
      apps.set(t, tenantBuilder.build({ scoped: { store: s, cache: c } }));
    }

    // No reaction accumulation after N builds.
    expect(tenantBuilder.events.Incremented?.reactions.size).toBe(
      firstReactionCount
    );
    for (const key of tenantBuilder.events.Incremented!.reactions.keys()) {
      expect(key).not.toMatch(/_p(_p)*$/);
    }

    // Each tenant works against its own ports.
    for (const [t, app] of apps) {
      await app.do(
        "increment",
        { stream: `${t}-counter`, actor },
        { by: tenants.indexOf(t) + 1 }
      );
      await app.correlate();
      await app.drain();
      const snap = await app.load("Counter", `${t}-counter`);
      expect(snap.state.count).toBe(tenants.indexOf(t) + 1);
    }

    // Projection fired exactly once per tenant commit — proving the
    // merged-once reaction is what's running (not a duplicated stack).
    expect(invocations).toBe(tenants.length);

    for (const s of stores) await s.dispose();
    for (const c of caches) await c.dispose();
  });
});
