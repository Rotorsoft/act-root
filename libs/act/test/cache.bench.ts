import { bench, describe } from "vitest";
import { z } from "zod";
import { InMemoryCache } from "../src/adapters/InMemoryCache.js";
import { InMemoryStore } from "../src/adapters/InMemoryStore.js";
import { action, load } from "../src/event-sourcing.js";
import { cache, dispose, store } from "../src/ports.js";
import { state } from "../src/state-builder.js";

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

type SnapState =
  | typeof Counter
  | typeof CounterSnap10
  | typeof CounterSnap50
  | typeof CounterSnap100;

const target = { stream: "bench", actor: { id: "a", name: "a" } };

async function seedEvents(n: number, me: SnapState = Counter) {
  store(new InMemoryStore());
  await store().seed();
  for (let i = 0; i < n; i++) {
    await action(me, "increment", target, { count: 1 }, undefined, true);
  }
}

describe("load() with 100 events", () => {
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
      await load(CounterSnap10, "bench");
    },
    {
      async setup() {
        await dispose()();
        await seedEvents(100, CounterSnap10);
      },
    }
  );

  bench(
    "snap@50, no cache",
    async () => {
      await load(CounterSnap50, "bench");
    },
    {
      async setup() {
        await dispose()();
        await seedEvents(100, CounterSnap50);
      },
    }
  );

  bench(
    "snap@100, no cache",
    async () => {
      await load(CounterSnap100, "bench");
    },
    {
      async setup() {
        await dispose()();
        await seedEvents(100, CounterSnap100);
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
});

describe("load() with 1000 events", () => {
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
      await load(CounterSnap10, "bench");
    },
    {
      async setup() {
        await dispose()();
        await seedEvents(1000, CounterSnap10);
      },
    }
  );

  bench(
    "snap@50, no cache",
    async () => {
      await load(CounterSnap50, "bench");
    },
    {
      async setup() {
        await dispose()();
        await seedEvents(1000, CounterSnap50);
      },
    }
  );

  bench(
    "snap@100, no cache",
    async () => {
      await load(CounterSnap100, "bench");
    },
    {
      async setup() {
        await dispose()();
        await seedEvents(1000, CounterSnap100);
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
});

describe("action() + load() cycle (10 events)", () => {
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
