/**
 * #1510 — what splitting the store across two systems actually costs and buys.
 * #1522 — measured with a multi-process client, so the numbers are results
 * rather than lower bounds.
 *
 * `subscription-contention.bench.mjs` measured a *proxy* for the split: the
 * same workload with and without concurrent event-log writes. That captures
 * the benefit side (contention removed) and misses the cost side entirely — a
 * real split puts every `claim` and `ack` on a second server, behind its own
 * connection pool, with no shared transaction available.
 *
 * This measures the real thing, both arms end to end:
 *
 *   single   one PostgresStore on :5431 — events and subscriptions together,
 *            which is production today
 *   split    a hybrid store: event-log methods to :5431, subscription methods
 *            to :5432, a genuinely separate server
 *
 * Every worker is a **separate OS process** with its own connection pool. The
 * first version of this benchmark ran them as async tasks sharing one event
 * loop and one pool, which is not what a deployment looks like: past a handful
 * of workers the client itself becomes the bottleneck, and a saturated client
 * drags every arm toward the same number. That made the split's advantage look
 * like it narrowed under load when what was actually narrowing was the
 * benchmark's ability to tell the arms apart. Client CPU is reported per cell
 * so that condition is visible instead of inferred.
 *
 * The parent process only seeds, forks, and aggregates — it issues no load of
 * its own, so it cannot become the contended resource it is measuring.
 *
 * Run:
 *   docker compose --profile bench up -d postgres-subs
 *   pnpm build
 *   LOG_LEVEL=error node libs/act-pg/scripts/hybrid-split.bench.mjs
 */
import { fork } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { PostgresStore } from "../dist/index.js";

const SCHEMA = "hybrid_bench";
const TABLE = "events";
const STREAMS = Number(process.env.STREAMS ?? 20_000);
const SECONDS = Number(process.env.SECONDS ?? 10);
const WORKER_COUNTS = (process.env.WORKERS ?? "1,4,8").split(",").map(Number);
/**
 * How many concurrent committer processes generate the event-log write load.
 *
 * This is not a cosmetic knob. A single committer commits serially, so its
 * throughput is exactly 1/latency, and its latency is dominated by whether its
 * WAL flush finds company: Postgres amortizes one fsync across all
 * transactions committing together. On a shared server the committer rides
 * along on the drain traffic's flushes; alone on a dedicated one it pays every
 * fsync by itself. With `COMMITTERS=1` that alone-ness reads as "splitting
 * made commits slower", which is a statement about group commit, not about the
 * split. Real deployments have many concurrent writers, so the default does
 * too.
 */
const COMMITTERS = Number(process.env.COMMITTERS ?? 4);

const LOG_PORT = 5431;
const SUBS_PORT = Number(process.env.SUBS_PORT ?? 5432);

const WORKER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "hybrid-split-worker.mjs"
);
const CORES = os.cpus().length;

const pools = new Map();
const pool_for = (port) => {
  if (!pools.has(port))
    pools.set(
      port,
      new pg.Pool({
        host: "localhost",
        port,
        user: "postgres",
        password: "postgres",
        max: 24,
      })
    );
  return pools.get(port);
};

const pct = (xs, p) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

/**
 * Seed events on the log side and subscriptions on the subscription side.
 * Ids land in randomized order so a watermark sits at a random point in the
 * global sequence rather than sorting every pending row to the front.
 */
async function seed(log_port, subs_port) {
  const log = new PostgresStore({
    port: log_port,
    schema: SCHEMA,
    table: TABLE,
    max: 4,
  });
  const subs =
    subs_port === log_port
      ? log
      : new PostgresStore({
          port: subs_port,
          schema: SCHEMA,
          table: TABLE,
          max: 4,
        });
  await log.drop();
  await log.seed();
  if (subs !== log) {
    await subs.drop();
    await subs.seed();
  }

  await pool_for(log_port).query(
    `INSERT INTO ${SCHEMA}.${TABLE} (name, data, stream, version, meta)
     SELECT 'Opened', '{}'::jsonb, 's' || i, v, '{}'::jsonb
     FROM generate_series(0, $1::int - 1) i, generate_series(0, 2) v
     ORDER BY random()`,
    [STREAMS]
  );
  // Subscriptions carry ids from the log's sequence — the whole point of the
  // work mark is that the subscription side only ever *compares* them, so they
  // stay meaningful across a server boundary.
  await pool_for(subs_port).query(
    `INSERT INTO ${SCHEMA}.${TABLE}_streams
       (stream, source, at, retry, blocked, priority, lane, correlated_at)
     SELECT 's' || i, 's' || i, 3 * i + 1, -1, false, 0, 'default', 3 * i + 2
     FROM generate_series(0, $1::int - 1) i`,
    [STREAMS]
  );
  await pool_for(subs_port).query(`VACUUM ANALYZE ${SCHEMA}.${TABLE}_streams`);
  await log.dispose();
  if (subs !== log) await subs.dispose();
}

/**
 * Fork one child per role and wait for all of them to report.
 *
 * Children are started before the deadline is computed against, and every one
 * gets the same absolute deadline, so they overlap for the full window rather
 * than staggering by spawn cost.
 */
