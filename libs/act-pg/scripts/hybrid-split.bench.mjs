/**
 * #1510 — what splitting the store across two systems actually costs and buys.
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
 * The hybrid below is also the prototype of the adapter #1489 was deferred in
 * favour of. It is deliberately a few lines: since #1488 every hot method
 * belongs cleanly to one half, so routing is a lookup rather than a
 * reimplementation. The methods that touch both (`seed`, `drop`, `dispose`)
 * fan out; the ones that would need a distributed transaction (`truncate`,
 * `restore`) are not exercised here and are the real work a production hybrid
 * would have to do.
 *
 * Run:
 *   docker compose --profile bench up -d postgres-subs
 *   node libs/act-pg/scripts/hybrid-split.bench.mjs
 */
import pg from "pg";
import { PostgresStore } from "../dist/index.js";

const SCHEMA = "hybrid_bench";
const TABLE = "events";
const STREAMS = Number(process.env.STREAMS ?? 20_000);
const SECONDS = Number(process.env.SECONDS ?? 10);
const WORKER_COUNTS = (process.env.WORKERS ?? "1,4,8").split(",").map(Number);

const LOG_PORT = 5431;
const SUBS_PORT = Number(process.env.SUBS_PORT ?? 5432);

/** Methods that belong to the event log; everything else is subscription-side. */
const LOG_SIDE = new Set([
  "commit",
  "query",
  "query_stats",
  "scan",
  "restore",
  "forget_pii",
  "notify",
]);
/** Methods that must reach both halves. */
const BOTH = new Set(["seed", "drop", "dispose"]);

/**
 * The hybrid: one `Store` on the outside, two underneath. This is the shape
 * that made splitting the *port* unnecessary — callers never learn there are
 * two systems.
 */
const hybrid = (log, subs) =>
  new Proxy(
    {},
    {
      get(_t, prop) {
        if (BOTH.has(prop))
          return async (...args) => {
            const a = await log[prop](...args);
            await subs[prop](...args);
            return a;
          };
        const target = LOG_SIDE.has(prop) ? log : subs;
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    }
  );

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

const timed = async (samples, fn) => {
  const t = process.hrtime.bigint();
  const out = await fn();
  samples.push(Number(process.hrtime.bigint() - t) / 1e6);
  return out;
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
    max: 24,
  });
  const subs =
    subs_port === log_port
      ? log
      : new PostgresStore({
          port: subs_port,
          schema: SCHEMA,
          table: TABLE,
          max: 24,
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
  await pool_for(subs_port).query(
    `VACUUM ANALYZE ${SCHEMA}.${TABLE}_streams`
  );
  return { store: subs === log ? log : hybrid(log, subs), log, subs };
}

async function drain_worker(s, by, deadline, m) {
  while (Date.now() < deadline) {
    const leases = await timed(m.claim, () => s.claim(8, 2, by, 30_000));
    if (!leases.length) continue;
    m.leased += leases.length;
    await timed(m.ack, () => s.ack(leases.map((l) => ({ ...l, at: l.at + 1 }))));
  }
}

/** Stands in for correlate's marking write. */
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

/** The event-log write load, always on the log side in both arms. */
async function committer(s, deadline, m) {
  let n = 0;
  while (Date.now() < deadline) {
    await timed(m.commit, () =>
      s.commit(`hot-${n % 50}`, [{ name: "Opened", data: {} }], {
        correlation: "c",
        causation: {},
      })
    ).catch(() => {});
    n++;
  }
}

async function run(workers, split) {
  const { store, log, subs } = await seed(
    LOG_PORT,
    split ? SUBS_PORT : LOG_PORT
  );
  const m = { claim: [], ack: [], subscribe: [], commit: [], leased: 0 };
  const deadline = Date.now() + SECONDS * 1000;
  const tasks = [];
  for (let w = 0; w < workers; w++)
    tasks.push(drain_worker(store, `w${w}`, deadline, m));
  tasks.push(marker(store, deadline, m));
  tasks.push(committer(store, deadline, m));
  await Promise.all(tasks);
  await log.dispose();
  if (subs !== log) await subs.dispose();
  return {
    workers,
    claim_p50: pct(m.claim, 50),
    claim_p99: pct(m.claim, 99),
    claims_per_s: m.claim.length / SECONDS,
    leased_per_s: m.leased / SECONDS,
    ack_p50: pct(m.ack, 50),
    sub_p50: pct(m.subscribe, 50),
    commit_p50: pct(m.commit, 50),
    commits_per_s: m.commit.length / SECONDS,
  };
}

const main = async () => {
  console.log(
    `Hybrid split — ${STREAMS} subscriptions, ${SECONDS}s per cell\n` +
      `  single: events + subscriptions on :${LOG_PORT}\n` +
      `  split:  events on :${LOG_PORT}, subscriptions on :${SUBS_PORT}\n`
  );
  console.log(
    "  arm    | W | claim p50 | claim p99 | claims/s | leased/s | ack p50 | sub p50 | commit p50 | commits/s"
  );
  console.log(
    "  -------|---|-----------|-----------|----------|----------|---------|---------|------------|----------"
  );
  const results = [];
  for (const w of WORKER_COUNTS) {
    for (const split of [false, true]) {
      const r = await run(w, split);
      results.push({ split, ...r });
      console.log(
        `  ${(split ? "split" : "single").padEnd(6)} | ${String(w)} | ${r.claim_p50.toFixed(2).padStart(9)} | ${r.claim_p99.toFixed(2).padStart(9)} | ${r.claims_per_s.toFixed(0).padStart(8)} | ${r.leased_per_s.toFixed(0).padStart(8)} | ${r.ack_p50.toFixed(2).padStart(7)} | ${r.sub_p50.toFixed(2).padStart(7)} | ${r.commit_p50.toFixed(2).padStart(10)} | ${r.commits_per_s.toFixed(0).padStart(9)}`
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
  for (const p of pools.values()) await p.end();
};

main().catch(async (e) => {
  console.error(e);
  for (const p of pools.values()) await p.end().catch(() => {});
  process.exit(1);
});
