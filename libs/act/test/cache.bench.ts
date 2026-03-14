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

const target = { stream: "bench", actor: { id: "a", name: "a" } };

async function seedEvents(n: number) {
  store(new InMemoryStore());
  await store().seed();
  for (let i = 0; i < n; i++) {
    await action(Counter, "increment", target, { count: 1 }, undefined, true);
  }
}

describe("load() with 10 events", () => {
  bench(
    "without cache",
    async () => {
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
    "with cache (cold)",
    async () => {
      cache(new InMemoryCache());
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
    "with cache (warm)",
    async () => {
      await load(Counter, "bench");
    },
    {
      async setup() {
        await dispose()();
        await seedEvents(10);
        cache(new InMemoryCache());
        await load(Counter, "bench"); // warm the cache
      },
    }
  );
});

describe("load() with 100 events", () => {
  bench(
    "without cache",
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
    "with cache (warm)",
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
    "without cache",
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
    "with cache (warm)",
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

describe("action() + load() cycle", () => {
  bench(
    "without cache",
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