function spawn_all(roles, subs_port) {
  // Node process startup is ~80ms; give every child the same absolute stop
  // time far enough out that spawn skew is noise against the window.
  const deadline = Date.now() + 1_000 + SECONDS * 1000;
  return Promise.all(
    roles.map(
      ({ role, id }) =>
        new Promise((resolve, reject) => {
          const child = fork(WORKER, {
            env: {
              ...process.env,
              ROLE: role,
              WORKER_ID: String(id ?? 0),
              LOG_PORT: String(LOG_PORT),
              SUBS_PORT: String(subs_port),
              SCHEMA,
              TABLE,
              STREAMS: String(STREAMS),
              DEADLINE: String(deadline),
            },
            stdio: ["ignore", "inherit", "inherit", "ipc"],
          });
          let report;
          child.on("message", (m) => {
            report = m;
          });
          child.on("error", reject);
          child.on("exit", (code) =>
            report
              ? resolve(report)
              : reject(new Error(`${role} worker exited ${code} with no report`))
          );
        })
    )
  );
}

async function run(workers, split) {
  const subs_port = split ? SUBS_PORT : LOG_PORT;
  await seed(LOG_PORT, subs_port);

  const roles = [{ role: "marker" }];
  for (let c = 0; c < COMMITTERS; c++) roles.push({ role: "committer", id: c });
  for (let w = 0; w < workers; w++) roles.push({ role: "drain", id: w });

  const reports = await spawn_all(roles, subs_port);

  const all = (key) => reports.flatMap((r) => r[key]);
  const claim = all("claim");
  const cpu_ms = reports.reduce((a, r) => a + r.cpu_ms, 0);
  // The window every rate is denominated in: the widest child window, since
  // they all stop together and the first to start bounds the overlap.
  const window = Math.max(...reports.map((r) => r.wall_ms)) / 1000;

  return {
    workers,
    claim_p50: pct(claim, 50),
    claim_p99: pct(claim, 99),
    claims_per_s: claim.length / window,
    leased_per_s: reports.reduce((a, r) => a + r.leased, 0) / window,
    ack_p50: pct(all("ack"), 50),
    sub_p50: pct(all("subscribe"), 50),
    commit_p50: pct(all("commit"), 50),
    commits_per_s: all("commit").length / window,
    // Fraction of the machine the benchmark client consumed. Approaching 1.0
    // means the client, not Postgres, set the ceiling — and the cell should be
    // read as a lower bound.
    client_load: cpu_ms / 1000 / (window * CORES),
  };
}

const main = async () => {
  console.log(
    `Hybrid split — ${STREAMS} subscriptions, ${SECONDS}s per cell, ` +
      `multi-process client on ${CORES} cores\n` +
      `  single: events + subscriptions on :${LOG_PORT}\n` +
      `  split:  events on :${LOG_PORT}, subscriptions on :${SUBS_PORT}\n`
  );
  console.log(
    "  arm    | W | claim p50 | claim p99 | claims/s | leased/s | ack p50 | sub p50 | commit p50 | commits/s | client"
  );
  console.log(
    "  -------|---|-----------|-----------|----------|----------|---------|---------|------------|-----------|-------"
  );
  const results = [];
  for (const w of WORKER_COUNTS) {
    for (const split of [false, true]) {
      const r = await run(w, split);
      results.push({ split, ...r });
      console.log(
        `  ${(split ? "split" : "single").padEnd(6)} | ${String(w)} | ${r.claim_p50.toFixed(2).padStart(9)} | ${r.claim_p99.toFixed(2).padStart(9)} | ${r.claims_per_s.toFixed(0).padStart(8)} | ${r.leased_per_s.toFixed(0).padStart(8)} | ${r.ack_p50.toFixed(2).padStart(7)} | ${r.sub_p50.toFixed(2).padStart(7)} | ${r.commit_p50.toFixed(2).padStart(10)} | ${r.commits_per_s.toFixed(0).padStart(9)} | ${(r.client_load * 100).toFixed(0).padStart(5)}%`
      );
    }
  }
  console.log("\n  delta (split ÷ single), >1 means the split is slower:");
  for (const w of WORKER_COUNTS) {
    const a = results.find((r) => !r.split && r.workers === w);
    const b = results.find((r) => r.split && r.workers === w);
    console.log(
      `  W=${w}: claim p50 ${(b.claim_p50 / a.claim_p50).toFixed(2)}x, ` +
        `leased/s ${(b.leased_per_s / a.leased_per_s).toFixed(2)}x, ` +
        `ack p50 ${(b.ack_p50 / a.ack_p50).toFixed(2)}x, ` +
        `commits/s ${(b.commits_per_s / a.commits_per_s).toFixed(2)}x`
    );
  }
  const hot = results.filter((r) => r.client_load > 0.8);
  if (hot.length)
    console.log(
      `\n  WARNING: ${hot.length} cell(s) ran the client above 80% of ${CORES} cores.\n` +
        "  Those are lower bounds — rerun with fewer workers or a bigger machine."
    );
  for (const p of pools.values()) await p.end();
};

main().catch(async (e) => {
  console.error(e);
  for (const p of pools.values()) await p.end().catch(() => {});
  process.exit(1);
});
