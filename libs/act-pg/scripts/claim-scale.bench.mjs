/**
 * #1448 — does `claim()` scale with the number of SUBSCRIBED streams,
 * independent of how much work is pending?
 *
 * Measures the REAL `PostgresStore.claim()`, so it reflects whatever the
 * adapter currently does (source-class split + partial `(stream, id)` index
 * after #1448; the OR-chain and pk scan before it).
 *
 * The data model matters. Ids are assigned in randomized order so a stream's
 * watermark lands at a random point in the global sequence — the realistic
 * shape once streams are active at different times, and the reason a dormant
 * aggregate's `id > at` tail is long. Seeding events version-by-version, or
 * modelling has-work as `at = -1`, both sort every pending stream to the
 * front and flatter the result.
 *
 * Run: node libs/act-pg/scripts/claim-scale.bench.mjs
 * Requires Postgres on :5431.
 */
import pg from "pg";
import { PostgresStore } from "../dist/index.js";

const SCHEMA = "claim_scale_bench";
const PENDING = 10; // streams that actually have unconsumed work
const pool = new pg.Pool({
  host: "localhost",
  port: 5431,
  user: "postgres",
  password: "postgres",
});

async function seed(streams) {
  const store = new PostgresStore({
    port: 5431,
    schema: SCHEMA,
    table: "events",
  });
  await store.drop();
  await store.seed();
  await pool.query(
    `INSERT INTO ${SCHEMA}.events (name, data, stream, version, meta)
     SELECT 'Opened', '{}'::jsonb, 's' || i, v, '{}'::jsonb
     FROM generate_series(0, $1::int - 1) i, generate_series(0, 2) v
     ORDER BY random()`,
    [streams]
  );
  await pool.query(
    `INSERT INTO ${SCHEMA}.events_streams (stream, source, at, retry, blocked, priority, lane)
     SELECT m.stream, m.stream,
            CASE WHEN m.rn <= $1 THEN m.prev ELSE m.top END,
            -1, false, 0, 'default'
     FROM (SELECT stream, max(id) AS top,
                  (array_agg(id ORDER BY id DESC))[2] AS prev,
                  row_number() OVER (ORDER BY random()) AS rn
           FROM ${SCHEMA}.events GROUP BY stream) m`,
    [PENDING]
  );
  await pool.query(`ANALYZE ${SCHEMA}.events`);
  await pool.query(`ANALYZE ${SCHEMA}.events_streams`);
  return store;
}

const main = async () => {
  console.log("Real PostgresStore.claim(), 10 of N streams pending:");
  console.log("");
  console.log("subscribed | claim latency | leased");
  console.log("-----------|---------------|-------");
  const sizes = process.env.SIZES
    ? process.env.SIZES.split(',').map(Number)
    : [100, 1000, 5000, 10000, 20000];
  for (const streams of sizes) {
    const store = await seed(streams);
    const iters = streams >= 10000 ? 5 : 15;
    for (let i = 0; i < 3; i++) await store.claim(8, 2, `warm-${i}`, 1);
    const t = process.hrtime.bigint();
    let leased = 0;
    for (let i = 0; i < iters; i++) {
      leased = (await store.claim(8, 2, `w-${i}-${Math.random()}`, 1)).length;
    }
    const ms = Number(process.hrtime.bigint() - t) / 1e6 / iters;
    console.log(
      `${String(streams).padStart(10)} | ${ms.toFixed(2).padStart(10)} ms | ${String(leased).padStart(6)}`
    );
    await store.dispose();
  }
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.end();
};

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
