/**
 * Scenario B — cold-start load and projection rebuild against a seeded
 * store (run evidence/seed.ts first).
 *
 *   npx tsx evidence/coldstart.ts
 *
 * Measures, in order:
 *  1. cold-start load of the hot aggregate (full replay, no snapshot)
 *  2. the same load after writing a snapshot at the head — the cliff
 *     the cache-and-snapshots architecture page tells you to expect
 *  3. projection-rebuild wall-clock: a batched projection folding every
 *     Ticked event in the store through the drain pipeline
 */
import {
  act,
  cache,
  dispose,
  projection,
  SNAP_EVENT,
  store,
} from "@rotorsoft/act";
import { PostgresStore } from "@rotorsoft/act-pg";
import { z } from "zod";
import { Counter, config, human, ms } from "./shared.js";

async function main() {
  const { table, pg: pgconf } = config();
  const pgstore = new PostgresStore({ ...pgconf, table });
  await pgstore.seed();
  store(pgstore);

  // 1. cold start, no snapshot — full replay of hot-1
  const app = act().withState(Counter).build();
  await cache().invalidate("hot-1");
  let t0 = process.hrtime.bigint();
  const cold = await app.load(Counter, "hot-1");
  const cold_ms = ms(t0);
  console.log(
    `cold start (no snapshot) : hot-1 @ v${human(cold.event?.version ?? 0)} in ${(cold_ms / 1000).toFixed(2)}s`
  );

  // 2. snapshot at head, then load again — resumes from the snapshot.
  // The cache is invalidated in between, so this measures the snapshot
  // path, not the in-process cache hit.
  await pgstore.commit("hot-1", [{ name: SNAP_EVENT, data: cold.state }], {
    correlation: "evidence",
    causation: {},
  });
  await cache().invalidate("hot-1");
  t0 = process.hrtime.bigint();
  const warm = await app.load(Counter, "hot-1");
  const warm_ms = ms(t0);
  console.log(
    `cold start (snapshot)    : hot-1 @ v${human(warm.event?.version ?? 0)} in ${warm_ms.toFixed(0)}ms (${Math.round(cold_ms / Math.max(warm_ms, 1))}x faster)`
  );

  // 3. projection rebuild — batched fold over every Ticked in the store
  let folded = 0;
  const Tally = projection("evidence-tally")
    .on({ Ticked: z.object({ n: z.number() }) })
    .do(async function tally() {
      folded++;
    })
    .batch(async (events) => {
      folded += events.length;
    })
    .build();
  const app2 = act().withState(Counter).withProjection(Tally).build();
  await app2.correlate(); // registers the projection's static subscription
  t0 = process.hrtime.bigint();
  await app2.reset(["evidence-tally"]);
  let pass = 0;
  for (;;) {
    const d = await app2.drain({ eventLimit: 10_000, leaseMillis: 60_000 });
    if (d.acked.length === 0) break;
    if (++pass % 50 === 0)
      console.log(
        `  ...rebuild folded ${human(folded)} (${(ms(t0) / 1000).toFixed(0)}s)`
      );
  }
  const rb_ms = ms(t0);
  console.log(
    `projection rebuild       : ${human(folded)} events folded in ${(rb_ms / 1000).toFixed(1)}s → ${Math.round((folded / rb_ms) * 1000)} events/s`
  );

  await dispose()();
}

void main();
