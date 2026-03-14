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

const target = { stream: "bench", actor: { id: "a", name: "a" } };

function pgStore() {
  return new PostgresStore({
    port: 5431,
    schema: "cache_bench",
    table: "events",
  });
}

async function seedEvents(n: number) {
  store(pgStore());
  await store().drop();
  await store().seed();
  for (let i = 0; i < n; i++) {
    await action(Counter, "increment", target, { count: 1 }, undefined, true);
  }
}

describe("PG: load() with 10 events", () => {
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
    "with cache (warm)",
    async () => {
      await load(Counter, "bench");
    },
    {
      async setup() {
        await dispose()();
        await seedEvents(10);
        cache(new InMemoryCache());
        await load(Counter, "bench");
      },
    }
  );
});

describe("PG: load() with 100 events", () => {
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

describe("PG: load() with 1000 events", () => {
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

describe("PG: action() + load() cycle", () => {
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
