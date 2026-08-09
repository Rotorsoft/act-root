/**
 * Benchmark for RFC 1448 — what a split Store port costs on the claim path.
 *
 * The question: today `claim()` answers "which subscribed streams have
 * unconsumed work?" with ONE query that joins `streams` to `events`. If the
 * subscription side and the event side live in different adapters, that join
 * is impossible — the drain must read candidates from the subscription store
 * and then probe the event store per candidate.
 *
 * Three arms, same data, same eligibility rules:
 *
 *   joined      the production SQL as-is (one round trip)
 *   split-n+1   candidates from `streams`, then ONE probe per candidate
 *               against `events` until the lease budget fills
 *   split-batch candidates from `streams`, then ONE batched probe for all
 *               candidates. The optimistic bound: only available when both
 *               halves speak the same query language and sit on the same
 *               host, which is precisely the case a split exists to avoid.
 *
 * The variable that matters is the HIT RATE — the fraction of subscribed
 * streams that actually have unconsumed work. A healthy steady state is
 * sparse: most streams are caught up, so the split has to walk a long way
 * down the candidate list to fill its budget.
 *
 * Run: node libs/act-pg/scripts/store-split-claim.bench.mjs
 * Requires Postgres on :5431 (docker container `act-pg`).
 */
import pg from "pg";

const SCHEMA = "split_bench";
const BUDGET = 10; // lagging+leading slots, the drain's per-cycle budget
const SNAP = "__snapshot__";

const pool = new pg.Pool({
  host: "localhost",
  port: 5431,
  user: "postgres",
  password: "postgres",
  max: 4,
});

const q = (sql, args) => pool.query(sql, args);

