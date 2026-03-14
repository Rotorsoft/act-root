import { bench, describe } from "vitest";
import { z } from "zod";
import { InMemoryCache } from "../../act/src/adapters/InMemoryCache.js";
import { action, load } from "../../act/src/event-sourcing.js";
import { cache, dispose, store } from "../../act/src/ports.js";
import { state } from "../../act/src/state-builder.js";
import { PostgresStore } from "../src/PostgresStore.js";

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ by: z.number() }) })
  .patch({
    Incremented: (event, s) => ({ count: s.count + event.data.by }),
  })
  .on({ increment: z.object({ count: z.number() }) })
  .emit((a) => ["Incremented", { by: a.count }])
  .build();

// Same state with snapshotting every 10 events
const CounterSnap = state({ CounterSnap: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ by: z.number() }) })
  .patch({
    Incremented: (event, s) => ({ count: s.count + event.data.by }),
  })
  .on({ increment: z.object({ count: z.number() }) })
  .emit((a) => ["Incremented", { by: a.count }])
  .snap((s) => s.patches >= 10)
  .build();

const target = { stream: "bench", actor: { id: "a", name: "a" } };
const snapTarget = { stream: "bench-snap", actor: { id: "a", name: "a" } };

function pgStore() {
  return new PostgresStore({
    port: 5431,
    schema: "cache_bench",
    table: "events",
  });
}

async function seedEvents(n: number, withSnap = false) {
  store(pgStore());
  await store().drop();
  await store().seed();
  if (withSnap) {
    // Seed with snap — must wait between actions for fire-and-forget
    // snapshot commits to complete before the next action loads
    for (let i = 0; i < n; i++) {
      await action(
        CounterSnap,
        "increment",
        snapTarget,
        { count: 1 },
        undefined,
        true
      );
      if ((i + 1) % 10 === 0) await new Promise((r) => setTimeout(r, 200));
    }
    // Final wait for last snapshot
    await new Promise((r) => setTimeout(r, 100));
  } else {
    for (let i = 0; i < n; i++) {
      await action(Counter, "increment", target, { count: 1 }, undefined, true);
    }
  }
}

describe("PG: load() with 100 events", () => {
  bench(
    "no snap, no cache",
    async () => {
      await load(Counter, "bench");
    },
    {
      async setup() {
        await dispose()();
        await seedEvents(100);
      },
    }
  );

  bench(
    "with snap, no cache",
    async () => {
      await load(CounterSnap, "bench-snap");
    },
    {
      async setup() {
        await dispose()();
        await seedEvents(100, true);
      },
    }
  );

  bench(
    "no snap, with cache (warm)",
    async () => {
      await load(Counter, "bench");
    },
    {
      async setup() {
        await dispose()();
        await seedEvents(100);
        cache(new InMemoryCache());
        await load(Counter, "bench");
      },
    }
  );

  bench(
    "with snap + cache (warm)",
    async () => {
      await load(CounterSnap, "bench-snap");
    },
    {
      async setup() {
        await dispose()();
        await seedEvents(100, true);
        cache(new InMemoryCache());
        await load(CounterSnap, "bench-snap");
      },
    }
  );
});

describe("PG: load() with 1000 events", () => {
  bench(
    "no snap, no cache",
    async () => {
      await load(Counter, "bench");
    },
    {
      async setup() {
        await dispose()();
        await seedEvents(1000);
      },
    }
  );

  bench(
    "with snap, no cache",
    async () => {
      await load(CounterSnap, "bench-snap");
    },
    {
      async setup() {
        await dispose()();
        await seedEvents(1000, true);
      },
    }
  );

  bench(
    "no snap, with cache (warm)",
    async () => {
      await load(Counter, "bench");
    },
    {
      async setup() {
        await dispose()();
        await seedEvents(1000);
        cache(new InMemoryCache());
        await load(Counter, "bench");
      },
    }
  );

  bench(
    "with snap + cache (warm)",
    async () => {
      await load(CounterSnap, "bench-snap");
    },
    {
      async setup() {
        await dispose()();
        await seedEvents(1000, true);
        cache(new InMemoryCache());
        await load(CounterSnap, "bench-snap");
      },
    }
  );
});

describe("PG: action() + load() cycle (10 events)", () => {
  bench(
    "no cache",
    async () => {
      await action(Counter, "increment", target, { count: 1 }, undefined, true);
      await load(Counter, "bench");
    },
    {
      async setup() {
        await dispose()();
        await seedEvents(10);
      },
    }
  );

  bench(
    "with cache",
    async () => {
      await action(Counter, "increment", target, { count: 1 }, undefined, true);
      await load(Counter, "bench");
    },
    {
      async setup() {
        await dispose()();
        await seedEvents(10);
        cache(new InMemoryCache());
      },
    }
  );
});
