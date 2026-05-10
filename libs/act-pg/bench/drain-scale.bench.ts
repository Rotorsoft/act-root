/**
 * Scale benchmark: drain cycle throughput under concurrent worker load.
 *
 * Tests atomic claim vs two-phase poll→lease at scale with multiple
 * concurrent drain workers competing for streams.
 *
 * Run: vitest bench libs/act-pg/test/drain-scale.bench.ts
 */
import { act, dispose, state, store, ZodEmpty } from "@rotorsoft/act";
import { bench, describe } from "vitest";
import { z } from "zod";
import { PostgresStore } from "../src/PostgresStore.js";

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: ZodEmpty })
  .patch({ Incremented: (_, s) => ({ count: s.count + 1 }) })
  .on({ increment: ZodEmpty })
  .emit(() => ["Incremented", {}])
  .build();

const actor = { id: "a", name: "a" };

function pgStore() {
  return new PostgresStore({
    port: 5431,
    schema: "drain_scale",
    table: "events",
  });
}

const handler = vi.fn().mockResolvedValue(undefined);

async function seedStreams(n: number) {
  store(pgStore());
  await store().drop();
  await store().seed();

  const app_ = act().withState(Counter).on("Incremented").do(handler).build();

  // Create N streams with 5 events each
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < 5; j++) {
      await app_.do("increment", { stream: `s-${i}`, actor }, {});
    }
  }
  await app_.correlate({ limit: n * 2 });
  return app_;
}

// --- Single worker benchmarks (stream scaling) ---

for (const streams of [50, 200, 500, 1000]) {
  describe(`1 worker × ${streams} streams`, () => {
    let app_: Awaited<ReturnType<typeof seedStreams>>;

    bench(
      `drain ${streams}`,
      async () => {
        await app_.drain({
          streamLimit: streams,
          eventLimit: 50,
          leaseMillis: 1,
        });
      },
      {
        async setup() {
          await dispose()();
          handler.mockClear();
          app_ = await seedStreams(streams);
        },
      }
    );
  });
}

// --- Concurrent worker benchmarks (contention) ---

for (const workers of [3, 5]) {
  for (const streams of [100, 500]) {
    describe(`${workers} workers × ${streams} streams`, () => {
      let app_: Awaited<ReturnType<typeof seedStreams>>;

      bench(
        `drain ${streams} with ${workers} concurrent workers`,
        async () => {
          const limit = Math.ceil(streams / workers);
          await Promise.all(
            Array.from({ length: workers }, () =>
              app_.drain({
                streamLimit: limit,
                eventLimit: 50,
                leaseMillis: 1,
              })
            )
          );
        },
        {
          async setup() {
            await dispose()();
            handler.mockClear();
            app_ = await seedStreams(streams);
          },
        }
      );
    });
  }
}
