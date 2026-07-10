/**
 * Commit-throughput bench for the visibility lock (#1178).
 *
 * Measures the cost of serializing commit visibility with
 * `pg_advisory_xact_lock` on the append path: sequential single-stream
 * commits (the lock is uncontended) and concurrent multi-stream commits
 * (the lock is the serialization point the fix introduces).
 *
 * Run against the docker Postgres on :5431, before and after the change:
 *
 *   npx tsx libs/act-pg/scripts/commit-lock.ts
 */
import type { EventMeta } from "@rotorsoft/act";
import { PostgresStore } from "../src/index.js";

const store = new PostgresStore({ port: 5431, table: "commit_lock_bench" });
const meta: EventMeta = { correlation: "bench", causation: {} };

async function sequential(n: number) {
  const start = performance.now();
  for (let i = 0; i < n; i++) {
    await store.commit("seq-1", [{ name: "Bench", data: { i } }], meta);
  }
  const ms = performance.now() - start;
  return { ms, rate: Math.round((n / ms) * 1000) };
}

async function concurrent(n: number, workers: number) {
  // One stream per worker: no intra-stream version races, so the
  // measurement isolates exactly what the visibility lock serializes —
  // concurrent commits to different streams.
  const per_worker = Math.floor(n / workers);
  const start = performance.now();
  const worker = async (w: number) => {
    for (let i = 0; i < per_worker; i++) {
      await store.commit(`con-${w}`, [{ name: "Bench", data: { i } }], meta);
    }
  };
  await Promise.all(Array.from({ length: workers }, (_, w) => worker(w)));
  const ms = performance.now() - start;
  return { ms, rate: Math.round(((per_worker * workers) / ms) * 1000) };
}

await store.drop();
await store.seed();
// warmup
await sequential(50);
const seq = await sequential(500);
const con = await concurrent(500, 10);
console.log(
  `sequential 1-stream: ${seq.rate} commits/s (${seq.ms.toFixed(0)}ms / 500)`
);
console.log(
  `concurrent 10 streams x 10 workers: ${con.rate} commits/s (${con.ms.toFixed(0)}ms / 500)`
);
await store.drop();
await store.dispose();
