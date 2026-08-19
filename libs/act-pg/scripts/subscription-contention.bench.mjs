/**
 * RFC 1449 acceptance criterion 3 — what the subscription workload costs
 * Postgres under N competing workers, and how much of that cost is the event
 * log sitting next to it.
 *
 * The question this answers is not "how fast is claim" (that is
 * `claim-scale.bench.mjs`). It is whether the *write* side scales: since
 * #1487 every marking scan calls `subscribe`, every claim bumps `retry` and
 * every ack advances a watermark, so a tiny row is rewritten several times per
 * cycle per worker. Postgres answers an UPDATE by writing a new row version
 * and leaving the old one dead, so this workload manufactures garbage at the
 * rate the pipeline runs, and the partial index `claim` reads from churns with
 * it. RFC 1486 called that "the design's principal unknown".
 *
 * ## Arms
 *
 * Both run the identical subscription workload; they differ only in whether
 * the event log is being written at the same time, in the same database.
 *
 *   isolated   subscription traffic only — the ceiling a dedicated
 *              subscription store could reach
 *   shared     the same traffic with a committer writing events concurrently,
 *              which is production
 *
 * The delta between them is the part a hybrid store would remove by moving
 * subscriptions elsewhere. If it is small, the two workloads coexist happily
 * and a hybrid buys nothing; if it is large, that is the measurement that
 * justifies one. Either way the absolute numbers say whether MVCC churn hurts
 * at all, which is the prior question.
 *
 * ## What is reported
 *
 * Latency percentiles per operation (claim, ack, subscribe), aggregate claim
 * throughput, and the Postgres-specific pathologies: dead tuples accumulated,
 * autovacuum runs triggered, and the growth of the streams table and its
 * claim index over the run. A backend that is not Postgres would report the
 * first group and have nothing to say about the second — which is the point.
 *
 * Run: node libs/act-pg/scripts/subscription-contention.bench.mjs
 * Requires Postgres on :5431. WORKERS / STREAMS / SECONDS override the shape.
 */
import pg from "pg";
import { PostgresStore } from "../dist/index.js";

const SCHEMA = "sub_contention_bench";
const TABLE = "events";
const STREAMS = Number(process.env.STREAMS ?? 20_000);
const SECONDS = Number(process.env.SECONDS ?? 10);
const WORKER_COUNTS = (process.env.WORKERS ?? "1,2,4,8")
  .split(",")
  .map(Number);
/**
 * Fraction of subscriptions carrying work. A healthy steady state is sparse —
 * most targets are caught up — and claim cost tracks *eligible* rows, so a
 * benchmark that marks everything measures the worst case rather than the
 * normal one. Default 1 (worst case) to stay comparable with earlier runs.
 */
const HIT_RATE = Number(process.env.HIT_RATE ?? 1);

const pool = new pg.Pool({
  host: "localhost",
  port: 5431,
  user: "postgres",
  password: "postgres",
  max: 24,
});

const store = () =>
  new PostgresStore({ port: 5431, schema: SCHEMA, table: TABLE, max: 24 });

const streams_table = `${SCHEMA}.${TABLE}_streams`;

/** Percentile from an unsorted sample, in ms. */
const pct = (xs, p) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

const timed = async (samples, fn) => {
  const t = process.hrtime.bigint();
  const out = await fn();
  samples.push(Number(process.hrtime.bigint() - t) / 1e6);
  return out;
};

/**
 * Fresh schema with `streams` subscriptions, each marked so it has work.
 * Event ids land in randomized order so a watermark sits at a random point in
 * the global sequence — seeding stream-by-stream sorts every pending row to
 * the front of `ORDER BY at` and understates the cost.
 */
async function seed() {
  const s = store();
  await s.drop();
  await s.seed();
  await pool.query(
    `INSERT INTO ${SCHEMA}.${TABLE} (name, data, stream, version, meta)
     SELECT 'Opened', '{}'::jsonb, 's' || i, v, '{}'::jsonb
     FROM generate_series(0, $1::int - 1) i, generate_series(0, 2) v
     ORDER BY random()`,
    [STREAMS]
  );
  await pool.query(
    `INSERT INTO ${streams_table}
       (stream, source, at, retry, blocked, priority, lane, correlated_at)
     SELECT m.stream, m.stream, m.prev, -1, false, 0, 'default',
            CASE WHEN m.rn <= $1 THEN m.top ELSE m.prev END
     FROM (SELECT stream, max(id) AS top,
                  (array_agg(id ORDER BY id DESC))[2] AS prev,
                  row_number() OVER (ORDER BY random()) AS rn
           FROM ${SCHEMA}.${TABLE} GROUP BY stream) m`,
    [Math.max(1, Math.round(STREAMS * HIT_RATE))]
  );
  await pool.query(`VACUUM ANALYZE ${streams_table}`);
  return s;
}

/** Postgres-side pathology counters for the subscriptions table. */
async function pathology() {
  const { rows } = await pool.query(
    `SELECT n_live_tup, n_dead_tup, autovacuum_count, n_tup_upd, n_tup_hot_upd
     FROM pg_stat_user_tables
     WHERE schemaname = $1 AND relname = $2`,
    [SCHEMA, `${TABLE}_streams`]
  );
  const { rows: sz } = await pool.query(
    `SELECT pg_total_relation_size($1::regclass) AS table_bytes,
            COALESCE(SUM(pg_relation_size(indexrelid)), 0) AS index_bytes
     FROM pg_index WHERE indrelid = $1::regclass`,
    [streams_table]
  );
  return { ...(rows[0] ?? {}), ...(sz[0] ?? {}) };
}

