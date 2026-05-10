/**
 * Benchmark: batched projection replay vs per-event projection handling.
 *
 * Measures drain-phase-only throughput by bulk-seeding events directly
 * into the store and timing just the drain call. Handlers simulate
 * realistic async DB writes (~1ms) to surface the N-calls-vs-1-call
 * difference.
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

/** Bulk-seed N events directly into the store (bypasses action/cache overhead) */
async function seedEvents(stream: string, count: number) {
  const meta = {
    actor,
    correlation: "bench",
    causation: {},
  };
  // Commit in batches of 1000 to avoid overwhelming the store
  const BATCH = 1000;
  for (let i = 0; i < count; i += BATCH) {
    const size = Math.min(BATCH, count - i);
    const msgs = Array.from({ length: size }, () => ({
      name: "Incremented" as const,
      data: { by: 1 },
    }));
    await store().commit(stream, msgs, meta, i > 0 ? i - 1 : undefined);
  }
}

afterAll(async () => {
  await dispose()();
});

describe("batch projection benchmark", () => {
  for (const EVENTS of [1_000, 10_000, 100_000]) {
    it(
      `${EVENTS.toLocaleString()} events — per-event vs batched drain`,
      async () => {
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

        await seedEvents("pe-stream", EVENTS);
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

        await seedEvents("ba-stream", EVENTS);
        await baApp.correlate();

        const baStart = performance.now();
        await baApp.drain({ eventLimit: EVENTS });
        const baDrain = performance.now() - baStart;

        const speedup = peDrain / baDrain;
        console.log(
          `  ${EVENTS.toLocaleString().padStart(7)} events | per-event: ${peDrain.toFixed(1).padStart(9)}ms | batched: ${baDrain.toFixed(1).padStart(7)}ms | speedup: ${speedup.toFixed(0)}x`
        );

        expect(baDrain).toBeLessThan(peDrain);
      },
      // 100K events with 1ms handlers = ~100s for per-event
      EVENTS * 2 + 10_000
    );
  }
});
