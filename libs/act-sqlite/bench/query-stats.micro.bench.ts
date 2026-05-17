/**
 * Benchmark: SqliteStore.query_stats vs pre-ACT-639 per-stream
 * query() loop.
 *
 * SQLite is embedded — there's no network "round trip" to amortize —
 * but each `query()` call still prepares + executes a statement, so
 * the per-stream loop is N statement preparations vs one for
 * query_stats (with a `ROW_NUMBER() OVER (PARTITION BY stream)`
 * window over the existing `(stream, version)` unique index).
 *
 * Companion to:
 *   - `libs/act/bench/query-stats.micro.bench.ts` (InMemory baseline)
 *   - `libs/act-pg/bench/query-stats.micro.bench.ts` (PG indexed win)
 *
 * Run: pnpm bench:micro libs/act-sqlite/bench/query-stats.micro.bench.ts
 */
import type { Committed, Schemas } from "@rotorsoft/act";
import { afterAll, beforeAll, bench, describe } from "vitest";
import { SqliteStore } from "../src/sqlite-store.js";

const SWEEP_STREAMS = [10, 100, 1000] as const;
const EVENTS_PER_STREAM = 10;

const store = new SqliteStore({ url: "file::memory:?cache=shared" });
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
  describe(`SQLite query_stats N=${N} streams x ${EVENTS_PER_STREAM} events`, () => {
    bench("per-stream query() loop (pre-ACT-639)", async () => {
      // biome-ignore lint/style/noNonNullAssertion: seeded in beforeAll
      await perStreamHeads(seeded[N]!);
    });

    bench("query_stats — heads only (ROW_NUMBER window, indexed)", async () => {
      // biome-ignore lint/style/noNonNullAssertion: seeded in beforeAll
      await store.query_stats(seeded[N]!);
    });

    bench("query_stats — count + names (CTE + json_group_object)", async () => {
      // biome-ignore lint/style/noNonNullAssertion: seeded in beforeAll
      await store.query_stats(seeded[N]!, { count: true, names: true });
    });
  });
}
