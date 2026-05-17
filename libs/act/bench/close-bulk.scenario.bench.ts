/**
 * Scenario benchmark: bulk close-cycle scan via query_stats vs the
 * pre-ACT-639 per-stream query() loop.
 *
 * Reproduces the close-cycle Phase 1 (scanStreamHeads) workload at
 * realistic bulk-close sizes (10 → 1000 streams). Measures wall time
 * for both shapes against an `InMemoryStore` so the comparison
 * isolates framework + Map allocation overhead from disk I/O.
 *
 * **Regression bound (Shape C, per BENCH.md):**
 * - At N=1000 streams, `query_stats` must be at least 2× faster than
 *   the per-stream loop. In practice the microbench shows ~20-30× at
 *   this N for InMemory; the 2× bound is intentionally loose so the
 *   test stays green on slow CI hardware.
 *
 * On durable adapters (PG, SQLite) the win is structurally larger:
 * the per-stream loop pays N transactions / N index lookups, vs one.
 * Those numbers belong in the per-adapter benches.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryStore } from "../src/adapters/in-memory-store.js";
import type { Committed, Schemas } from "../src/types/index.js";

const SIZES = [10, 100, 1000] as const;
const EVENTS_PER_STREAM = 10;

const store = new InMemoryStore();
const seeded: { [N in (typeof SIZES)[number]]?: string[] } = {};

beforeAll(async () => {
  await store.seed();
  for (const N of SIZES) {
    const names: string[] = [];
    for (let i = 0; i < N; i++) {
      const stream = `close-bench-${N}-${i}`;
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

/** Hand-rolled equivalent of the pre-ACT-639 close-cycle scanStreamHeads. */
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

describe("close-cycle bulk-scan benchmark", () => {
  for (const N of SIZES) {
    it(`N=${N} streams — query_stats vs per-stream loop`, async () => {
      // biome-ignore lint/style/noNonNullAssertion: seeded in beforeAll
      const streams = seeded[N]!;

      // Warmup pass each — vitest's JIT may compile the first call.
      await perStreamHeads(streams);
      await store.query_stats(streams);

      // --- Per-stream loop (pre-ACT-639) ---
      const perStart = performance.now();
      const perResult = await perStreamHeads(streams);
      const perTime = performance.now() - perStart;

      // --- query_stats (post-ACT-639) ---
      const qsStart = performance.now();
      const qsResult = await store.query_stats(streams);
      const qsTime = performance.now() - qsStart;

      const speedup = perTime / qsTime;

      console.log(
        `  N=${N.toString().padStart(4)} streams | per-stream loop: ${perTime.toFixed(2).padStart(8)}ms | query_stats: ${qsTime.toFixed(2).padStart(7)}ms | speedup: ${speedup.toFixed(1).padStart(5)}x`
      );

      // Both should return the same set of streams.
      expect(qsResult.size).toBe(perResult.size);

      // Regression bound: at N=1000, query_stats must be ≥2× faster.
      // Smaller N: the constant overhead dominates, so we don't assert
      // a multiplier — just record the timing for the PR writeup.
      if (N >= 1000) {
        expect(speedup).toBeGreaterThanOrEqual(2);
      }
    }, 10_000); // wall-time budget. // Per-stream loop at N=1000 is slow — give the test a generous
  }
});
