/**
 * Benchmark: batched projection replay vs per-event projection handling.
 *
 * Measures drain-phase-only throughput by pre-seeding events and timing
 * just the drain call. Handlers simulate realistic async DB writes (~1ms)
 * to surface the N-calls-vs-1-call difference.
 *
 * Uses InMemoryStore to isolate framework overhead.
 */
import { afterAll, describe, expect, it } from "vitest";
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

// Simulate a realistic async DB write (~1ms)
const simulateDBWrite = () => new Promise<void>((r) => setTimeout(r, 1));

afterAll(async () => {
  await dispose()();
});

describe("batch projection benchmark", () => {
  for (const EVENTS of [50, 200, 500]) {
    it(`${EVENTS} events — per-event vs batched drain`, async () => {
      // --- Per-event projection ---
      await store().drop();
      const perEventProj = projection("pe")
        .on({ Incremented })
        .do(async () => {
          await simulateDBWrite();
        })
        .build();
      const peApp = act()
        .withState(Counter)
        .withProjection(perEventProj)
        .build();

      for (let i = 0; i < EVENTS; i++) {
        await peApp.do("increment", { stream: "pe-stream", actor }, { by: 1 });
      }
      await peApp.correlate();

      const peStart = performance.now();
      await peApp.drain({ eventLimit: EVENTS });
      const peDrain = performance.now() - peStart;

      // --- Batched projection ---
      await store().drop();
      const batchedProj = projection("ba")
        .on({ Incremented })
        .do(async () => {
          await simulateDBWrite();
        })
        .batch(async () => {
          await simulateDBWrite();
        })
        .build();
      const baApp = act()
        .withState(Counter)
        .withProjection(batchedProj)
        .build();

      for (let i = 0; i < EVENTS; i++) {
        await baApp.do("increment", { stream: "ba-stream", actor }, { by: 1 });
      }
      await baApp.correlate();

      const baStart = performance.now();
      await baApp.drain({ eventLimit: EVENTS });
      const baDrain = performance.now() - baStart;

      const speedup = peDrain / baDrain;
      console.log(
        `  ${EVENTS} events | per-event: ${peDrain.toFixed(1)}ms | batched: ${baDrain.toFixed(1)}ms | speedup: ${speedup.toFixed(1)}x`
      );

      // Batched should always be faster
      expect(baDrain).toBeLessThan(peDrain);
    });
  }
});