async function setup(streams, hit_rate) {
  await q(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await q(`CREATE SCHEMA ${SCHEMA}`);
  await q(`CREATE TABLE ${SCHEMA}.events (
    id bigserial PRIMARY KEY, name text NOT NULL, data jsonb,
    stream text NOT NULL, version int NOT NULL,
    created timestamptz NOT NULL DEFAULT now(), meta jsonb)`);
  await q(`CREATE UNIQUE INDEX ON ${SCHEMA}.events (stream, version)`);
  await q(`CREATE INDEX ON ${SCHEMA}.events (id)`);
  await q(`CREATE TABLE ${SCHEMA}.streams (
    stream text PRIMARY KEY, source text, at bigint NOT NULL DEFAULT -1,
    retry int NOT NULL DEFAULT -1, blocked boolean NOT NULL DEFAULT false,
    error text, leased_by text, leased_until timestamptz,
    deferred_at timestamptz, priority int NOT NULL DEFAULT 0,
    lane text NOT NULL DEFAULT 'default')`);
  await q(`CREATE INDEX ON ${SCHEMA}.streams (blocked, priority DESC, at)`);
  // The index the fixed join needs (see RFC 1448 / the claim-scale bench).
  await q(`CREATE INDEX ON ${SCHEMA}.events (stream, id)`);

  // THREE events per stream, so a "behind" stream has a real watermark
  // rather than the never-processed -1. Modelling has-work as at=-1 would
  // sort every behind stream to the front under `ORDER BY at ASC` and hand
  // the split its answer on the first probe — flattering, and wrong. Here a
  // caught-up stream sits at its own max id and a behind stream one event
  // back, so has-work is uncorrelated with claim's ordering, which is the
  // realistic shape: `at` tracks stream age, not pending work.
  // Ids are assigned in RANDOMIZED order so they interleave across streams
  // the way a real event store's do. This matters more than it looks:
  // inserting version-by-version groups ids by version, which makes every
  // behind stream sort first under `ORDER BY at ASC` and hands the split its
  // answer on the first probe. With shuffled ids a behind stream's watermark
  // is drawn from the same distribution as a caught-up one, so has-work is
  // uncorrelated with claim's ordering — the honest shape.
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
            CASE WHEN random() < $1 THEN m.prev ELSE m.top END
     FROM (SELECT stream, max(id) AS top,
                  (array_agg(id ORDER BY id DESC))[2] AS prev
           FROM ${SCHEMA}.events GROUP BY stream) m`,
    [hit_rate]
  );
  await q(`ANALYZE ${SCHEMA}.events`);
  await q(`ANALYZE ${SCHEMA}.streams`);
  const { rows } = await q(
    `SELECT count(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM ${SCHEMA}.events e
        WHERE e.id > s.at AND e.stream = s.source
     )) AS with_work, count(*) AS total FROM ${SCHEMA}.streams s`
  );
  return rows[0];
}

/** Arm 1 — production shape: one query, streams JOIN events. */
async function joined() {
  const { rows } = await q(
    `SELECT stream, source, at FROM ${SCHEMA}.streams s
     WHERE blocked = false
       AND (leased_by IS NULL OR leased_until <= NOW())
       AND (deferred_at IS NULL OR deferred_at <= NOW())
       AND (s.at < 0 OR EXISTS (
         SELECT 1 FROM ${SCHEMA}.events e
         WHERE e.id > s.at AND e.name <> '${SNAP}'
           AND (s.source IS NULL OR e.stream = s.source)
         LIMIT 1))
     ORDER BY priority DESC, at ASC
     LIMIT $1`,
    [BUDGET]
  );
  return rows.length;
}

/**
 * Arm 1b — the join AFTER the claim-path fix: sargable source predicate
 * (`e.stream = s.source`, no OR) so the `(stream, id)` index is usable, and
 * the LIMIT pushed down so the probe stops at the budget. This is the number
 * the split has to beat, not the unfixed one.
 */
async function joined_fixed() {
  const { rows } = await q(
    `SELECT stream, source, at FROM ${SCHEMA}.streams s
     WHERE blocked = false
       AND (leased_by IS NULL OR leased_until <= NOW())
       AND (deferred_at IS NULL OR deferred_at <= NOW())
       AND (s.at < 0 OR EXISTS (
         SELECT 1 FROM ${SCHEMA}.events e
         WHERE e.id > s.at AND e.name <> '${SNAP}' AND e.stream = s.source
         LIMIT 1))
     ORDER BY priority DESC, at ASC
     LIMIT $1`,
    [BUDGET]
  );
  return rows.length;
}

/** Candidate read — all a subscription-only store can answer by itself. */
async function candidates(limit) {
  const { rows } = await q(
    `SELECT stream, source, at FROM ${SCHEMA}.streams s
     WHERE blocked = false
       AND (leased_by IS NULL OR leased_until <= NOW())
       AND (deferred_at IS NULL OR deferred_at <= NOW())
     ORDER BY priority DESC, at ASC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

/** Arm 2 — one probe per candidate until the budget fills. */
async function split_n1(cap) {
  const cands = await candidates(cap);
  const found = [];
  let probes = 0;
  for (const c of cands) {
    if (found.length >= BUDGET) break;
    probes++;
    if (c.at < 0) {
      found.push(c);
      continue;
    }
    const { rows } = await q(
      `SELECT 1 FROM ${SCHEMA}.events e
       WHERE e.id > $1 AND e.name <> '${SNAP}' AND e.stream = $2 LIMIT 1`,
      [c.at, c.source]
    );
    if (rows.length) found.push(c);
  }
  return { found: found.length, probes };
}

/** Arm 3 — optimistic bound: one batched probe for every candidate. */
async function split_batch(cap) {
  const cands = await candidates(cap);
  const need = cands.filter((c) => c.at >= 0);
  let alive = new Set(cands.filter((c) => c.at < 0).map((c) => c.stream));
  if (need.length) {
    const { rows } = await q(
      `SELECT DISTINCT e.stream FROM ${SCHEMA}.events e
       JOIN unnest($1::text[], $2::bigint[]) AS c(stream, at)
         ON e.stream = c.stream AND e.id > c.at
       WHERE e.name <> '${SNAP}'`,
      [need.map((c) => c.source), need.map((c) => String(c.at))]
    );
    for (const r of rows) alive.add(r.stream);
  }
  return { found: Math.min(alive.size, BUDGET), probes: 1 };
}

const time = async (fn, iters) => {
  for (let i = 0; i < 3; i++) await fn(); // warm
  const t = process.hrtime.bigint();
  let last;
  for (let i = 0; i < iters; i++) last = await fn();
  const ms = Number(process.hrtime.bigint() - t) / 1e6 / iters;
  return { ms, last };
};

const main = async () => {
  console.log(
    "streams | hit% | joined(today) | joined(fixed) | split n+1              | split batched"
  );
  console.log(
    "--------|------|---------------|---------------|------------------------|--------------"
  );
  for (const streams of [1000, 10000]) {
    for (const hit of [1.0, 0.1, 0.01]) {
      const stats = await setup(streams, hit);
      const iters = streams > 5000 ? 15 : 30;
      // The split must be allowed to walk far enough to fill its budget.
      const cap = Math.min(streams, Math.ceil(BUDGET / Math.max(hit, 0.001)) * 2);
      const j = await time(joined, iters);
      const jf = await time(joined_fixed, iters);
      const n = await time(() => split_n1(cap), iters);
      const b = await time(() => split_batch(cap), iters);
      console.log(
        `${String(streams).padStart(7)} | ${String(Math.round(hit * 100)).padStart(4)} | ` +
          `${j.ms.toFixed(2).padStart(10)} ms | ${jf.ms.toFixed(2).padStart(10)} ms | ` +
          `${n.ms.toFixed(2).padStart(7)} ms (${String(n.last.probes).padStart(4)} probes) | ` +
          `${b.ms.toFixed(2).padStart(7)} ms`
      );
      if (j.last !== n.last.found || j.last !== b.last.found) {
        console.log(
          `        ^ found mismatch: joined=${j.last} n+1=${n.last.found} batch=${b.last.found} (with_work=${stats.with_work})`
        );
      }
    }
  }
  await q(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.end();
};

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
