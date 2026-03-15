/**
 * Batch fetch benchmark — measures drain fetch phase with source deduplication.
 *
 * Two scenarios:
 * 1. Distinct sources — each stream has its own source (N queries → N queries, no dedup)
 * 2. Shared sources — multiple streams share a source (N queries → M queries, M << N)
 *
 * Run: npx tsx libs/act-pg/test/batch-fetch.bench.ts
 */
import { act, state, store, ZodEmpty } from "@rotorsoft/act";
import { z } from "zod";
import { PostgresStore } from "../src/PostgresStore.js";

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: ZodEmpty })
  .patch({ Incremented: (_, s) => ({ count: s.count + 1 }) })
  .on({ increment: ZodEmpty })
  .emit(() => ["Incremented", {}])
  .build();

const Stats = state({ Stats: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ StatUpdated: ZodEmpty })
  .patch({ StatUpdated: (_, s) => ({ count: s.count + 1 }) })
  .on({ UpdateStat: ZodEmpty })
  .emit("StatUpdated")
  .build();

const noop = async () => {};
const actor = { id: "a", name: "a" };

store(
  new PostgresStore({
    port: 5431,
    schema: "batch_fetch_bench",
    table: "events",
  })
);

// Scenario 1: distinct sources (_this_ resolver — each stream is its own source)
async function benchDistinct(streams: number, cycles: number) {
  await store().drop();
  await store().seed();

  const app_ = act().withState(Counter).on("Incremented").do(noop).build();

  for (let i = 0; i < streams; i++) {
    for (let j = 0; j < 5; j++) {
      await app_.do("increment", { stream: `s-${i}`, actor }, {});
    }
  }
  await app_.correlate({ limit: streams * 2 });

  const start = performance.now();
  for (let i = 0; i < cycles; i++) {
    await app_.drain({ streamLimit: streams, eventLimit: 50, leaseMillis: 1 });
  }
  return performance.now() - start;
}

// Scenario 2: shared sources (fan-out — N target streams from M source streams)
async function benchShared(sources: number, fanOut: number, cycles: number) {
  await store().drop();
  await store().seed();

  const app_ = act()
    .withState(Counter)
    .withState(Stats)
    .on("Incremented")
    .do(noop)
    .to((event) => ({
      target: `stats-${event.stream}`,
      source: event.stream,
    }))
    .build();

  // Create source streams with events
  for (let i = 0; i < sources; i++) {
    for (let j = 0; j < 5; j++) {
      await app_.do("increment", { stream: `src-${i}`, actor }, {});
    }
  }

  // Correlate to discover dynamic target streams (stats-src-0, stats-src-1, ...)
  for (let pass = 0; pass < 5; pass++) {
    const { subscribed } = await app_.correlate({ limit: sources * 10 });
    if (subscribed === 0 && pass > 0) break;
    await app_.drain({
      streamLimit: sources * 2,
      eventLimit: 50,
      leaseMillis: 1,
    });
  }

  // Add new events to trigger more drain work
  for (let i = 0; i < sources; i++) {
    for (let j = 0; j < fanOut; j++) {
      await app_.do("increment", { stream: `src-${i}`, actor }, {});
    }
  }
  await app_.correlate({ limit: sources * fanOut * 2 });

  const totalStreams = sources * 2; // source streams + stats-* targets
  const start = performance.now();
  for (let i = 0; i < cycles; i++) {
    await app_.drain({
      streamLimit: totalStreams,
      eventLimit: 50,
      leaseMillis: 1,
    });
  }
  return performance.now() - start;
}

console.log("\n=== Scenario 1: Distinct sources (no dedup opportunity) ===");
console.log("| Streams | Cycles | Total (ms) | Per cycle (ms) |");
console.log("|---------|--------|------------|----------------|");
for (const streams of [10, 50, 100]) {
  const elapsed = await benchDistinct(streams, 20);
  console.log(
    `| ${String(streams).padStart(7)} | ${String(20).padStart(6)} | ${elapsed.toFixed(0).padStart(10)} | ${(elapsed / 20).toFixed(1).padStart(14)} |`
  );
}

console.log("\n=== Scenario 2: Shared sources (fan-out deduplication) ===");
console.log(
  "| Sources | Fan-out | Total streams | Cycles | Total (ms) | Per cycle (ms) |"
);
console.log(
  "|---------|---------|---------------|--------|------------|----------------|"
);
for (const sources of [10, 25, 50]) {
  const fanOut = 3;
  const elapsed = await benchShared(sources, fanOut, 20);
  const totalStreams = sources * 2;
  console.log(
    `| ${String(sources).padStart(7)} | ${String(fanOut).padStart(7)} | ${String(totalStreams).padStart(13)} | ${String(20).padStart(6)} | ${elapsed.toFixed(0).padStart(10)} | ${(elapsed / 20).toFixed(1).padStart(14)} |`
  );
}

await store().dispose();
process.exit(0);
