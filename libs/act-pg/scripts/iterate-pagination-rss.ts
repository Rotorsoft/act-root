/**
 * Measure heap/RSS during a `scan`-driven walk of a large
 * PostgresStore (ACT-1133). Vitest's bench harness only times
 * wall-clock; the win the pagination loop is designed to produce
 * is in producer memory, not latency, so we use a script.
 *
 * Procedure:
 *   1. Seed one stream with `ROWS` events (default 200k).
 *   2. Force GC, take baseline RSS + heapUsed.
 *   3. Walk the stream as `iterate` does — single buffered
 *      `pool.query` with no limit. Record peak RSS + heap.
 *   4. Force GC, walk the stream as `iterate` does now —
 *      pagination loop with limit:500 per batch. Record peak.
 *   5. Report deltas.
 *
 * Run:
 *   pnpm tsx --expose-gc libs/act-pg/scripts/iterate-pagination-rss.ts
 *   # custom row count or PG port:
 *   ROWS=500000 PG_PORT=5431 pnpm tsx --expose-gc <script>
 *
 * The output drives the table in libs/act-pg/PERFORMANCE.md.
 * Heap is the cleaner signal — RSS only shrinks when V8 returns
 * pages to the OS, which is lazy. Once the buffered run grew V8 to
 * peak, the subsequent paginated run inherits that RSS ceiling
 * even though its live JS allocation is much smaller.
 */
import type { Committed, Schemas } from "@rotorsoft/act";
import { PostgresStore } from "../src/postgres-store.js";

const PORT = Number(process.env.PG_PORT ?? 5431);
const ROWS = Number(process.env.ROWS ?? 200_000);
const BATCH = Number(process.env.BATCH ?? 500);
const SCHEMA = "iterate_rss";
const STREAM = `iterate-rss-${ROWS}`;

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
      correlation: "iterate-rss",
      causation: {},
    });
  }
  console.log("done.");
}

type Stats = {
  count: number;
  peakRss: number;
  peakHeap: number;
  duration_ms: number;
};

async function walk(
  fn: (cb: (e: Committed<Schemas, keyof Schemas>) => void) => Promise<number>
): Promise<Stats> {
  global.gc?.();
  await new Promise((resolve) => setTimeout(resolve, 200));
  const baseline = process.memoryUsage();
  let peakRss = baseline.rss;
  let peakHeap = baseline.heapUsed;
  let count = 0;
  // Sample on a 5 ms timer. The buffered path materializes the
  // result set inside `pg.query` BEFORE the first callback runs;
  // an in-callback sampler would miss the spike. The timer catches
  // it regardless of where in the call stack the allocation happens.
  const sampler = setInterval(() => {
    const m = process.memoryUsage();
    if (m.rss > peakRss) peakRss = m.rss;
    if (m.heapUsed > peakHeap) peakHeap = m.heapUsed;
  }, 5);
  const t0 = Date.now();
  try {
    await fn(() => {
      count++;
    });
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

    // Buffered: single pool.query with no limit. Mirrors iterate
    // pre-ACT-1133 (and any direct caller that doesn't pass a limit).
    const buffered = await walk((cb) =>
      store.query<Schemas>(cb, { stream: STREAM, stream_exact: true })
    );
    console.log("Buffered (single `pool.query`, no limit):");
    console.log(`  events:        ${buffered.count}`);
    console.log(`  duration:      ${buffered.duration_ms} ms`);
    console.log(
      `  peak RSS:      ${mb(buffered.peakRss)} MB (+${mb(buffered.peakRss - baseline.rss)} MB)`
    );
    console.log(
      `  peak heap:     ${mb(buffered.peakHeap)} MB (+${mb(buffered.peakHeap - baseline.heapUsed)} MB)`
    );
    console.log("");

    // Paginated: replicates the iterate(source) loop — repeated
    // pool.query with limit:BATCH and bumped after. Same shape the
    // framework now ships post-ACT-1133.
    const paginated = await walk(async (cb) => {
      let after = -1;
      let total = 0;
      while (true) {
        let batch = 0;
        let lastId: number | undefined;
        await store.query<Schemas>(
          (e) => {
            cb(e);
            batch++;
            lastId = e.id;
          },
          {
            stream: STREAM,
            stream_exact: true,
            after,
            limit: BATCH,
          }
        );
        total += batch;
        if (batch < BATCH) break;
        after = lastId!;
      }
      return total;
    });
    console.log(`Paginated (limit:${BATCH} loop, bumped \`after\`):`);
    console.log(`  events:        ${paginated.count}`);
    console.log(`  duration:      ${paginated.duration_ms} ms`);
    console.log(
      `  peak RSS:      ${mb(paginated.peakRss)} MB (+${mb(paginated.peakRss - baseline.rss)} MB)`
    );
    console.log(
      `  peak heap:     ${mb(paginated.peakHeap)} MB (+${mb(paginated.peakHeap - baseline.heapUsed)} MB)`
    );
    console.log("");

    const heapRatio = buffered.peakHeap / paginated.peakHeap;
    console.log(
      `Heap delta:      ${mb(buffered.peakHeap - paginated.peakHeap)} MB saved (${heapRatio.toFixed(2)}× smaller heap under pagination)`
    );
    console.log(
      `RSS:             ${mb(buffered.peakRss - paginated.peakRss)} MB raw delta — RSS does not shrink after V8 heap grows, so heap-delta is the cleaner signal`
    );
  } finally {
    await store.dispose();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
