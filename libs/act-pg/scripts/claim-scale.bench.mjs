/**
 * Does `claim()`'s has-work probe scale with the number of SUBSCRIBED
 * streams, independent of how much work is actually pending?
 *
 * Two properties of the production SQL combine badly:
 *
 *  1. The `available` CTE has no LIMIT and is referenced three times (lag
 *     twice, lead once), so Postgres MATERIALIZES it — the `EXISTS` has-work
 *     probe is evaluated for EVERY eligible stream, not just the handful
 *     needed to fill the lease budget.
 *  2. The source predicate is a disjunction (`s.source IS NULL OR ... OR
 *     regex`), which is not sargable — so no `(stream, id)` index can serve
 *     it and each probe degenerates into a long scan of `events_pkey` from
 *     the stream's watermark forward.
 *
 * Together that is O(subscribed streams x events after watermark) per claim,
 * per worker, per cycle. This script measures it, and measures the two
 * candidate fixes in isolation.
 *
 * Run: node libs/act-pg/scripts/claim-scale.bench.mjs
 * Requires Postgres on :5431.
 */
import pg from "pg";

const SCHEMA = "claim_scale_bench";
const PENDING = 10; // streams that actually have unconsumed work
const pool = new pg.Pool({
  host: "localhost",
  port: 5431,
  user: "postgres",
  password: "postgres",
});
const q = (sql, args) => pool.query(sql, args);

async function seed(streams, extra_index) {
  await q(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await q(`CREATE SCHEMA ${SCHEMA}`);
  await q(`CREATE TABLE ${SCHEMA}.events (
    id bigserial PRIMARY KEY, name text NOT NULL, data jsonb, stream text NOT NULL,
    version int NOT NULL, created timestamptz NOT NULL DEFAULT now(), meta jsonb)`);
  await q(`CREATE UNIQUE INDEX ON ${SCHEMA}.events (stream, version)`);
  await q(`CREATE TABLE ${SCHEMA}.streams (
    stream text PRIMARY KEY, source text, at bigint NOT NULL DEFAULT -1,
    blocked boolean NOT NULL DEFAULT false, leased_by text,
    leased_until timestamptz, deferred_at timestamptz,
    priority int NOT NULL DEFAULT 0, lane text NOT NULL DEFAULT 'default')`);
  await q(`CREATE INDEX ON ${SCHEMA}.streams (blocked, priority DESC, at)`);
  if (extra_index) await q(`CREATE INDEX ON ${SCHEMA}.events (stream, id)`);

  // Shuffled ids so a stream's watermark lands at a random point in the
  // global sequence — the realistic shape once streams are active at
  // different times, and the reason `id > at` matches a long tail.
  await q(
    `INSERT INTO ${SCHEMA}.events (name, data, stream, version, meta)
     SELECT 'Opened', '{}'::jsonb, 's' || i, v, '{}'::jsonb
     FROM generate_series(0, $1::int - 1) i, generate_series(0, 2) v
     ORDER BY random()`,
    [streams]
  );
  await q(
    `INSERT INTO ${SCHEMA}.streams (stream, source, at)
     SELECT m.stream, m.stream,
            CASE WHEN m.rn <= $1 THEN m.prev ELSE m.top END
     FROM (SELECT stream, max(id) AS top,
                  (array_agg(id ORDER BY id DESC))[2] AS prev,
                  row_number() OVER (ORDER BY random()) AS rn
           FROM ${SCHEMA}.events GROUP BY stream) m`,
    [PENDING]
  );
  await q(`ANALYZE ${SCHEMA}.events`);
  await q(`ANALYZE ${SCHEMA}.streams`);
}

const SRC_OR = `(s.source IS NULL OR e.stream = s.source)`;
const SRC_EQ = `e.stream = s.source`;

/** Production shape: materialized CTE (referenced 3x) + OR source predicate. */
const materialized = (src) => `
  WITH available AS (
    SELECT stream, source, at, priority, lane FROM ${SCHEMA}.streams s
    WHERE blocked = false
      AND (leased_by IS NULL OR leased_until <= NOW())
      AND (deferred_at IS NULL OR deferred_at <= NOW())
      AND (s.at < 0 OR EXISTS (
        SELECT 1 FROM ${SCHEMA}.events e
        WHERE e.id > s.at AND e.name <> '__snapshot__' AND ${src} LIMIT 1))
  ),
  lag AS (SELECT stream FROM available ORDER BY priority DESC, at ASC LIMIT 8),
  lead AS (SELECT stream FROM available ORDER BY at DESC LIMIT 2)
  SELECT stream FROM lag UNION ALL SELECT stream FROM lead`;

/** Inlined shape: LIMIT pushed down so the probe stops at the budget. */
const inlined = (src) => `
  SELECT stream FROM ${SCHEMA}.streams s
  WHERE blocked = false
    AND (leased_by IS NULL OR leased_until <= NOW())
    AND (deferred_at IS NULL OR deferred_at <= NOW())
    AND (s.at < 0 OR EXISTS (
      SELECT 1 FROM ${SCHEMA}.events e
      WHERE e.id > s.at AND e.name <> '__snapshot__' AND ${src} LIMIT 1))
  ORDER BY priority DESC, at ASC LIMIT 10`;

const time = async (sql, iters) => {
  await q(sql);
  const t = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) await q(sql);
  return Number(process.hrtime.bigint() - t) / 1e6 / iters;
};

const main = async () => {
  console.log("Claim has-work probe, 10 streams pending in every row.");
  console.log("");
  console.log(
    "subscribed | production | +(stream,id) idx | +LIMIT pushdown | both"
  );
  console.log(
    "-----------|------------|------------------|-----------------|--------"
  );
  for (const streams of [100, 1000, 5000, 10000]) {
    const iters = streams >= 5000 ? 3 : 10;
    await seed(streams, false);
    const prod = await time(materialized(SRC_OR), iters);
    const push = await time(inlined(SRC_OR), iters);
    await seed(streams, true);
    const idx = await time(materialized(SRC_EQ), iters);
    const both = await time(inlined(SRC_EQ), iters);
    console.log(
      `${String(streams).padStart(10)} | ${prod.toFixed(1).padStart(7)} ms | ` +
        `${idx.toFixed(1).padStart(13)} ms | ${push.toFixed(1).padStart(12)} ms | ${both.toFixed(1).padStart(5)} ms`
    );
  }
  await q(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.end();
};

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
