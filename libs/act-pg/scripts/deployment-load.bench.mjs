/**
 * #1510 — what a running deployment actually costs the database.
 *
 * The other benches in here are microbenchmarks: they call one store method in
 * a tight loop and report its latency. That answers "how fast is claim" and
 * says nothing about what a deployment does to a database over a day, which is
 * the question an operator has.
 *
 * This drives the real orchestrator instead. W Act instances share one store,
 * each running its own settle loop at a realistic cadence, while a writer
 * commits at a fixed rate. Nothing is saturated on purpose — a production
 * system spends most of its time between bursts, and the cost of *being idle*
 * is what compounds across workers and hours.
 *
 * Reported per arm:
 *   - store round trips, split by method, over the window
 *   - reaction latency (commit → handler ran), p50/p99
 *   - Postgres-side rows read and tuples returned, from pg_stat_statements
 *     when available and pg_stat_database otherwise
 *
 * Run:
 *   docker compose up -d
 *   node libs/act-pg/scripts/deployment-load.bench.mjs
 *
 * WORKERS / SECONDS / COMMITS_PER_SEC / AGGREGATES override the shape.
 */
import { act, state, store as port, ZodEmpty } from "../../act/dist/index.js";
import pg from "pg";
import { z } from "zod";
import { PostgresStore } from "../dist/index.js";

const SCHEMA = "deployment_bench";
const WORKERS = Number(process.env.WORKERS ?? 4);
const SECONDS = Number(process.env.SECONDS ?? 30);
const COMMITS_PER_SEC = Number(process.env.COMMITS_PER_SEC ?? 20);
const AGGREGATES = Number(process.env.AGGREGATES ?? 500);
const CYCLE_MS = Number(process.env.CYCLE_MS ?? 100);

const actor = { id: "bench", name: "bench" };

const Order = state({ Order: z.object({ placed: z.boolean() }) })
  .init(() => ({ placed: false }))
  .emits({ Placed: ZodEmpty })
  .patch({ Placed: () => ({ placed: true }) })
  .on({ place: ZodEmpty })
  .emit(() => ["Placed", {}])
  .build();

const pool = new pg.Pool({
  host: "localhost",
  port: 5431,
  user: "postgres",
  password: "postgres",
  max: 32,
});

/** Wrap a store so every method call is counted, per method. */
const counting = (s, counts) =>
  new Proxy(s, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value !== "function") return value;
      return (...args) => {
        counts[prop] = (counts[prop] ?? 0) + 1;
        return value.apply(target, args);
      };
    },
  });

const pct = (xs, p) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

/** Rows read by this database, as Postgres sees it. */
async function db_counters() {
  const { rows } = await pool.query(
    `SELECT tup_returned, tup_fetched, xact_commit, blks_read, blks_hit
     FROM pg_stat_database WHERE datname = current_database()`
  );
  return rows[0] ?? {};
}

async function run() {
  const counts = {};
  const latency = [];
  /** stream → wall clock of its most recent commit, for latency. */
  const committed_at = new Map();

  const base = new PostgresStore({
    port: 5431,
    schema: SCHEMA,
    table: "events",
    max: 32,
  });
  await base.drop();
  await base.seed();
  port(counting(base, counts));

  // W worker Acts, each with its own settle loop, all sharing the store —
  // competing consumers, the deployment shape the docs describe.
  const workers = [];
  for (let w = 0; w < WORKERS; w++) {
    const app = act()
      .withState(Order)
      .on("Placed")
      .do(async function react(event) {
        // Latency measured in-process, from the wall clock at commit to the
        // wall clock in the handler. An earlier version subtracted the
        // store-assigned `created` and produced impossible numbers (297s
        // inside a 20s window), so the reading is taken entirely on this side.
        const at = committed_at.get(event.stream);
        if (at !== undefined) latency.push(Date.now() - at);
      })
      .to((e) => ({ target: `handled-${e.stream}`, source: e.stream }))
      .build();
    workers.push(app);
  }

  // A writer Act for the commit side, so `do()` arms the way production does.
  const writer = workers[0];

  const before = await db_counters();
  const started = Date.now();
  const deadline = started + SECONDS * 1000;

  // Every worker settles on its own cadence — this is the loop that used to
  // scan on every tick whether or not anything had happened.
  const tickers = workers.map((app) =>
    setInterval(() => {
      app.settle({ debounceMs: 0 });
    }, CYCLE_MS)
  );

  // Commit at a fixed, unsaturated rate.
  const gap = 1000 / COMMITS_PER_SEC;
  let n = 0;
  while (Date.now() < deadline) {
    const stream = `agg-${n % AGGREGATES}`;
    committed_at.set(stream, Date.now());
    await writer.do("place", { stream, actor }, {});
    n++;
    const drift = started + n * gap - Date.now();
    if (drift > 0) await new Promise((r) => setTimeout(r, drift));
  }

  for (const t of tickers) clearInterval(t);
  // Let in-flight settles finish so their round trips are counted.
  await new Promise((r) => setTimeout(r, 500));
  for (const app of workers) await app.shutdown();
  const after = await db_counters();
  await base.dispose();

  const delta = (k) => Number(after[k] ?? 0) - Number(before[k] ?? 0);
  return {
    commits: n,
    reactions: latency.length,
    lat_p50: pct(latency, 50),
    lat_p99: pct(latency, 99),
    calls: counts,
    tup_returned: delta("tup_returned"),
    xacts: delta("xact_commit"),
  };
}

const main = async () => {
  console.log(
    `Deployment load — ${WORKERS} worker Acts, ${COMMITS_PER_SEC} commits/s, ` +
      `${AGGREGATES} aggregates, ${CYCLE_MS}ms settle cadence, ${SECONDS}s\n`
  );
  const r = await run();
  const per_s = (x) => (x / SECONDS).toFixed(1);
  console.log(`  commits            ${r.commits} (${per_s(r.commits)}/s)`);
  console.log(`  reactions handled  ${r.reactions}`);
  console.log(`  reaction latency   p50 ${r.lat_p50} ms, p99 ${r.lat_p99} ms`);
  console.log("");
  console.log("  store calls over the window (the load a deployment creates):");
  for (const [k, v] of Object.entries(r.calls).sort((a, b) => b[1] - a[1]))
    console.log(`    ${k.padEnd(16)} ${String(v).padStart(8)}  ${per_s(v)}/s`);
  console.log("");
  console.log(`  pg tuples returned ${r.tup_returned} (${per_s(r.tup_returned)}/s)`);
  console.log(`  pg transactions    ${r.xacts} (${per_s(r.xacts)}/s)`);
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.end();
};

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => {});
  process.exit(1);
});
