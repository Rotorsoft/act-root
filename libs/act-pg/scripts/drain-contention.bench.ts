/**
 * Multi-worker contention benchmark.
 *
 * Creates separate Act instances sharing the same PostgresStore pool.
 * Each instance has its own _drain_locked mutex, so concurrent drains
 * truly compete through PG's FOR UPDATE SKIP LOCKED.
 *
 * Run: npx tsx libs/act-pg/test/drain-contention.bench.ts
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

const handler = async () => {};
const actor = { id: "a", name: "a" };

// Initialize store once
store(
  new PostgresStore({
    port: 5431,
    schema: "contention_bench",
    table: "events",
  })
);

function buildApp() {
  return act().withState(Counter).on("Incremented").do(handler).build();
}

async function seed(n: number, eventsPerStream: number) {
  await store().drop();
  await store().seed();

  const app_ = buildApp();
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < eventsPerStream; j++) {
      await app_.do("increment", { stream: `s-${i}`, actor }, {});
    }
  }
  await app_.correlate({ limit: n * 2 });
}

async function runWorker(
  streamLimit: number,
  maxDrains: number
): Promise<{ acked: number; drains: number; wasted: number }> {
  const app_ = buildApp();
  let acked = 0;
  let drains = 0;
  let wasted = 0;

  for (let i = 0; i < maxDrains; i++) {
    const r = await app_.drain({
      streamLimit,
      eventLimit: 50,
      leaseMillis: 30_000,
    });
    drains++;
    acked += r.acked.length;
    if (r.acked.length === 0 && r.blocked.length === 0) wasted++;
    if (r.acked.length === 0 && r.leased.length === 0) break;
  }

  return { acked, drains, wasted };
}

async function benchmark(
  streams: number,
  workers: number,
  streamLimit: number
) {
  await seed(streams, 5);

  const maxDrains = Math.ceil((streams / streamLimit) * 3) + 5;
  const start = performance.now();

  const results = await Promise.all(
    Array.from({ length: workers }, () => runWorker(streamLimit, maxDrains))
  );

  const wall = performance.now() - start;
  const acked = results.reduce((s, r) => s + r.acked, 0);
  const drains = results.reduce((s, r) => s + r.drains, 0);
  const wasted = results.reduce((s, r) => s + r.wasted, 0);
  const pct = drains > 0 ? ((wasted / drains) * 100).toFixed(0) : "0";
  const label = `${workers}w × ${streams}s (limit=${streamLimit})`;

  console.log(
    `| ${label.padEnd(30)} | ${String(acked).padStart(6)} | ${String(drains).padStart(6)} | ${pct.padStart(5)}% | ${String(Math.round(wall)).padStart(7)}ms | ${(acked / (wall / 1000)).toFixed(0).padStart(8)}/s |`
  );
}

console.log(
  "| Config                         | Acked  | Drains | Waste |    Wall  | Through   |"
);
console.log(
  "|--------------------------------|--------|--------|-------|---------|-----------|"
);

for (const workers of [1, 3, 5]) {
  for (const streams of [100, 500]) {
    const streamLimit = Math.ceil(streams / workers);
    await benchmark(streams, workers, streamLimit);
  }
}

await store().dispose();
process.exit(0);
