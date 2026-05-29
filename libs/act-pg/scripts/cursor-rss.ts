/**
 * Measure RSS during a large-result PostgresStore.query walk
 * (ACT-1132). Vitest's bench harness only times wall-clock; the
 * win the streaming flag is designed to produce is in memory, not
 * latency, so we use a script.
 *
 * Procedure:
 *   1. Seed one stream with `ROWS` events (default 200k).
 *   2. Force GC, take baseline RSS.
 *   3. Walk the stream buffered. Record peak RSS during the walk.
 *   4. Force GC, walk the stream streaming. Record peak RSS.
 *   5. Report deltas.
 *
 * Run:
 *   pnpm tsx libs/act-pg/scripts/cursor-rss.ts
 *   # with explicit GC for cleaner numbers:
 *   pnpm tsx --expose-gc libs/act-pg/scripts/cursor-rss.ts
 *
 * The output drives the table in libs/act-pg/PERFORMANCE.md.
 * Tuned for local PG on port 5431.
 */
import type { Schemas } from "@rotorsoft/act";
import { PostgresStore } from "../src/postgres-store.js";

const PORT = Number(process.env.PG_PORT ?? 5431);
const ROWS = Number(process.env.ROWS ?? 200_000);
const SCHEMA = "cursor_rss";
const STREAM = `cursor-rss-${ROWS}`;

const mb = (n: number) => (n / 1024 / 1024).toFixed(1);

async function seed(store: PostgresStore) {
  await store.drop();
  await store.seed();
  const CHUNK = 1000;
  process.stdout.write(`Seeding ${ROWS} events… `);
  for (let base = 0; base < ROWS; base += CHUNK) {
    const chunk = Math.min(CHUNK, ROWS - base);
    const msgs = Array.from({ length: chunk }, (_, k) => ({
      name: "Bench",
      data: { i: base + k },
    }));
    await store.commit(STREAM, msgs, {
      correlation: "cursor-rss",
      causation: {},
    });
  }
  console.log("done.");
}

async function walk(
  store: PostgresStore,
  streaming: boolean
): Promise<{
  count: number;
  peakRss: number;
  peakHeap: number;
  duration_ms: number;
}> {
  global.gc?.();
  await new Promise((resolve) => setTimeout(resolve, 200));
  const baseline = process.memoryUsage();
  let peakRss = baseline.rss;
  let peakHeap = baseline.heapUsed;
  let count = 0;
  // Sample on a 5 ms timer. The buffered path resolves the full
  // result set inside `pg.query` BEFORE the first callback runs, so
  // an in-callback sampler would miss the spike. The timer catches
  // it regardless of where in the call stack the allocation happens.
  // heapUsed isolates the JS allocation cost from V8 heap-growth
  // hysteresis (RSS does not shrink after V8 grows the young/old
  // generation), so it's the cleaner signal for the streaming win.
  const sampler = setInterval(() => {
    const m = process.memoryUsage();
    if (m.rss > peakRss) peakRss = m.rss;
    if (m.heapUsed > peakHeap) peakHeap = m.heapUsed;
  }, 5);
  const t0 = Date.now();
  try {
    await store.query<Schemas>(
      () => {
        count++;
      },
      { stream: STREAM, stream_exact: true, streaming }
    );
  } finally {
    clearInterval(sampler);
  }
  const duration_ms = Date.now() - t0;
  const final = process.memoryUsage();
  if (final.rss > peakRss) peakRss = final.rss;
  if (final.heapUsed > peakHeap) peakHeap = final.heapUsed;
  return { count, peakRss, peakHeap, duration_ms };
}

async function main() {
  const store = new PostgresStore({
    port: PORT,
    schema: SCHEMA,
    table: "events",
    batch_size: 500,
  });

  try {
    await seed(store);

    global.gc?.();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const baseline = process.memoryUsage();
    console.log("");
    console.log(
      `Baseline:        RSS ${mb(baseline.rss)} MB, heap ${mb(baseline.heapUsed)} MB`
    );
    console.log("");

    const buffered = await walk(store, false);
    console.log("Buffered (pool.query):");
    console.log(`  events:        ${buffered.count}`);
    console.log(`  duration:      ${buffered.duration_ms} ms`);
    console.log(
      `  peak RSS:      ${mb(buffered.peakRss)} MB (+${mb(buffered.peakRss - baseline.rss)} MB)`
    );
    console.log(
      `  peak heap:     ${mb(buffered.peakHeap)} MB (+${mb(buffered.peakHeap - baseline.heapUsed)} MB)`
    );
    console.log("");

    const streamed = await walk(store, true);
    console.log("Cursor (DECLARE / FETCH, batch_size=500):");
    console.log(`  events:        ${streamed.count}`);
    console.log(`  duration:      ${streamed.duration_ms} ms`);
    console.log(
      `  peak RSS:      ${mb(streamed.peakRss)} MB (+${mb(streamed.peakRss - baseline.rss)} MB)`
    );
    console.log(
      `  peak heap:     ${mb(streamed.peakHeap)} MB (+${mb(streamed.peakHeap - baseline.heapUsed)} MB)`
    );
    console.log("");

    const heapRatio = buffered.peakHeap / streamed.peakHeap;
    console.log(
      `Heap delta:      ${mb(buffered.peakHeap - streamed.peakHeap)} MB saved (${heapRatio.toFixed(2)}× smaller heap under streaming)`
    );
    console.log(
      `RSS:             ${mb(buffered.peakRss - streamed.peakRss)} MB raw delta — RSS does not shrink after V8 heap grows, so heap-delta is the cleaner signal`
    );
  } finally {
    await store.dispose();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
