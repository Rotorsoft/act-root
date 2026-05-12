// ACT-503: test the sandbox + fixture helpers themselves.
import { z } from "zod";
import { InMemoryCache } from "../src/adapters/in-memory-cache.js";
import { InMemoryStore } from "../src/adapters/in-memory-store.js";
import { act, projection, state } from "../src/index.js";
import { fixture, sandbox } from "../src/test/index.js";

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ by: z.number() }) })
  .patch({ Incremented: (e, s) => ({ count: s.count + e.data.by }) })
  .on({ increment: z.object({ by: z.number() }) })
  .emit((a) => ["Incremented", { by: a.by }])
  .build();

const actor = { id: "a", name: "a" };
const counterBuilder = act().withState(Counter);

describe("sandbox", () => {
  it("returns a wired Act bound to fresh ports", async () => {
    const { app, store, cache, dispose } = await sandbox(counterBuilder);

    expect(store).toBeInstanceOf(InMemoryStore);
    expect(cache).toBeInstanceOf(InMemoryCache);

    await app.do("increment", { stream: "c-1", actor }, { by: 5 });
    const snap = await app.load("Counter", "c-1");
    expect(snap.state.count).toBe(5);

    await dispose();
  });

  it("two sandbox calls produce isolated ports", async () => {
    const a = await sandbox(counterBuilder);
    const b = await sandbox(counterBuilder);

    expect(a.store).not.toBe(b.store);
    expect(a.cache).not.toBe(b.cache);

    await a.app.do("increment", { stream: "x", actor }, { by: 10 });
    await b.app.do("increment", { stream: "x", actor }, { by: 3 });

    expect((await a.app.load("Counter", "x")).state.count).toBe(10);
    expect((await b.app.load("Counter", "x")).state.count).toBe(3);

    await a.dispose();
    await b.dispose();
  });

  it("dispose is idempotent — second call returns the same promise", async () => {
    const { dispose } = await sandbox(counterBuilder);
    const p1 = dispose();
    const p2 = dispose();
    expect(p1).toBe(p2);
    await p1;
  });

  it("custom store/cache factories override the defaults", async () => {
    let storeFactoryCalled = 0;
    let cacheFactoryCalled = 0;
    const { app, dispose } = await sandbox(counterBuilder, {
      store: () => {
        storeFactoryCalled++;
        return new InMemoryStore();
      },
      cache: () => {
        cacheFactoryCalled++;
        return new InMemoryCache();
      },
    });
    expect(storeFactoryCalled).toBe(1);
    expect(cacheFactoryCalled).toBe(1);

    await app.do("increment", { stream: "c-1", actor }, { by: 1 });
    expect((await app.load("Counter", "c-1")).state.count).toBe(1);
    await dispose();
  });

  it("passes through actOptions", async () => {
    const { app, dispose } = await sandbox(counterBuilder, {
      actOptions: { settleDebounceMs: 0 },
    });
    // Just verifying the build accepts the option — exhaustive
    // settleDebounceMs behavior is covered elsewhere.
    expect(app).toBeDefined();
    await dispose();
  });

  it("works with a builder that includes a projection (shared-builder pattern)", async () => {
    let tallyCalls = 0;
    const Tally = projection("tally")
      .on({ Incremented: z.object({ by: z.number() }) })
      .do(async function recordTally() {
        tallyCalls++;
      })
      .build();

    const sharedBuilder = act().withState(Counter).withProjection(Tally);

    const a = await sandbox(sharedBuilder);
    const b = await sandbox(sharedBuilder);

    await a.app.do("increment", { stream: "c-1", actor }, { by: 1 });
    await a.app.correlate();
    await a.app.drain();

    await b.app.do("increment", { stream: "c-1", actor }, { by: 1 });
    await b.app.correlate();
    await b.app.drain();

    // Each tenant's projection ran once — no reaction-name accumulation
    // from the second build.
    expect(tallyCalls).toBe(2);

    await a.dispose();
    await b.dispose();
  });
});

// Fixture-style — concurrent tests prove parallel isolation.
const fxTest = fixture(counterBuilder);

describe("fixture", () => {
  fxTest("hands the test an isolated Act", async ({ app }) => {
    await app.do("increment", { stream: "c-1", actor }, { by: 4 });
    expect((await app.load("Counter", "c-1")).state.count).toBe(4);
  });

  fxTest.concurrent(
    "concurrent invocation A sees only its own data",
    async ({ app }) => {
      await app.do("increment", { stream: "shared", actor }, { by: 10 });
      // A small await to interleave with B
      await new Promise((r) => setTimeout(r, 5));
      expect((await app.load("Counter", "shared")).state.count).toBe(10);
    }
  );

  fxTest.concurrent(
    "concurrent invocation B sees only its own data",
    async ({ app }) => {
      await app.do("increment", { stream: "shared", actor }, { by: 99 });
      await new Promise((r) => setTimeout(r, 5));
      expect((await app.load("Counter", "shared")).state.count).toBe(99);
    }
  );
});
