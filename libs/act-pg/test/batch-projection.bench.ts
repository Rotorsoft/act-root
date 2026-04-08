/**
 * Benchmark: batched projection replay vs per-event projection handling (PostgreSQL).
 *
 * Bulk-seeds 100K events into PG, then measures drain-phase throughput.
 * Per-event handlers each perform a real PG upsert; the batch handler
 * wraps all upserts in a single PG transaction.
 *
 * Run: pnpm vitest bench libs/act-pg/test/batch-projection.bench.ts
 */
import { act, dispose, projection, state, store } from "@rotorsoft/act";
import pg from "pg";
import { afterAll, beforeAll, bench, describe } from "vitest";
import { z } from "zod";
import { PostgresStore } from "../src/PostgresStore.js";

const Incremented = z.object({ by: z.number() });

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented })
  .patch({
    Incremented: (event, s) => ({ count: s.count + event.data.by }),
  })
  .on({ increment: z.object({ by: z.number() }) })
  .emit((a) => ["Incremented", { by: a.by }])
  .build();

const actor = { id: "bench", name: "bench" };
const SCHEMA = "batch_bench";
const EVENTS = 10_000;

const pool = new pg.Pool({
  port: 5431,
  user: "postgres",
  password: "postgres",
  database: "postgres",
});

store(new PostgresStore({ port: 5431, schema: SCHEMA, table: "events" }));

/** Bulk-seed N events directly into the PG store */
async function seedEvents(stream: string, count: number) {
  const meta = { actor, correlation: "bench", causation: {} };
  const BATCH = 1000;
  for (let i = 0; i < count; i += BATCH) {
    const size = Math.min(BATCH, count - i);
    const msgs = Array.from({ length: size }, () => ({
      name: "Incremented" as const,
      data: { by: 1 },
    }));
    await store().commit(stream, msgs, meta);
  }
}

async function setupProjectionTable() {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "${SCHEMA}".counters (
      stream TEXT PRIMARY KEY,
      total INT NOT NULL DEFAULT 0
    )
  `);
}

beforeAll(async () => {
  await store().seed();
  await setupProjectionTable();
});

afterAll(async () => {
  await store().drop();
  await pool.end();
  await dispose()();
});

describe(`batch projection replay — ${EVENTS.toLocaleString()} events (PostgreSQL)`, () => {
  bench(
    "per-event (N PG writes)",
    async () => {
      await pool.query(`TRUNCATE "${SCHEMA}".counters`);
      await store().drop();
      await store().seed();
      await setupProjectionTable();

      const proj = projection("pe-target")
        .on({ Incremented })
        .do(async ({ stream, data }) => {
          await pool.query(
            `INSERT INTO "${SCHEMA}".counters (stream, total) VALUES ($1, $2)
             ON CONFLICT (stream) DO UPDATE SET total = counters.total + $2`,
            [stream, data.by]
          );
        })
        .build();

      const app_ = act().withState(Counter).withProjection(proj).build();
      await seedEvents("counter-pe", EVENTS);
      await app_.correlate();
      await app_.drain({ eventLimit: EVENTS });
    },
    { iterations: 1, warmupIterations: 0 }
  );

  bench(
    "batched (1 PG transaction)",
    async () => {
      await pool.query(`TRUNCATE "${SCHEMA}".counters`);
      await store().drop();
      await store().seed();
      await setupProjectionTable();

      const proj = projection("ba-target")
        .on({ Incremented })
        .do(async ({ stream, data }) => {
          await pool.query(
            `INSERT INTO "${SCHEMA}".counters (stream, total) VALUES ($1, $2)
             ON CONFLICT (stream) DO UPDATE SET total = counters.total + $2`,
            [stream, data.by]
          );
        })
        .batch(async (events) => {
          const client = await pool.connect();
          try {
            await client.query("BEGIN");
            for (const event of events) {
              await client.query(
                `INSERT INTO "${SCHEMA}".counters (stream, total) VALUES ($1, $2)
                 ON CONFLICT (stream) DO UPDATE SET total = counters.total + $2`,
                [event.stream, event.data.by]
              );
            }
            await client.query("COMMIT");
          } catch (e) {
            await client.query("ROLLBACK");
            throw e;
          } finally {
            client.release();
          }
        })
        .build();

      const app_ = act().withState(Counter).withProjection(proj).build();
      await seedEvents("counter-ba", EVENTS);
      await app_.correlate();
      await app_.drain({ eventLimit: EVENTS });
    },
    { iterations: 1, warmupIterations: 0 }
  );
});
