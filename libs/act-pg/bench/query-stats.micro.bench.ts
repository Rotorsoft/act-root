/**
 * Benchmark: PostgresStore.query_stats vs pre-ACT-639 per-stream
 * query() loop.
 *
 * This is where the architectural win shows: on a real DB the
 * per-stream loop pays N **round trips** and N transactions, while
 * query_stats issues exactly one indexed `DISTINCT ON` query. The
 * InMemory microbench (`libs/act/bench/query-stats.micro.bench.ts`)
 * already documents the linear-vs-quadratic part; this one captures
 * the round-trip-per-stream cost that durable adapters actually pay.
 *
 * Run: pnpm bench:micro libs/act-pg/bench/query-stats.micro.bench.ts
 */
import type { Committed, Schemas } from "@rotorsoft/act";
import { afterAll, beforeAll, bench, describe } from "vitest";
import { PostgresStore } from "../src/postgres-store.js";

const PORT = 5431;
const SCHEMA = "query_stats_bench";
const TABLE = "events";

const SWEEP_STREAMS = [10, 100, 1000] as const;
const EVENTS_PER_STREAM = 10;

const store = new PostgresStore({ port: PORT, schema: SCHEMA, table: TABLE });
const seeded: { [N in (typeof SWEEP_STREAMS)[number]]?: string[] } = {};

beforeAll(async () => {
  await store.drop();
  await store.seed();
  for (const N of SWEEP_STREAMS) {
    const names: string[] = [];
    for (let i = 0; i < N; i++) {
      const stream = `bench-${N}-${i}`;
      names.push(stream);
      const msgs = Array.from({ length: EVENTS_PER_STREAM }, (_, k) => ({
        name: "Incremented",
        data: { by: k + 1 },
      }));
      await store.commit(stream, msgs, {
        correlation: "bench",
        causation: {},
      });
    }
    seeded[N] = names;
  }
}, 120_000);

afterAll(async () => {
  await store.dispose();
});

async function perStreamHeads(streams: string[]) {
  const out = new Map<string, Committed<Schemas, keyof Schemas>>();
  await Promise.all(
    streams.map(async (s) => {
      let head: Committed<Schemas, keyof Schemas> | undefined;
      await store.query<Schemas>(
        (e) => {
          if (!head) head = e;
        },
        { stream: s, stream_exact: true, backward: true, limit: 1 }
      );
      if (head) out.set(s, head);
    })
  );
  return out;
}

for (const N of SWEEP_STREAMS) {
  describe(`PG query_stats N=${N} streams x ${EVENTS_PER_STREAM} events`, () => {
    bench("per-stream query() loop (pre-ACT-639)", async () => {
      // seeded in beforeAll
      await perStreamHeads(seeded[N]!);
    });

    bench("query_stats — heads only (DISTINCT ON, indexed)", async () => {
      // seeded in beforeAll
      await store.query_stats(seeded[N]!);
    });

    bench("query_stats — count + names (CTE + jsonb_object_agg)", async () => {
      // seeded in beforeAll
      await store.query_stats(seeded[N]!, { count: true, names: true });
    });
  });
}
