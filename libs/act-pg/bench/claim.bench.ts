/**
 * Benchmark: claim (fused poll+lease) drain cycle performance.
 *
 * Measures drain throughput at different stream counts to validate
 * the competing consumer pattern (FOR UPDATE SKIP LOCKED).
 *
 * Run: vitest bench libs/act-pg/test/claim.bench.ts
 */
import { act, dispose, state, store, ZodEmpty } from "@rotorsoft/act";
import { bench, describe } from "vitest";
import { PostgresStore } from "../src/PostgresStore.js";

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: ZodEmpty })
  .patch({ Incremented: (_, s) => ({ count: s.count + 1 }) })
  .on({ increment: ZodEmpty })
  .emit(() => ["Incremented", {}])
  .build();

import { z } from "zod";

const actor = { id: "a", name: "a" };

function pgStore() {
  return new PostgresStore({
    port: 5431,
    schema: "claim_bench",
    table: "events",
  });
}

const handler = vi.fn().mockResolvedValue(undefined);

async function seedStreams(n: number) {
  store(pgStore());
  await store().drop();
  await store().seed();

  const app_ = act().withState(Counter).on("Incremented").do(handler).build();

  // Create N streams with 1 event each
  for (let i = 0; i < n; i++) {
    await app_.do("increment", { stream: `s-${i}`, actor }, {});
  }
  // Correlate to register reaction target streams
  await app_.correlate({ limit: n * 2 });

  return app_;
}

describe("PG: drain cycle — 10 streams", () => {
  let app_: Awaited<ReturnType<typeof seedStreams>>;

  bench(
    "drain 10 streams",
    async () => {
      await app_.drain({ streamLimit: 10, eventLimit: 10, leaseMillis: 1 });
    },
    {
      async setup() {
        await dispose()();
        handler.mockClear();
        app_ = await seedStreams(10);
      },
    }
  );
});

describe("PG: drain cycle — 50 streams", () => {
  let app_: Awaited<ReturnType<typeof seedStreams>>;

  bench(
    "drain 50 streams",
    async () => {
      await app_.drain({ streamLimit: 50, eventLimit: 10, leaseMillis: 1 });
    },
    {
      async setup() {
        await dispose()();
        handler.mockClear();
        app_ = await seedStreams(50);
      },
    }
  );
});

describe("PG: drain cycle — 100 streams", () => {
  let app_: Awaited<ReturnType<typeof seedStreams>>;

  bench(
    "drain 100 streams",
    async () => {
      await app_.drain({ streamLimit: 100, eventLimit: 10, leaseMillis: 1 });
    },
    {
      async setup() {
        await dispose()();
        handler.mockClear();
        app_ = await seedStreams(100);
      },
    }
  );
});
