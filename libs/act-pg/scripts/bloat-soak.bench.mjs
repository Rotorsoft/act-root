/**
 * #1523 — does subscription-table churn settle, or keep getting worse?
 *
 * Every `ack` rewrites a small row. Postgres answers an UPDATE by writing a
 * new copy of the row and leaving the old one behind for autovacuum to reclaim
 * later, so a table that is updated constantly accumulates dead rows and its
 * indexes grow. Over a ten-second benchmark cell that is invisible. Nobody had
 * watched it for hours.
 *
 * The distinction that matters:
 *
 *   settles     dead rows and index size rise, autovacuum catches up, and both
 *               level off at some steady state. Postgres is fine here and a
 *               different storage engine buys nothing.
 *   compounds   they keep climbing and latency follows. That is the evidence
 *               that would justify putting subscriptions on something without
 *               this behaviour, such as Redis.
 *
 * Short runs cannot tell these apart, because autovacuum barely runs at all in
 * ten seconds. This one runs for hours and samples on a fixed interval, so the
 * answer is a curve rather than a number.
 *
 * Every worker is a separate OS process (#1522), so the load is real
 * competing consumers rather than tasks sharing one event loop.
 *
 * Run out of band — not in CI:
 *   docker compose up -d
 *   pnpm build
 *   LOG_LEVEL=error MINUTES=360 node libs/act-pg/scripts/bloat-soak.bench.mjs
 */
import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { PostgresStore } from "../dist/index.js";

const SCHEMA = "bloat_soak";
const TABLE = "events";
const STREAMS = Number(process.env.STREAMS ?? 20_000);
const MINUTES = Number(process.env.MINUTES ?? 360);
const SAMPLE_SEC = Number(process.env.SAMPLE_SEC ?? 60);
const WORKERS = Number(process.env.WORKERS ?? 4);
const COMMITTERS = Number(process.env.COMMITTERS ?? 2);
const PORT = Number(process.env.PORT ?? 5431);
const OUT =
  process.env.OUT ?? path.join(process.cwd(), "bloat-soak.csv");

const WORKER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "hybrid-split-worker.mjs"
);
const STREAMS_TABLE = `${TABLE}_streams`;

const pool = new pg.Pool({
  host: "localhost",
  port: PORT,
  user: "postgres",
  password: "postgres",
  max: 4,
});

const pct = (xs, p) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

async function seed() {
  const store = new PostgresStore({
    port: PORT,
    schema: SCHEMA,
    table: TABLE,
    max: 4,
  });
  await store.drop();
  await store.seed();
  await pool.query(
    `INSERT INTO ${SCHEMA}.${TABLE} (name, data, stream, version, meta)
     SELECT 'Opened', '{}'::jsonb, 's' || i, v, '{}'::jsonb
     FROM generate_series(0, $1::int - 1) i, generate_series(0, 2) v
     ORDER BY random()`,
    [STREAMS]
  );
  await pool.query(
    `INSERT INTO ${SCHEMA}.${STREAMS_TABLE}
       (stream, source, at, retry, blocked, priority, lane, correlated_at)
     SELECT 's' || i, 's' || i, 3 * i + 1, -1, false, 0, 'default', 3 * i + 2
     FROM generate_series(0, $1::int - 1) i`,
    [STREAMS]
  );
  await pool.query(`VACUUM ANALYZE ${SCHEMA}.${STREAMS_TABLE}`);
  await store.dispose();
}

/**
 * Whether `pgstattuple` is installed. It reports real index bloat rather than
 * raw size, which is the difference between "the index grew" and "the index is
 * mostly holes". Optional — the run degrades to sizes if it is unavailable.
 */
let has_pgstattuple = false;
const try_pgstattuple = async () => {
  try {
    await pool.query("CREATE EXTENSION IF NOT EXISTS pgstattuple");
    has_pgstattuple = true;
  } catch {
    has_pgstattuple = false;
  }
};

async function sample_db() {
  const { rows } = await pool.query(
    `SELECT n_tup_upd, n_tup_hot_upd, n_dead_tup, n_live_tup,
            autovacuum_count, vacuum_count,
            pg_table_size($1) AS table_bytes,
            pg_indexes_size($1) AS index_bytes
       FROM pg_stat_user_tables
      WHERE schemaname = $2 AND relname = $3`,
    [`${SCHEMA}.${STREAMS_TABLE}`, SCHEMA, STREAMS_TABLE]
  );
  const r = rows[0];
  let leaf_density = null;
  if (has_pgstattuple) {
    try {
      const idx = await pool.query(
        `SELECT avg_leaf_density FROM pgstatindex($1)`,
        [`${SCHEMA}.${TABLE}_streams_at_ix`]
      );
      leaf_density = idx.rows[0]?.avg_leaf_density ?? null;
    } catch {
      leaf_density = null;
    }
  }
  return {
    n_tup_upd: Number(r.n_tup_upd),
    n_tup_hot_upd: Number(r.n_tup_hot_upd),
    dead: Number(r.n_dead_tup),
    live: Number(r.n_live_tup),
    autovacuums: Number(r.autovacuum_count) + Number(r.vacuum_count),
    table_mb: Number(r.table_bytes) / 1e6,
    index_mb: Number(r.index_bytes) / 1e6,
    leaf_density,
  };
}

