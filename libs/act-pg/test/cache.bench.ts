/* eslint-disable @typescript-eslint/no-unsafe-argument -- bench helpers use any to avoid State name branding */
import { bench, describe } from "vitest";
import { z } from "zod";
import { InMemoryCache } from "../../act/src/adapters/InMemoryCache.js";
import { action, load } from "../../act/src/event-sourcing.js";
import { cache, dispose, store } from "../../act/src/ports.js";
import { state } from "../../act/src/state-builder.js";
import { PostgresStore } from "../src/PostgresStore.js";

// --- State definitions (one per snap interval) ---

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ by: z.number() }) })
  .patch({ Incremented: (event, s) => ({ count: s.count + event.data.by }) })
  .on({ increment: z.object({ count: z.number() }) })
  .emit((a) => ["Incremented", { by: a.count }])
  .build();

const Snap10 = state({ Snap10: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ by: z.number() }) })
  .patch({ Incremented: (event, s) => ({ count: s.count + event.data.by }) })
  .on({ increment: z.object({ count: z.number() }) })
  .emit((a) => ["Incremented", { by: a.count }])
  .snap((s) => s.patches >= 10)
  .build();

const Snap50 = state({ Snap50: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ by: z.number() }) })
  .patch({ Incremented: (event, s) => ({ count: s.count + event.data.by }) })
  .on({ increment: z.object({ count: z.number() }) })
  .emit((a) => ["Incremented", { by: a.count }])
  .snap((s) => s.patches >= 50)
  .build();

const Snap75 = state({ Snap75: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ by: z.number() }) })
  .patch({ Incremented: (event, s) => ({ count: s.count + event.data.by }) })
  .on({ increment: z.object({ count: z.number() }) })
  .emit((a) => ["Incremented", { by: a.count }])
  .snap((s) => s.patches >= 75)
  .build();

const Snap100 = state({ Snap100: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ by: z.number() }) })
  .patch({ Incremented: (event, s) => ({ count: s.count + event.data.by }) })
  .on({ increment: z.object({ count: z.number() }) })
  .emit((a) => ["Incremented", { by: a.count }])
  .snap((s) => s.patches >= 100)
  .build();

type AnyState = any;
interface SnapConfig {
  me: AnyState;
  stream: string;
  interval: number;
}

const snaps: Record<string, SnapConfig> = {
  s10: { me: Snap10, stream: "b-s10", interval: 10 },
  s50: { me: Snap50, stream: "b-s50", interval: 50 },
  s75: { me: Snap75, stream: "b-s75", interval: 75 },
  s100: { me: Snap100, stream: "b-s100", interval: 100 },
};

const noSnapStream = "b-nosn";
const noSnapTarget = { stream: noSnapStream, actor: { id: "a", name: "a" } };

function pgStore() {
  return new PostgresStore({
    port: 5431,
    schema: "cache_bench",
    table: "events",
  });
}

async function seedNoSnap(n: number) {
  store(pgStore());
  await store().drop();
  await store().seed();
  for (let i = 0; i < n; i++) {
    await action(
      Counter,
      "increment",
      noSnapTarget,
      { count: 1 },
      undefined,
      true
    );
  }
}

async function seedSnap(n: number, cfg: SnapConfig) {
  store(pgStore());
  await store().drop();
  await store().seed();
  const t = { stream: cfg.stream, actor: { id: "a", name: "a" } };
  for (let i = 0; i < n; i++) {
    await action(cfg.me, "increment", t, { count: 1 }, undefined, true);
    // Wait for fire-and-forget snapshot commits
    if ((i + 1) % cfg.interval === 0)
      await new Promise((r) => setTimeout(r, 200));
  }
  await new Promise((r) => setTimeout(r, 100));
}

// --- Short streams: 50 events ---

describe("PG: load() 50 events", () => {
  bench(
    "no snap",
    async () => {
      await load(Counter, noSnapStream);
    },
    {
      async setup() {
        await dispose()();
        await seedNoSnap(50);
      },
    }
  );

  for (const [label, cfg] of Object.entries(snaps)) {
    bench(
      `${label}`,
      async () => {
        await load(cfg.me, cfg.stream);
      },
      {
        async setup() {
          await dispose()();
          await seedSnap(50, cfg);
        },
      }
    );
  }

  bench(
    "cache",
    async () => {
      await load(Counter, noSnapStream);
    },
    {
      async setup() {
        await dispose()();
        await seedNoSnap(50);
        cache(new InMemoryCache());
        await load(Counter, noSnapStream);
      },
    }
  );

  for (const [label, cfg] of Object.entries(snaps)) {
    bench(
      `${label}+cache`,
      async () => {
        await load(cfg.me, cfg.stream);
      },
      {
        async setup() {
          await dispose()();
          await seedSnap(50, cfg);
          cache(new InMemoryCache());
          await load(cfg.me, cfg.stream);
        },
      }
    );
  }
});

// --- Medium streams: 500 events ---

describe("PG: load() 500 events", () => {
  bench(
    "no snap",
    async () => {
      await load(Counter, noSnapStream);
    },
    {
      async setup() {
        await dispose()();
        await seedNoSnap(500);
      },
    }
  );

  for (const [label, cfg] of Object.entries(snaps)) {
    bench(
      `${label}`,
      async () => {
        await load(cfg.me, cfg.stream);
      },
      {
        async setup() {
          await dispose()();
          await seedSnap(500, cfg);
        },
      }
    );
  }

  bench(
    "cache",
    async () => {
      await load(Counter, noSnapStream);
    },
    {
      async setup() {
        await dispose()();
        await seedNoSnap(500);
        cache(new InMemoryCache());
        await load(Counter, noSnapStream);
      },
    }
  );

  for (const [label, cfg] of Object.entries(snaps)) {
    bench(
      `${label}+cache`,
      async () => {
        await load(cfg.me, cfg.stream);
      },
      {
        async setup() {
          await dispose()();
          await seedSnap(500, cfg);
          cache(new InMemoryCache());
          await load(cfg.me, cfg.stream);
        },
      }
    );
  }
});

// --- Long streams: 2000 events ---

describe("PG: load() 2000 events", () => {
  bench(
    "no snap",
    async () => {
      await load(Counter, noSnapStream);
    },
    {
      async setup() {
        await dispose()();
        await seedNoSnap(2000);
      },
    }
  );

  for (const [label, cfg] of Object.entries(snaps)) {
    bench(
      `${label}`,
      async () => {
        await load(cfg.me, cfg.stream);
      },
      {
        async setup() {
          await dispose()();
          await seedSnap(2000, cfg);
        },
      }
    );
  }

  bench(
    "cache",
    async () => {
      await load(Counter, noSnapStream);
    },
    {
      async setup() {
        await dispose()();
        await seedNoSnap(2000);
        cache(new InMemoryCache());
        await load(Counter, noSnapStream);
      },
    }
  );

  for (const [label, cfg] of Object.entries(snaps)) {
    bench(
      `${label}+cache`,
      async () => {
        await load(cfg.me, cfg.stream);
      },
      {
        async setup() {
          await dispose()();
          await seedSnap(2000, cfg);
          cache(new InMemoryCache());
          await load(cfg.me, cfg.stream);
        },
      }
    );
  }
});
