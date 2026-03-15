/**
 * Watermark-aware claim benchmark.
 *
 * Scenario: many subscribed streams, most caught up, few active.
 * Without filtering, claim returns caught-up streams that waste
 * drain cycles. With filtering, claim returns only active streams.
 *
 * Run: npx tsx libs/act-pg/test/watermark-claim.bench.ts
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
    schema: "watermark_bench",
    table: "events",
  })
);

async function benchmark(
  totalStreams: number,
  activeStreams: number,
  cycles: number
) {
  await store().drop();
  await store().seed();

  const app_ = act().withState(Counter).on("Incremented").do(noop).build();

  // Create all streams with events
  for (let i = 0; i < totalStreams; i++) {
    await app_.do("increment", { stream: `s-${i}`, actor }, {});
  }

  // Bootstrap — correlate + drain until all caught up
  for (let pass = 0; pass < 10; pass++) {
    await app_.correlate({ limit: totalStreams * 2 });
    const d = await app_.drain({
      streamLimit: totalStreams,
      eventLimit: 50,
      leaseMillis: 1,
    });
    if (!d.acked.length) break;
  }

  // Now add events to only a FEW streams (simulating sparse activity)
  for (let i = 0; i < activeStreams; i++) {
    await app_.do("increment", { stream: `s-${i}`, actor }, {});
  }

  // Measure: how fast does drain process ONLY the active streams?
  const start = performance.now();
  let totalAcked = 0;
  let totalClaimed = 0;
  for (let i = 0; i < cycles; i++) {
    const d = await app_.drain({
      streamLimit: totalStreams,
      eventLimit: 50,
      leaseMillis: 1,
    });
    totalAcked += d.acked.length;
    totalClaimed += d.leased.length;
  }
  const elapsed = performance.now() - start;

  const label = `${totalStreams} total, ${activeStreams} active`;
  console.log(
    [
      `| ${label.padEnd(25)}`,
      `${String(totalClaimed).padStart(7)}`,
      `${String(totalAcked).padStart(6)}`,
      `${String(Math.round(elapsed)).padStart(7)}ms`,
      `${(elapsed / cycles).toFixed(1).padStart(8)}ms/cycle |`,
    ].join(" | ")
  );
}

console.log(
  "| Config                    | Claimed |  Acked |    Wall  | Per cycle |"
);
console.log(
  "|---------------------------|---------|--------|---------|-----------|"
);

// Key scenario: many streams, few active
for (const [total, active] of [
  [50, 5],
  [200, 10],
  [500, 10],
  [500, 50],
] as const) {
  await benchmark(total, active, 20);
}

await store().dispose();
process.exit(0);