const empty = () => ({
  claim: [],
  ack: [],
  subscribe: [],
  commit: [],
  leased: 0,
});

async function main() {
  console.log(
    `Bloat soak — ${STREAMS} subscriptions, ${WORKERS} drain workers, ` +
      `${COMMITTERS} committers\n` +
      `  ${MINUTES} minutes, sampling every ${SAMPLE_SEC}s, writing ${OUT}\n`
  );
  await seed();
  await try_pgstattuple();
  if (!has_pgstattuple)
    console.log(
      "  note: pgstattuple unavailable — reporting index size without density\n"
    );

  const deadline = Date.now() + 1_000 + MINUTES * 60_000;
  const roles = [{ role: "marker" }];
  for (let c = 0; c < COMMITTERS; c++) roles.push({ role: "committer", id: c });
  for (let w = 0; w < WORKERS; w++) roles.push({ role: "drain", id: w });

  let bucket = empty();
  const children = roles.map(({ role, id }) => {
    const child = fork(WORKER, {
      env: {
        ...process.env,
        ROLE: role,
        WORKER_ID: String(id ?? 0),
        LOG_PORT: String(PORT),
        SUBS_PORT: String(PORT),
        SCHEMA,
        TABLE,
        STREAMS: String(STREAMS),
        DEADLINE: String(deadline),
        REPORT_MS: String(SAMPLE_SEC * 1000),
      },
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    child.on("message", (m) => {
      bucket.claim.push(...m.claim);
      bucket.ack.push(...m.ack);
      bucket.subscribe.push(...m.subscribe);
      bucket.commit.push(...m.commit);
      bucket.leased += m.leased;
    });
    return child;
  });

  const header =
    "minute,claim_p50,claim_p99,ack_p50,sub_p50,commit_p50,leased_per_s," +
    "dead,live,hot_pct,autovacuums,table_mb,index_mb,leaf_density";
  fs.writeFileSync(OUT, `${header}\n`);
  console.log(
    "  min | claim p50 | claim p99 | ack p50 | leased/s |    dead | hot% | vac | table MB | index MB | density"
  );
  console.log(
    "  ----|-----------|-----------|---------|----------|---------|------|-----|----------|----------|--------"
  );

  const started = Date.now();
  let prev = await sample_db();

  const tick = async () => {
    const window = bucket;
    bucket = empty();
    const db = await sample_db();
    const minute = (Date.now() - started) / 60_000;
    // HOT updates are the ones Postgres can do without touching indexes; the
    // rest leave index work behind. Measured per window, not cumulatively,
    // so a change in the ratio is visible when it happens.
    const upd = db.n_tup_upd - prev.n_tup_upd;
    const hot = db.n_tup_hot_upd - prev.n_tup_hot_upd;
    const hot_pct = upd > 0 ? Math.round((hot / upd) * 100) : 0;
    prev = db;

    const row = {
      minute: minute.toFixed(1),
      claim_p50: pct(window.claim, 50).toFixed(2),
      claim_p99: pct(window.claim, 99).toFixed(2),
      ack_p50: pct(window.ack, 50).toFixed(2),
      sub_p50: pct(window.subscribe, 50).toFixed(2),
      commit_p50: pct(window.commit, 50).toFixed(2),
      leased_per_s: (window.leased / SAMPLE_SEC).toFixed(0),
      dead: db.dead,
      live: db.live,
      hot_pct,
      autovacuums: db.autovacuums,
      table_mb: db.table_mb.toFixed(1),
      index_mb: db.index_mb.toFixed(1),
      leaf_density: db.leaf_density ?? "",
    };
    fs.appendFileSync(OUT, `${Object.values(row).join(",")}\n`);
    console.log(
      `  ${row.minute.padStart(4)}| ${row.claim_p50.padStart(9)} | ${row.claim_p99.padStart(9)} | ` +
        `${row.ack_p50.padStart(7)} | ${row.leased_per_s.padStart(8)} | ${String(row.dead).padStart(7)} | ` +
        `${String(hot_pct).padStart(4)} | ${String(row.autovacuums).padStart(3)} | ` +
        `${row.table_mb.padStart(8)} | ${row.index_mb.padStart(8)} | ${String(row.leaf_density).padStart(7)}`
    );
  };

  // Close each window half an interval after the children flush theirs, so
  // their samples have landed. Without the offset the parent and the children
  // fire together and the first window closes empty.
  let timer;
  const offset = setTimeout(() => {
    timer = setInterval(tick, SAMPLE_SEC * 1000);
  }, SAMPLE_SEC * 500);
  await new Promise((resolve) =>
    setTimeout(resolve, deadline - Date.now() + 2_000)
  );
  clearTimeout(offset);
  clearInterval(timer);
  for (const c of children) c.kill();
  await pool.end();
  console.log(`\n  done — ${OUT}`);
}

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => {});
  process.exit(1);
});
