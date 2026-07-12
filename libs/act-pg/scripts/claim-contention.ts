/**
 * Concurrent-claim contention benchmark (ACT-1201).
 *
 * Competing consumers with DISJOINT candidate frontiers must each claim their
 * own slice in a concurrent round. Half the fleet claims the lagging frontier
 * (most-behind streams), half claims the leading frontier (most-ahead) over a
 * distinct-watermark set of streams — so their candidate sets never overlap.
 * A healthy claim path serves every worker (utilization = 100%, 0 wasted).
 *
 * The pre-ACT-1201 `claim()` locked the ENTIRE eligible frontier in its
 * `available` CTE (`FOR UPDATE SKIP LOCKED`, no LIMIT), so the first worker to
 * execute row-locked every stream — including the ones a competing worker
 * wanted — and the rest SKIP-LOCKed past everything and got nothing. The fix
 * locks only each worker's <= lagging+leading candidates, restoring full
 * utilization. The lock window scales with the registered-stream count, so the
 * gap widens with the frontier (`extra` caught-up streams below).
 *
 * Run: npx tsx libs/act-pg/scripts/claim-contention.ts
 */
import { randomUUID } from "node:crypto";
import type { EventMeta } from "@rotorsoft/act";
import { Pool } from "pg";
import { PostgresStore } from "../src/postgres-store.js";

const PORT = 5431;
const SCHEMA = "claim_contention_bench";
const META: EventMeta = { correlation: "", causation: {} };
const batch = (n: number) =>
  Array.from({ length: n }, (_, k) => ({ name: "Inc", data: { seq: k } }));

const control = new PostgresStore({ port: PORT, schema: SCHEMA });
const pool = new Pool({
  host: "localhost",
  port: PORT,
  database: "postgres",
  user: "postgres",
  password: "postgres",
});

/** Seed `n` eligible streams with distinct, increasing watermarks. */
async function seed(n: number) {
  await control.drop();
  await control.seed();
  for (let i = 0; i < n; i++) {
    const s = `s-${i}`;
    await control.commit(s, batch(1), META);
    await control.subscribe([{ stream: s, source: s }]);
  }
  // Distinct watermarks (all below the event id) so lagging and leading
  // frontiers are disjoint; event ids are a global serial well past `n`.
  await pool.query(
    `UPDATE "${SCHEMA}"."events_streams" s
       SET at = sub.rn
       FROM (SELECT stream, row_number() OVER (ORDER BY stream) - 1 AS rn
             FROM "${SCHEMA}"."events_streams") sub
      WHERE s.stream = sub.stream`
  );
}

/**
 * Two competing workers over a frontier of `streams` eligible streams: worker
 * A claims the `perWorker` most-behind (lagging), worker B the `perWorker`
 * most-ahead (leading) — disjoint candidate sets. Both should always win their
 * full slice. Growing `streams` past `2*perWorker` grows the frontier the
 * buggy code over-locks, without changing what either worker actually wants.
 */
async function benchmark(streams: number, perWorker: number, rounds: number) {
  const A = new PostgresStore({ port: PORT, schema: SCHEMA });
  const B = new PostgresStore({ port: PORT, schema: SCHEMA });
  let bothWon = 0;
  let wall = 0;
  try {
    for (let r = 0; r < rounds; r++) {
      await seed(streams);
      const by = randomUUID();
      const start = performance.now();
      const [a, b] = await Promise.all([
        A.claim(perWorker, 0, `${by}-A`, 30_000),
        B.claim(0, perWorker, `${by}-B`, 30_000),
      ]);
      wall += performance.now() - start;
      if (a.length === perWorker && b.length === perWorker) bothWon++;
    }
  } finally {
    await Promise.all([A.dispose(), B.dispose()]);
  }
  const success = ((bothWon / rounds) * 100).toFixed(0);
  const label = `2w, ${perWorker}/worker, ${streams}s frontier`;
  console.log(
    `| ${label.padEnd(32)} | ${success.padStart(9)}% | ${(wall / rounds).toFixed(1).padStart(9)}ms |`
  );
}

console.log("| Config                           | Both won  | Per round |");
console.log("|----------------------------------|-----------|-----------|");
for (const [streams, perWorker] of [
  [10, 5],
  [50, 5],
  [200, 5],
] as const) {
  await benchmark(streams, perWorker, 10);
}

await pool.end();
await control.dispose();
process.exit(0);
