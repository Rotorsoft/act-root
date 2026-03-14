/* eslint-disable @typescript-eslint/no-unsafe-argument -- bench helpers use any to avoid State name branding */
import { bench, describe } from "vitest";
import { z } from "zod";
import { InMemoryStore } from "../src/adapters/InMemoryStore.js";
import { action, load } from "../src/event-sourcing.js";
import { dispose, store } from "../src/ports.js";
import { state } from "../src/state-builder.js";

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
  interval: number;
}

const snaps: Record<string, SnapConfig> = {
  s10: { me: Snap10, interval: 10 },
  s50: { me: Snap50, interval: 50 },
  s75: { me: Snap75, interval: 75 },
  s100: { me: Snap100, interval: 100 },
};

const stream = "bench";
const target = { stream, actor: { id: "a", name: "a" } };

async function seedEvents(n: number, me: AnyState = Counter) {
  store(new InMemoryStore());
  await store().seed();
  for (let i = 0; i < n; i++) {
    await action(me, "increment", target, { count: 1 }, undefined, true);
  }
}

// Cache is always on — benchmarks test stream length × snap interval

describe("load() 50 events", () => {
  bench(
    "no snap",
    async () => {
      await load(Counter, stream);
    },
    {
      async setup() {
        await dispose()();
        await seedEvents(50);
      },
    }
  );

  for (const [label, cfg] of Object.entries(snaps)) {
    bench(
      `${label}`,
      async () => {
        await load(cfg.me, stream);
      },
      {
        async setup() {
          await dispose()();
          await seedEvents(50, cfg.me);
        },
      }
    );
  }
});

describe("load() 500 events", () => {
  bench(
    "no snap",
    async () => {
      await load(Counter, stream);
    },
    {
      async setup() {
        await dispose()();
        await seedEvents(500);
      },
    }
  );

  for (const [label, cfg] of Object.entries(snaps)) {
    bench(
      `${label}`,
      async () => {
        await load(cfg.me, stream);
      },
      {
        async setup() {
          await dispose()();
          await seedEvents(500, cfg.me);
        },
      }
    );
  }
});

describe("load() 2000 events", () => {
  bench(
    "no snap",
    async () => {
      await load(Counter, stream);
    },
    {
      async setup() {
        await dispose()();
        await seedEvents(2000);
      },
    }
  );

  for (const [label, cfg] of Object.entries(snaps)) {
    bench(
      `${label}`,
      async () => {
        await load(cfg.me, stream);
      },
      {
        async setup() {
          await dispose()();
          await seedEvents(2000, cfg.me);
        },
      }
    );
  }
});
