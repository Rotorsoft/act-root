/**
 * Bulk-seed an act-pg event store for the envelope measurements.
 *
 *   npx tsx evidence/seed.ts --events 1000000 --hot 100000
 *
 * Seeding through `app.do` would measure the framework, not build the
 * fixture — at framework speed a 10M-event store takes hours. This
 * generates the exact rows `commit()` would produce (name/data/stream/
 * version/meta) server-side with generate_series, at Postgres speed.
 *
 * Layout: one hot aggregate (`hot-1`, --hot events, versions 0..n) and
 * the remainder spread across 5k-event tenant streams — the shape of a
 * many-tenant system with one giant.
 */
import { PostgresStore } from "@rotorsoft/act-pg";
import pg from "pg";
import { config, elapsed, human } from "./shared.js";

const STREAM_SIZE = 5_000;

async function main() {
  const { table, events: total, hot, pg: pgconf } = config();

  const store = new PostgresStore({ ...pgconf, table });
  await store.seed(); // act's schema story: additive DDL, advisory-locked
  await store.drop();
  await store.seed();
  await store.dispose();

  const pool = new pg.Pool(pgconf);
  const t0 = process.hrtime.bigint();
  const meta = `'{"correlation":"seed","causation":{}}'::jsonb`;

  await pool.query(`
    INSERT INTO ${table}(name, data, stream, version, meta)
    SELECT 'Ticked', jsonb_build_object('n', v), 'hot-1', v, ${meta}
    FROM generate_series(0, ${hot - 1}) AS v`);
  console.log(`  hot-1: ${human(hot)} events (${elapsed(t0)})`);

  const tenant_events = total - hot;
  if (tenant_events > 0)
    await pool.query(`
      INSERT INTO ${table}(name, data, stream, version, meta)
      SELECT 'Ticked', jsonb_build_object('n', i % ${STREAM_SIZE}),
             'tenant-' || (i / ${STREAM_SIZE} + 1), i % ${STREAM_SIZE}, ${meta}
      FROM generate_series(0, ${tenant_events - 1}) AS i`);

  await pool.query(`ANALYZE ${table}`);
  await pool.end();

  const tenants = Math.ceil(tenant_events / STREAM_SIZE);
  console.log(
    `seeded ${human(total)} events (hot-1: ${human(hot)}, tenants: ${tenants}) in ${elapsed(t0)} → table ${table}`
  );
}

void main();
