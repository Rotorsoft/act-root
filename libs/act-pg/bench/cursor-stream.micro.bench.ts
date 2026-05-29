/**
 * Benchmark: PostgresStore.query buffered vs cursor-streaming
 * (ACT-1132).
 *
 * The headline question: when does the cursor path's per-batch
 * round-trip cost get paid back by not materializing the whole
 * result set in memory?
 *
 * - At small row counts the buffered path wins on latency (1
 *   round trip vs the cursor's BEGIN + N × FETCH + CLOSE + COMMIT).
 * - At large row counts the buffered path drives `pg` to allocate
 *   one JS object per row before the callback even runs — that's
 *   the RSS spike the streaming flag is designed to avoid.
 *
 * The numbers in PERFORMANCE.md are produced from a separate
 * script (`scripts/cursor-rss.ts`) that measures RSS with
 * `process.memoryUsage()`; this vitest bench tracks the wall-clock
 * delta as a regression guard.
 *
 * Run: pnpm bench:scenario libs/act-pg/bench/cursor-stream.scenario.bench.ts
 */
import type { Schemas } from "@rotorsoft/act";
import { afterAll, beforeAll, bench, describe } from "vitest";
import { PostgresStore } from "../src/postgres-store.js";

const PORT = 5431;
const SCHEMA = "cursor_stream_bench";
const TABLE = "events";

// Sweep deliberately spans the crossover region. 100 events is in
// "buffered wins" territory; 10k is around the break-even on local
// loopback; 100k is the streaming-only path on any remote DB.
const SWEEP_ROWS = [100, 10_000, 100_000] as const;

const store = new PostgresStore({
  port: PORT,
  schema: SCHEMA,
  table: TABLE,
  batch_size: 500,
});

beforeAll(async () => {
  await store.drop();
  await store.seed();
  // Seed one stream per sweep size so each bench iteration walks a
  // self-contained range. Commit in chunks of 1000 to keep
  // transaction sizes reasonable.
  for (const N of SWEEP_ROWS) {
    const stream = `cursor-bench-${N}`;
    for (let base = 0; base < N; base += 1000) {
      const chunk = Math.min(1000, N - base);
      const msgs = Array.from({ length: chunk }, (_, k) => ({
        name: "Incremented",
        data: { by: base + k + 1 },
      }));
      await store.commit(stream, msgs, {
        correlation: "cursor-bench",
        causation: {},
      });
    }
  }
}, 600_000);

afterAll(async () => {
  await store.dispose();
});

async function walk(stream: string, streaming: boolean) {
  let count = 0;
  await store.query<Schemas>(
    () => {
      count++;
    },
    { stream, stream_exact: true, streaming }
  );
  return count;
}

for (const N of SWEEP_ROWS) {
  describe(`PG query — walk ${N} events`, () => {
    const stream = `cursor-bench-${N}`;

    bench("buffered (pool.query)", async () => {
      await walk(stream, false);
    });

    bench("cursor (DECLARE / FETCH)", async () => {
      await walk(stream, true);
    });
  });
}
