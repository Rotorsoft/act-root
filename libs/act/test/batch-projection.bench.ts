/**
 * Benchmark: batched projection replay vs per-event projection handling.
 *
 * Measures drain-phase throughput when replaying events through a projection.
 * The per-event handler simulates N async I/O writes; the batch handler
 * simulates 1 async I/O write for the entire batch — reflecting the real-world
 * pattern of wrapping a batch in a single DB transaction.
 *
 * Uses InMemoryStore to isolate framework overhead.
 */
import { afterAll, bench, describe } from "vitest";
import { z } from "zod";
import { act, dispose, projection, state, store } from "../src/index.js";

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

// Simulate an async DB write (~1ms via setTimeout(0))
const simulateDBWrite = () => new Promise<void>((r) => setTimeout(r, 0));

const EVENTS = 50;
let streamCounter = 0;

afterAll(async () => {
  await dispose()();
});

describe(`projection replay (${EVENTS} events)`, () => {
  bench("per-event (N handler calls)", async () => {
    await store().drop();
    const proj = projection("per-event")
      .on({ Incremented })
      .do(async () => {
        await simulateDBWrite();
      })
      .build();
    const app_ = act().withState(Counter).withProjection(proj).build();
    const stream = `pe-${++streamCounter}`;
    for (let i = 0; i < EVENTS; i++) {
      await app_.do("increment", { stream, actor }, { by: 1 });
    }
    await app_.correlate();
    await app_.drain({ eventLimit: EVENTS });
  });

  bench("batched (1 handler call)", async () => {
    await store().drop();
    const proj = projection("batched")
      .on({ Incremented })
      .do(async () => {
        await simulateDBWrite();
      })
      .batch(async () => {
        await simulateDBWrite();
      })
      .build();
    const app_ = act().withState(Counter).withProjection(proj).build();
    const stream = `ba-${++streamCounter}`;
    for (let i = 0; i < EVENTS; i++) {
      await app_.do("increment", { stream, actor }, { by: 1 });
    }
    await app_.correlate();
    await app_.drain({ eventLimit: EVENTS });
  });
});
