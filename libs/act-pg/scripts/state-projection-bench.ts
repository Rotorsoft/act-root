/**
 * Rebuild cost of the three projection shapes over the same store:
 *
 *   per-event .do()  — one upsert per event
 *   .batch()         — one multi-row statement per fetched batch
 *   .of().flush()    — fold in memory, one row per stream per round
 *
 *   npx tsx libs/act-pg/scripts/state-projection-bench.ts
 *
 * Seeds STREAMS x EVENTS_PER_STREAM Incremented events directly (SQL,
 * not the framework), then rebuilds each projection to a real Postgres
 * read table and reports wall-clock + row-writes. Needs the docker PG
 * on :5431.
 */
import {
  act,
  type CacheEntry,
  dispose,
  projection,
  state,
  store,
} from "@rotorsoft/act";
import pg from "pg";
import { z } from "zod";
import { PostgresStore } from "../src/index.js";

const STREAMS = Number(process.env.STREAMS ?? 5_000);
const EVENTS_PER_STREAM = Number(process.env.EVENTS_PER_STREAM ?? 20);
const TOTAL = STREAMS * EVENTS_PER_STREAM;

const conf = {
  host: "localhost",
  port: 5431,
  user: "postgres",
  password: "postgres",
  database: "postgres",
};

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ by: z.number() }) })
  .patch({
    Incremented: (event, s) => ({ count: s.count + event.data.by }),
  })
  .on({ increment: z.object({ by: z.number() }) })
  .emit((a) => ["Incremented", a])
  .build();

const pool = new pg.Pool(conf);
let writes = 0;

async function upsert_rows(
  input: Array<{ stream: string; count: number; version: number; id: number }>
) {
  writes += input.length;
  // A single INSERT cannot touch the same conflict key twice — keep the
  // last write per stream within the statement.
  const last = new Map<string, (typeof input)[number]>();
  for (const r of input) last.set(r.stream, r);
  const rows = [...last.values()];
  const values: unknown[] = [];
  const tuples = rows.map((r, i) => {
    values.push(r.stream, r.count, r.version, r.id);
    const b = i * 4;
    return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4})`;
  });
  await pool.query(
    `INSERT INTO bench_rows(stream, count, version, event_id)
     VALUES ${tuples.join(",")}
     ON CONFLICT (stream) DO UPDATE
       SET count = excluded.count, version = excluded.version,
           event_id = excluded.event_id
     WHERE bench_rows.event_id <= excluded.event_id`,
    values
  );
}

const shapes = {
  "per-event .do()": () =>
    projection("rows")
      .on({ Incremented: z.object({ by: z.number() }) })
      .do(async function upsertOne(event) {
        // The classic shape: re-derive and write per event.
        await upsert_rows([
          {
            stream: event.stream,
            count: 0, // real apps re-read or re-derive here; cost is the write
            version: event.version,
            id: event.id,
          },
        ]);
      })
      .build(),
  ".batch()": () =>
    projection("rows")
      .on({ Incremented: z.object({ by: z.number() }) })
      .do(async function unusedFallback() {})
      .batch(async (events) => {
        await upsert_rows(
          events.map((e) => ({
            stream: e.stream,
            count: 0,
            version: e.version,
            id: e.id,
          }))
        );
      })
      .build(),
  ".of().flush()": () =>
    projection("rows")
      .of(Counter)
      .flush(async (rows: ReadonlyArray<CacheEntry<{ count: number }>>) => {
        await upsert_rows(
          rows.map((r) => ({
            stream: r.stream,
            count: r.state.count,
            version: r.version,
            id: r.event_id,
          }))
        );
      })
      .build(),
};

async function main() {
  const table = "bench_sp";
  const pgstore = new PostgresStore({ ...conf, table });
  await pgstore.seed();
  await pgstore.drop();
  await pgstore.seed();
  store(pgstore);

  console.log(
    `seeding ${TOTAL.toLocaleString()} events (${STREAMS} streams x ${EVENTS_PER_STREAM})...`
  );
  await pool.query(`
    INSERT INTO ${table}(name, data, stream, version, meta)
    SELECT 'Incremented', '{"by":1}'::jsonb,
           'c-' || (i / ${EVENTS_PER_STREAM}), i % ${EVENTS_PER_STREAM},
           '{"correlation":"bench","causation":{}}'::jsonb
    FROM generate_series(0, ${TOTAL - 1}) AS i`);
  await pool.query(`ANALYZE ${table}`);
  await pool.query(`DROP TABLE IF EXISTS bench_rows`);
  await pool.query(
    `CREATE TABLE bench_rows(stream text PRIMARY KEY, count int, version int, event_id bigint)`
  );

  for (const [label, make] of Object.entries(shapes)) {
    await pool.query(`TRUNCATE bench_rows`);
    await pool.query(`DELETE FROM ${table}_streams WHERE stream = 'rows'`);
    writes = 0;
    const app = act().withState(Counter).withProjection(make()).build();
    await app.correlate();
    const t0 = process.hrtime.bigint();
    for (;;) {
      const d = await app.drain({ eventLimit: 10_000, leaseMillis: 60_000 });
      if (d.acked.length === 0) break;
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const { rows } = await pool.query(`SELECT count(*) AS n FROM bench_rows`);
    console.log(
      `${label.padEnd(18)} ${(ms / 1000).toFixed(1).padStart(6)}s   ${writes
        .toLocaleString()
        .padStart(9)} row-writes   ${Number(rows[0].n).toLocaleString()} rows`
    );
  }

  await pool.end();
  await dispose()();
}

void main();
