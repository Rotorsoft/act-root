/**
 * #1448 / #1488 — does `claim()` scale with the number of SUBSCRIBED
 * streams, independent of how much work is pending?
 *
 * Measures the REAL `PostgresStore.claim()`, so it reflects whatever the
 * adapter currently does. Two eras are visible in the history here: the
 * has-work probe against the event log (one EXISTS per eligible row, cost
 * linear in subscribed streams — #1448 made each probe sargable but could
 * not change that axis), and the work mark (#1488), where eligibility is
 * `at < correlated_at` on the subscription row alone and the partial index
 * holds only streams with work.
 *
 * The data model matters twice over.
 *
 * Ids are assigned in randomized order so a stream's watermark lands at a
 * random point in the global sequence — the realistic shape once streams
 * are active at different times, and the reason a dormant aggregate's
 * `id > at` tail is long. Seeding events version-by-version, or modelling
 * has-work as `at = -1`, both sort every pending stream to the front and
 * flatter the result.
 *
 * And marks are seeded HONESTLY, the way correlate would leave them: a
 * pending stream's mark sits above its watermark, a caught-up stream's mark
 * equals it. Marking everything would make every subscription eligible and
 * measure a different system.
 *
 * Run: node libs/act-pg/scripts/claim-scale.bench.mjs
 * Requires Postgres on :5431. SIZES / RATES override the grid.
 */
import pg from "pg";
import { PostgresStore } from "../dist/index.js";

const SCHEMA = "claim_scale_bench";
const pool = new pg.Pool({
  host: "localhost",
  port: 5431,
  user: "postgres",
  password: "postgres",
});

/** Events + subscriptions for `streams` streams, no marks yet. */
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
  // Watermark at the stream's second-newest event for everyone: whether a
  // stream counts as pending is decided by its MARK below, not by its
  // watermark, so every row keeps the same shape and only eligibility moves.
  await pool.query(
    `INSERT INTO ${SCHEMA}.events_streams
       (stream, source, at, retry, blocked, priority, lane, correlated_at)
     SELECT m.stream, m.stream, m.prev, -1, false, 0, 'default', m.prev
     FROM (SELECT stream,
                  (array_agg(id ORDER BY id DESC))[2] AS prev
           FROM ${SCHEMA}.events GROUP BY stream) m`
  );
  return store;
}

/**
 * Set the mark on a random `rate` fraction of subscriptions to the stream's
 * newest event — correlate having resolved one event to each of them — and
 * leave the rest caught up.
 */
async function set_hit_rate(streams, rate) {
  const pending = Math.max(1, Math.round(streams * rate));
  await pool.query(
    `UPDATE ${SCHEMA}.events_streams s
     SET correlated_at = s.at
     WHERE s.correlated_at <> s.at`
  );
  await pool.query(
    `UPDATE ${SCHEMA}.events_streams s
     SET correlated_at = m.top
     FROM (SELECT stream, max(id) AS top,
                  row_number() OVER (ORDER BY random()) AS rn
           FROM ${SCHEMA}.events GROUP BY stream) m
     WHERE m.stream = s.stream AND m.rn <= $1`,
    [pending]
  );
  await pool.query(`ANALYZE ${SCHEMA}.events`);
  await pool.query(`ANALYZE ${SCHEMA}.events_streams`);
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM ${SCHEMA}.events_streams
     WHERE at < correlated_at`
  );
  return rows[0].n;
}

const main = async () => {
  const sizes = process.env.SIZES
    ? process.env.SIZES.split(",").map(Number)
    : [1000, 10000, 100000];
  const rates = process.env.RATES
    ? process.env.RATES.split(",").map(Number)
    : [0.01, 0.1, 1];

  console.log("Real PostgresStore.claim(), marks seeded as correlate leaves them:");
  console.log("");
  console.log("subscribed | hit rate | claim latency | leased | eligible");
  console.log("-----------|----------|---------------|--------|---------");
  for (const streams of sizes) {
    const store = await seed(streams);
    for (const rate of rates) {
      const eligible = await set_hit_rate(streams, rate);
      const iters = streams >= 10000 ? 5 : 15;
      // Lease for 0ms so every iteration sees the FULL eligible set. At 1ms
      // the previous iteration's leases are still live whenever a claim is
      // fast, so the probe walks a smaller candidate set and the measurement
      // flatters itself (#1482).
      for (let i = 0; i < 3; i++) await store.claim(8, 2, `warm-${i}`, 0);
      const t = process.hrtime.bigint();
      let leased = 0;
      for (let i = 0; i < iters; i++) {
        leased = (await store.claim(8, 2, `w-${i}-${Math.random()}`, 0)).length;
      }
      const ms = Number(process.hrtime.bigint() - t) / 1e6 / iters;
      console.log(
        `${String(streams).padStart(10)} | ${String(`${rate * 100}%`).padStart(8)} | ${ms.toFixed(2).padStart(10)} ms | ${String(leased).padStart(6)} | ${String(eligible).padStart(8)}`
      );
    }
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