/** One worker's claim→ack loop until `deadline`. */
async function drain_worker(s, by, deadline, m) {
  while (Date.now() < deadline) {
    const leases = await timed(m.claim, () => s.claim(8, 2, by, 30_000));
    if (!leases.length) {
      m.empty++;
      continue;
    }
    m.leased += leases.length;
    // Advance to the mark, the way a real ack does after a fetch.
    await timed(m.ack, () =>
      s.ack(leases.map((l) => ({ ...l, at: l.at + 1 })))
    );
  }
}

/**
 * Stands in for correlate: re-marks a rolling window of streams, which is the
 * write that #1487 put on the steady-state path. Carries priority and lane so
 * the upsert is the same shape correlate issues.
 */
async function marker(s, deadline, m) {
  let cursor = 0;
  while (Date.now() < deadline) {
    const batch = [];
    for (let i = 0; i < 200; i++) {
      const n = (cursor + i) % STREAMS;
      batch.push({
        stream: `s${n}`,
        priority: 0,
        lane: "default",
        correlated_at: 3 * STREAMS + cursor + i,
      });
    }
    cursor = (cursor + 200) % STREAMS;
    await timed(m.subscribe, () => s.subscribe(batch, cursor));
  }
}

/** The event-log workload that shares the database in the `shared` arm. */
async function committer(s, deadline, m) {
  let n = 0;
  while (Date.now() < deadline) {
    await timed(m.commit, () =>
      s.commit(
        `hot-${n % 50}`,
        [{ name: "Opened", data: {} }],
        { correlation: "c", causation: {} }
      )
    ).catch(() => {});
    n++;
  }
}

async function run(workers, with_commits) {
  const s = await seed();
  const before = await pathology();
  const m = {
    claim: [],
    ack: [],
    subscribe: [],
    commit: [],
    leased: 0,
    empty: 0,
  };
  const deadline = Date.now() + SECONDS * 1000;
  const tasks = [];
  for (let w = 0; w < workers; w++)
    tasks.push(drain_worker(s, `w${w}`, deadline, m));
  tasks.push(marker(s, deadline, m));
  if (with_commits) tasks.push(committer(s, deadline, m));
  await Promise.all(tasks);
  const after = await pathology();
  await s.dispose();

  const mb = (b) => (Number(b) / 1024 / 1024).toFixed(1);
  // Claim samples in arrival order: if accumulating dead tuples and index
  // bloat degrade the scan, the last third is slower than the first. A flat
  // ratio says the churn is being absorbed.
  const third = Math.floor(m.claim.length / 3) || 1;
  const drift =
    pct(m.claim.slice(0, third), 50) > 0
      ? pct(m.claim.slice(-third), 50) / pct(m.claim.slice(0, third), 50)
      : 1;
  return {
    workers,
    drift,
    claim_p50: pct(m.claim, 50),
    claim_p99: pct(m.claim, 99),
    claims_per_s: m.claim.length / SECONDS,
    leased_per_s: m.leased / SECONDS,
    ack_p99: pct(m.ack, 99),
    subscribe_p99: pct(m.subscribe, 99),
    dead_tuples: Number(after.n_dead_tup ?? 0),
    updates: Number(after.n_tup_upd ?? 0) - Number(before.n_tup_upd ?? 0),
    hot_pct:
      Number(after.n_tup_upd) > Number(before.n_tup_upd)
        ? Math.round(
            (100 * (Number(after.n_tup_hot_upd) - Number(before.n_tup_hot_upd))) /
              (Number(after.n_tup_upd) - Number(before.n_tup_upd))
          )
        : 0,
    vacuums:
      Number(after.autovacuum_count ?? 0) - Number(before.autovacuum_count ?? 0),
    index_mb: mb(after.index_bytes),
    index_growth_mb: mb(Number(after.index_bytes) - Number(before.index_bytes)),
  };
}

const main = async () => {
  console.log(
    `Subscription workload — ${STREAMS} subscriptions, ${HIT_RATE * 100}% pending, ${SECONDS}s per cell, PG :5431\n`
  );
  for (const arm of ["isolated", "shared"]) {
    console.log(
      `${arm === "isolated" ? "isolated (no event-log writes)" : "shared (concurrent commits — production)"}:`
    );
    console.log(
      "  W | claim p50 | claim p99 |  claims/s | leased/s | ack p99 | sub p99 | updates | HOT% | dead tup | vac | idx +MB | drift"
    );
    console.log(
      "  --|-----------|-----------|-----------|----------|---------|---------|---------|------|----------|-----|---------|------"
    );
    for (const w of WORKER_COUNTS) {
      const r = await run(w, arm === "shared");
      console.log(
        `  ${String(r.workers).padStart(1)} | ${r.claim_p50.toFixed(2).padStart(9)} | ${r.claim_p99.toFixed(2).padStart(9)} | ${r.claims_per_s.toFixed(0).padStart(9)} | ${r.leased_per_s.toFixed(0).padStart(8)} | ${r.ack_p99.toFixed(2).padStart(7)} | ${r.subscribe_p99.toFixed(2).padStart(7)} | ${String(r.updates).padStart(7)} | ${String(r.hot_pct).padStart(4)} | ${String(r.dead_tuples).padStart(8)} | ${String(r.vacuums).padStart(3)} | ${r.index_growth_mb.padStart(7)} | ${r.drift.toFixed(2).padStart(5)}`
      );
    }
    console.log("");
  }
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.end();
};

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => {});
  process.exit(1);
});
