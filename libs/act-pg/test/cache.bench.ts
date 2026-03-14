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

const CounterSnap10 = state({
  CounterSnap10: z.object({ count: z.number() }),
})
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ by: z.number() }) })
  .patch({
    Incremented: (event, s) => ({ count: s.count + event.data.by }),
  })
  .on({ increment: z.object({ count: z.number() }) })
  .emit((a) => ["Incremented", { by: a.count }])
  .snap((s) => s.patches >= 10)
  .build();

const CounterSnap50 = state({
  CounterSnap50: z.object({ count: z.number() }),
})
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ by: z.number() }) })
  .patch({
    Incremented: (event, s) => ({ count: s.count + event.data.by }),
  })
  .on({ increment: z.object({ count: z.number() }) })
  .emit((a) => ["Incremented", { by: a.count }])
  .snap((s) => s.patches >= 50)
  .build();

const CounterSnap100 = state({
  CounterSnap100: z.object({ count: z.number() }),
})
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ by: z.number() }) })
  .patch({
    Incremented: (event, s) => ({ count: s.count + event.data.by }),
  })
  .on({ increment: z.object({ count: z.number() }) })
  .emit((a) => ["Incremented", { by: a.count }])
  .snap((s) => s.patches >= 100)
  .build();

const target = { stream: "bench", actor: { id: "a", name: "a" } };
const snap10Target = { stream: "bench-s10", actor: { id: "a", name: "a" } };
const snap50Target = { stream: "bench-s50", actor: { id: "a", name: "a" } };
const snap100Target = { stream: "bench-s100", actor: { id: "a", name: "a" } };

function pgStore() {
  return new PostgresStore({
    port: 5431,
    schema: "cache_bench",
    table: "events",
  });
}

async function seedEvents(n: number, snapInterval?: 10 | 50 | 100) {
  store(pgStore());
  await store().drop();
  await store().seed();
  if (snapInterval) {
    const me =
      snapInterval === 10
        ? CounterSnap10
        : snapInterval === 50
          ? CounterSnap50
          : CounterSnap100;
    const t =
      snapInterval === 10
        ? snap10Target
        : snapInterval === 50
          ? snap50Target
          : snap100Target;
    for (let i = 0; i < n; i++) {
      await action(me, "increment", t, { count: 1 }, undefined, true);
      if ((i + 1) % snapInterval === 0)
        await new Promise((r) => setTimeout(r, 200));
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
    "snap@10, no cache",
    async () => {
      await load(CounterSnap10, "bench-s10");
    },
    {
      async setup() {
        await dispose()();
        await seedEvents(100, 10);
      },
    }
  );

  bench(
    "snap@50, no cache",
    async () => {
      await load(CounterSnap50, "bench-s50");
    },
    {
      async setup() {
        await dispose()();
        await seedEvents(100, 50);
      },
    }
  );

  bench(
    "snap@100, no cache",
    async () => {
      await load(CounterSnap100, "bench-s100");
    },
    {
      async setup() {
        await dispose()();
        await seedEvents(100, 100);
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
    "snap@10 + cache (warm)",
    async () => {
      await load(CounterSnap10, "bench-s10");
    },
    {
      async setup() {
        await dispose()();
        await seedEvents(100, 10);
        cache(new InMemoryCache());
        await load(CounterSnap10, "bench-s10");
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
    "snap@10, no cache",
    async () => {
      await load(CounterSnap10, "bench-s10");
    },
    {
      async setup() {
        await dispose()();
        await seedEvents(1000, 10);
      },
    }
  );

  bench(
    "snap@50, no cache",
    async () => {
      await load(CounterSnap50, "bench-s50");
    },
    {
      async setup() {
        await dispose()();
        await seedEvents(1000, 50);
      },
    }
  );

  bench(
    "snap@100, no cache",
    async () => {
      await load(CounterSnap100, "bench-s100");
    },
    {
      async setup() {
        await dispose()();
        await seedEvents(1000, 100);
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
    "snap@10 + cache (warm)",
    async () => {
      await load(CounterSnap10, "bench-s10");
    },
    {
      async setup() {
        await dispose()();
        await seedEvents(1000, 10);
        cache(new InMemoryCache());
        await load(CounterSnap10, "bench-s10");
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
