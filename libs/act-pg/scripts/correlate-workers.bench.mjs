/**
 * How much of the event log does correlate read when workers are real
 * processes? (#1532, and the measurement RFC 1484 deferred single-writer on.)
 *
 * Correlate has never been measured multi-process. Every earlier bench ran
 * several Acts inside one Node process with `notify` off, so only the process
 * that committed was ever armed, and only it ever scanned. That understates
 * the cost by exactly the factor this bench exists to find.
 *
 * Each worker keeps its **own** correlate checkpoint: `_checkpoint` is
 * per-instance, seeded from the durable value once at `init()` and advanced
 * locally from then on. So N workers each scan the same events. The marks
 * they write are idempotent (`GREATEST`), so the duplication is wasteful
 * rather than wrong — the question is how wasteful.
 *
 * The number that matters is **reads per committed event**: total events read
 * by every correlate scan across all workers, divided by events committed. A
 * value near N means every worker reads everything.
 *
 * Run:
 *   docker compose up -d
 *   pnpm build
 *   LOG_LEVEL=error node libs/act-pg/scripts/correlate-workers.bench.mjs
 */
import { fork } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { PostgresStore } from "../dist/index.js";

const SCHEMA = "correlate_workers_bench";
const TABLE = "events";
const WORKER_COUNTS = (process.env.WORKERS ?? "1,2,4,8").split(",").map(Number);
const SECONDS = Number(process.env.SECONDS ?? 20);
const COMMITS_PER_SEC = Number(process.env.COMMITS_PER_SEC ?? 20);
const AGGREGATES = Number(process.env.AGGREGATES ?? 500);
const CYCLE_MS = Number(process.env.CYCLE_MS ?? 100);
const PORT = Number(process.env.PORT ?? 5431);

const WORKER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "correlate-workers-worker.mjs"
);
const CORES = os.cpus().length;

const pool = new pg.Pool({
  host: "localhost",
  port: PORT,
  user: "postgres",
  password: "postgres",
  max: 4,
});

async function reset() {
  const store = new PostgresStore({
    port: PORT,
    schema: SCHEMA,
    table: TABLE,
    max: 4,
  });
  await store.drop();
  await store.seed();
  await store.dispose();
}

/**
 * Commit at a fixed rate from the parent, so the workers are pure consumers
 * and none of them is armed by a local commit — every scan they do is the
 * result of a `notify` from this process, which is the deployed shape.
 */
async function commit_load(deadline) {
  const writer = new PostgresStore({
    port: PORT,
    schema: SCHEMA,
    table: TABLE,
    notify: true,
    max: 4,
  });
  let n = 0;
  const gap = 1000 / COMMITS_PER_SEC;
  while (Date.now() < deadline) {
    await writer
      .commit(
        `order-${n % AGGREGATES}`,
        [{ name: "Placed", data: {} }],
        { correlation: "c", causation: {} }
      )
      .catch(() => {});
    n++;
    await new Promise((r) => setTimeout(r, gap));
  }
  await writer.dispose();
  return n;
}

function spawn_workers(count, deadline) {
  return Promise.all(
    Array.from(
      { length: count },
      (_, id) =>
        new Promise((resolve, reject) => {
          const child = fork(WORKER, {
            env: {
              ...process.env,
              WORKER_ID: String(id),
              SCHEMA,
              TABLE,
              PORT: String(PORT),
              DEADLINE: String(deadline),
              CYCLE_MS: String(CYCLE_MS),
            },
            stdio: ["ignore", "inherit", "inherit", "ipc"],
          });
          let report;
          child.on("message", (msg) => {
            report = msg;
          });
          child.on("error", reject);
          child.on("exit", (code) =>
            report
              ? resolve(report)
              : reject(new Error(`worker exited ${code} with no report`))
          );
        })
    )
  );
}

async function run(workers) {
  await reset();
  const deadline = Date.now() + 1_500 + SECONDS * 1000;
  const [reports, committed] = await Promise.all([
    spawn_workers(workers, deadline),
    commit_load(deadline),
  ]);

  const sum = (k) => reports.reduce((a, r) => a + r[k], 0);
  const window = Math.max(...reports.map((r) => r.wall_ms)) / 1000;
  return {
    workers,
    committed,
    correlate_calls: sum("correlate_calls"),
    correlate_events: sum("correlate_events"),
    fetch_events: sum("fetch_events"),
    subscribe_calls: sum("subscribe_calls"),
    subscribe_entries: sum("subscribe_entries"),
    claim_calls: sum("claim_calls"),
    handled: sum("handled"),
    // The headline: how many times the log was read for each event committed.
    reads_per_event: sum("correlate_events") / Math.max(1, committed),
    client_load: sum("cpu_ms") / 1000 / (window * CORES),
  };
}

const main = async () => {
  console.log(
    `Correlate under real worker processes — ${COMMITS_PER_SEC} commits/s, ` +
      `${AGGREGATES} aggregates, ${SECONDS}s per cell, notify on\n`
  );
  console.log(
    "  W | committed | scans | scan events | reads/event | subscribes | entries | claims | fetched | handled | client"
  );
  console.log(
    "  --|-----------|-------|-------------|-------------|------------|---------|--------|---------|---------|-------"
  );
  for (const w of WORKER_COUNTS) {
    const r = await run(w);
    console.log(
      `  ${String(r.workers).padStart(1)} | ${String(r.committed).padStart(9)} | ${String(r.correlate_calls).padStart(5)} | ` +
        `${String(r.correlate_events).padStart(11)} | ${r.reads_per_event.toFixed(2).padStart(11)} | ` +
        `${String(r.subscribe_calls).padStart(10)} | ${String(r.subscribe_entries).padStart(7)} | ` +
        `${String(r.claim_calls).padStart(6)} | ${String(r.fetch_events).padStart(7)} | ` +
        `${String(r.handled).padStart(7)} | ${(r.client_load * 100).toFixed(0).padStart(5)}%`
    );
  }
  await pool.end();
};

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => {});
  process.exit(1);
});
