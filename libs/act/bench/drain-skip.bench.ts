/**
 * Benchmark: drain skip optimization for non-reactive events.
 *
 * Measures the cost of drain() when committed events have no registered
 * reactions vs events that do. With the _needs_drain optimization,
 * non-reactive drains return immediately without touching the store.
 */
import { afterAll, beforeAll, bench, describe } from "vitest";
import { z } from "zod";
import { act, dispose, state, store, ZodEmpty } from "../src/index.js";

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({
    Incremented: ZodEmpty,
    NoReaction: ZodEmpty, // event with no reaction handler
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

beforeAll(async () => {
  await store().seed();
  await app.correlate();
});

afterAll(async () => {
  await dispose()();
});

describe("drain skip optimization", () => {
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
