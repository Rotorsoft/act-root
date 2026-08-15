/**
 * Does `claim()` scale with the number of SUBSCRIBED streams, independent of
 * how much work is pending? The SQLite counterpart of
 * `libs/act-pg/scripts/claim-scale.bench.mjs` (#1482, RFC 1449 step 0).
 *
 * This adapter is expected to be the plan's headline number. Its `claim`
 * selects every eligible stream with no limit, then runs one
 * `SELECT 1 FROM events … LIMIT 1` **per candidate in a JavaScript loop**,
 * with no early exit once `lagging + leading` candidates are found — and the
 * whole loop runs inside `transaction("write")`, so it serializes against
 * every concurrent commit. #1448's fix (a sargable source predicate plus a
 * partial index) cannot port here: the probe is in JS, not SQL, so there is
 * no planner to make sargable.
 *
 * Measures the REAL `SqliteStore.claim()`, so it reflects whatever the
 * adapter currently does.
 *
 * The data model matters. Ids are assigned in randomized order so a stream's
 * watermark lands at a random point in the global sequence — the realistic
 * shape once streams are active at different times. Seeding events
 * version-by-version, or modelling has-work as `at = -1`, both sort every
 * pending stream to the front of `ORDER BY at ASC` and flatter the result by
 * orders of magnitude.
 *
 * Run: node libs/act-sqlite/scripts/claim-scale.bench.mjs
 *      SIZES=100,1000 node libs/act-sqlite/scripts/claim-scale.bench.mjs
 *
 * File-backed on purpose: an in-memory database is a different storage
 * engine profile, and `:memory:` is process-global shared cache here (#1443).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../dist/index.js";

const PENDING = 10; // streams that actually have unconsumed work
const dir = mkdtempSync(join(tmpdir(), "act-claim-scale-"));

/**
 * Seed `streams` subscriptions over 3 events each, with randomized ids, and
 * park all but `PENDING` of them at their stream head (nothing to do).
 */
async function seed(streams) {
  const url = `file:${join(dir, `bench-${streams}.db`)}`;
  const store = new SqliteStore({ url });
  await store.drop();
  await store.seed();
  const client = store.client;

  // Randomized insert order: `ORDER BY random()` over the cross product, so
  // AUTOINCREMENT ids land in shuffled stream order.
  await client.execute(`
    INSERT INTO events (name, data, stream, version, meta, created)
    SELECT 'Opened', '{}', 's' || i.value, v.value, '{}', '2020-01-01'
    FROM (WITH RECURSIVE c(value) AS (
            SELECT 0 UNION ALL SELECT value + 1 FROM c WHERE value < ${streams - 1}
          ) SELECT value FROM c) i,
         (WITH RECURSIVE d(value) AS (
            SELECT 0 UNION ALL SELECT value + 1 FROM d WHERE value < 2
          ) SELECT value FROM d) v
    ORDER BY random()
  `);

  // Every subscription sits at its stream's head except a random `PENDING`
  // few, which sit one event behind.
  await client.execute(`
    INSERT INTO streams (stream, source, at, retry, blocked, priority, lane)
    SELECT m.stream, m.stream,
           CASE WHEN m.rn <= ${PENDING} THEN m.prev ELSE m.top END,
           -1, 0, 0, 'default'
    FROM (SELECT stream,
                 MAX(id) AS top,
                 MAX(id) - 1 AS prev,
                 ROW_NUMBER() OVER (ORDER BY random()) AS rn
          FROM events GROUP BY stream) m
  `);
  await client.execute("ANALYZE");
  const { rows } = await client.execute(
    "SELECT COUNT(*) AS n FROM streams s WHERE EXISTS (SELECT 1 FROM events e WHERE e.stream = s.source AND e.id > s.at)"
  );
  return { store, pending: Number(rows[0].n) };
}

const main = async () => {
  console.log("Real SqliteStore.claim(), 10 of N streams pending:");
  console.log("");
  console.log("subscribed | claim latency | leased");
  console.log("-----------|---------------|-------");
  const sizes = process.env.SIZES
    ? process.env.SIZES.split(",").map(Number)
    : [100, 1000, 5000, 10000, 20000];
  for (const streams of sizes) {
    const { store, pending } = await seed(streams);
    const iters = streams >= 10000 ? 5 : 15;
    // Lease for 0ms so every iteration sees the FULL eligible set. With a
    // 1ms lease the previous iteration's leases are still live whenever a
    // claim is fast, so the probe walks a smaller candidate set and the
    // measurement flatters itself — visible as `leased 0` at small sizes
    // and `leased 10` only once each claim takes longer than the lease.
    for (let i = 0; i < 3; i++) await store.claim(8, 2, `warm-${i}`, 0);
    const t = process.hrtime.bigint();
    let leased = 0;
    for (let i = 0; i < iters; i++) {
      leased = (await store.claim(8, 2, `w-${i}-${Math.random()}`, 0)).length;
    }
    const ms = Number(process.hrtime.bigint() - t) / 1e6 / iters;
    console.log(
      `${String(streams).padStart(10)} | ${ms.toFixed(2).padStart(10)} ms | ${String(leased).padStart(6)} (pending ${pending})`
    );
    await store.dispose();
  }
  rmSync(dir, { recursive: true, force: true });
};

main().catch((e) => {
  console.error(e);
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
});
