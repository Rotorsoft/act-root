/**
 * Drain Map lookup benchmark.
 *
 * Measures drain cycle time at increasing stream counts to show
 * the O(N²) → O(N) improvement from Map-based stream lookup.
 *
 * Run: npx tsx libs/act-pg/test/drain-map-lookup.bench.ts
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

const noop = async () => {};
const actor = { id: "a", name: "a" };

store(
  new PostgresStore({
    port: 5431,
    schema: "map_lookup_bench",
    table: "events",
  })
);

async function benchmark(streams: number, cycles: number) {
  await store().drop();
  await store().seed();

  const app_ = act().withState(Counter).on("Incremented").do(noop).build();

  // Seed streams with events
  for (let i = 0; i < streams; i++) {
    for (let j = 0; j < 3; j++) {
      await app_.do("increment", { stream: `s-${i}`, actor }, {});
    }
  }
  await app_.correlate({ limit: streams * 2 });

  // Measure drain cycles
  const start = performance.now();
  for (let i = 0; i < cycles; i++) {
    await app_.drain({ streamLimit: streams, eventLimit: 50, leaseMillis: 1 });
  }
  const elapsed = performance.now() - start;

  console.log(
    `| ${String(streams).padStart(7)} | ${String(cycles).padStart(6)} | ${elapsed.toFixed(0).padStart(9)}ms | ${(elapsed / cycles).toFixed(1).padStart(12)}ms |`
  );
}

console.log("| Streams | Cycles |     Total | Per cycle    |");
console.log("|---------|--------|-----------|--------------|");

for (const streams of [10, 50, 100, 200, 500]) {
  await benchmark(streams, 20);
}

await store().dispose();
process.exit(0);
