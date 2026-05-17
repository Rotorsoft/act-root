/**
 * Benchmark: Store.query_stats vs per-stream query() loop.
 *
 * Compares the three call shapes operators have available for fetching
 * per-stream stats:
 *
 *   - **per-stream loop** — the pre-ACT-639 close-cycle pattern;
 *     `Promise.all(streams.map(s => store.query(..., {stream: s})))`.
 *     N round trips through the store interface.
 *   - **query_stats (heads-only)** — one call, indexed cheap path on
 *     durable stores; for InMemory this is a single forward scan.
 *   - **query_stats (count+names)** — one call, full-scan path with
 *     per-name aggregation.
 *
 * The InMemory adapter has no indexes, so the cost story here is
 * "single pass vs N passes" (the per-stream loop scans the full event
 * list N times). PG and SQLite get the additional index-only win which
 * this microbench does not capture — for that, run the scenario bench
 * `close-bulk.scenario.bench.ts` and the per-adapter benches when they
 * land.
 */
import { afterAll, beforeAll, bench, describe } from "vitest";
import { InMemoryStore } from "../src/adapters/in-memory-store.js";
import type { Committed, Schemas } from "../src/types/index.js";

const SWEEP_STREAMS = [10, 100, 1000] as const;
const EVENTS_PER_STREAM = 10;

const store = new InMemoryStore();

const seeded: { [N in (typeof SWEEP_STREAMS)[number]]?: string[] } = {};

beforeAll(async () => {
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
});

afterAll(async () => {
  await store.dispose();
});

/** Simulates the pre-ACT-639 close-cycle scanStreamHeads pattern. */
async function perStreamHeads(
  streams: string[]
): Promise<Map<string, Committed<Schemas, keyof Schemas>>> {
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
  describe(`query_stats N=${N} streams × ${EVENTS_PER_STREAM} events`, () => {
    bench("per-stream query() loop (pre-ACT-639)", async () => {
      // biome-ignore lint/style/noNonNullAssertion: seeded in beforeAll
      await perStreamHeads(seeded[N]!);
    });

    bench("query_stats — heads only", async () => {
      // biome-ignore lint/style/noNonNullAssertion: seeded in beforeAll
      await store.query_stats(seeded[N]!);
    });

    bench("query_stats — count + names (full scan)", async () => {
      // biome-ignore lint/style/noNonNullAssertion: seeded in beforeAll
      await store.query_stats(seeded[N]!, { count: true, names: true });
    });
  });
}
