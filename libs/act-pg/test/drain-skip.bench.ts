/**
 * Benchmark: drain skip optimization for non-reactive events (PostgreSQL).
 *
 * Measures the cost of drain() when committed events have no registered
 * reactions vs events that do. With the _needs_drain optimization,
 * non-reactive drains return immediately without touching the store.
 *
 * Run: pnpm vitest bench libs/act-pg/test/drain-skip.bench.ts --run
 */
import { act, dispose, state, store, ZodEmpty } from "@rotorsoft/act";
import { afterAll, beforeAll, bench, describe } from "vitest";
import { z } from "zod";
import { PostgresStore } from "../src/PostgresStore.js";

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({
    Incremented: ZodEmpty,
    NoReaction: ZodEmpty,
  })
  .patch({
    Incremented: (_, s) => ({ count: s.count + 1 }),
    NoReaction: () => ({}),
  })
  .on({ increment: ZodEmpty })
  .emit(() => ["Incremented", {}])
  .on({ noReaction: ZodEmpty })
  .emit(() => ["NoReaction", {}])
  .build();

// Only register a reaction for Incremented — NoReaction has none
const app = act()
  .withState(Counter)
  .on("Incremented")
  .do(async () => {})
  .build();

const actor = { id: "bench", name: "bench" };

store(
  new PostgresStore({
    port: 5431,
    schema: "drain_skip_bench",
    table: "events",
  })
);

beforeAll(async () => {
  await store().drop();
  await store().seed();
  await app.correlate();
});

afterAll(async () => {
  await store().drop();
  await dispose()();
});

describe("drain skip optimization (PostgreSQL)", () => {
  bench("drain after non-reactive event (should skip)", async () => {
    await app.do("noReaction", { stream: "bench-nr", actor }, {});
    await app.drain();
  });

  bench("drain after reactive event (should process)", async () => {
    await app.do("increment", { stream: "bench-r", actor }, {});
    await app.correlate();
    await app.drain();
  });
});
