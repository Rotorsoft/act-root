/**
 * ACT-501: runtime cost of the AsyncLocalStorage overlay on the port
 * getters and the `_scoped` wrap around every public Act method.
 *
 * Three things this benchmark answers:
 *
 * 1. **`store()` getter overhead** — one `scoped.getStore()` read on
 *    every public port lookup, with and without an active scope.
 *    Establishes the per-call tax of the overlay itself.
 *
 * 2. **`app.do()` unscoped vs scoped** — end-to-end action throughput
 *    with the no-op wrap vs the real `scoped.run({store, cache}, fn)`
 *    wrap. Reveals whether the ALS context binding shows up in a real
 *    framework hot path.
 *
 * 3. **`app.load()` unscoped vs scoped** — load is read-heavy and hits
 *    `store()` plus `cache()` multiple times per call. Maximum
 *    exposure to the overlay cost in normal use.
 *
 * Run: pnpm bench:micro libs/act/bench/scope-overhead.micro.bench.ts
 */
import { bench, describe } from "vitest";
import { z } from "zod";
import { InMemoryCache } from "../src/adapters/in-memory-cache.js";
import { InMemoryStore } from "../src/adapters/in-memory-store.js";
import { act } from "../src/builders/act-builder.js";
import { state } from "../src/builders/state-builder.js";
import { cache, scoped, store } from "../src/ports.js";

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ by: z.number() }) })
  .patch({ Incremented: (e, s) => ({ count: s.count + e.data.by }) })
  .on({ increment: z.object({ by: z.number() }) })
  .emit((a) => ["Incremented", { by: a.by }])
  .build();

const actor = { id: "bench", name: "bench" };

// Singleton path: ensure ports are seeded so default Acts have something
// to talk to.
store(new InMemoryStore());

const unscoped = act().withState(Counter).build();

const scopedBag = {
  store: new InMemoryStore(),
  cache: new InMemoryCache(),
};
await scopedBag.store.seed();
const scopedApp = act().withState(Counter).build({ scoped: scopedBag });

let i = 0;
const nextStream = () => `bench-${++i}`;

describe("ports getter (one scoped.getStore() read)", () => {
  bench("store() — no active scope (falls through to singleton)", () => {
    store();
  });

  bench("store() — inside scoped.run() (returns scoped bag)", () => {
    scoped.run(scopedBag, () => {
      store();
    });
  });

  bench("cache() — no active scope", () => {
    cache();
  });

  bench("cache() — inside scoped.run()", () => {
    scoped.run(scopedBag, () => {
      cache();
    });
  });
});

describe("app.do() — wrap cost end-to-end", () => {
  bench(
    "unscoped Act (no-op wrap)",
    async () => {
      await unscoped.do(
        "increment",
        { stream: nextStream(), actor },
        { by: 1 }
      );
    },
    { iterations: 1_000 }
  );

  bench(
    "scoped Act (real scoped.run wrap)",
    async () => {
      await scopedApp.do(
        "increment",
        { stream: nextStream(), actor },
        { by: 1 }
      );
    },
    { iterations: 1_000 }
  );
});

// Pre-seed both apps so the load benches hit a warm stream.
const warmStream = "bench-warm";
await unscoped.do("increment", { stream: warmStream, actor }, { by: 1 });
await scopedApp.do("increment", { stream: warmStream, actor }, { by: 1 });

describe("app.load() — read-heavy path", () => {
  bench(
    "unscoped Act",
    async () => {
      await unscoped.load("Counter", warmStream);
    },
    { iterations: 1_000 }
  );

  bench(
    "scoped Act",
    async () => {
      await scopedApp.load("Counter", warmStream);
    },
    { iterations: 1_000 }
  );
});
