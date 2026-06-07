/**
 * Perf regression bench for `@rotorsoft/act`. Measures a small, stable
 * set of hot-path scenarios against `InMemoryStore` and writes a JSON
 * report. The companion script `perf-check.ts` compares the report to
 * `perf-baseline.json` and exits non-zero on regression.
 *
 * Why a plain Node script instead of vitest bench:
 * - Full control over JSON output format (vitest 4's `--reporter=json`
 *   doesn't load for `vitest bench`).
 * - Per-iteration setup is straightforward without fighting framework
 *   conventions.
 * - One file does the measurement; one file does the comparison.
 *
 * Usage:
 *   pnpm tsx libs/act/scripts/perf-bench.ts > libs/act/perf-result.json
 *   pnpm tsx libs/act/scripts/perf-check.ts
 *
 * To refresh the baseline (in a labeled PR):
 *   pnpm tsx libs/act/scripts/perf-bench.ts > libs/act/perf-baseline.json
 */

import { performance } from "node:perf_hooks";
import { z } from "zod";
import { InMemoryCache } from "../src/adapters/in-memory-cache.js";
import { InMemoryStore } from "../src/adapters/in-memory-store.js";
import { state } from "../src/builders/state-builder.js";
import { action, load } from "../src/internal/event-sourcing.js";
import { cache, dispose, store } from "../src/ports.js";
import { ZodEmpty } from "../src/types/schemas.js";

// ---------------------------------------------------------------------------
// Scenario state
// ---------------------------------------------------------------------------

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Inc: ZodEmpty })
  .patch({ Inc: (_, s) => ({ count: s.count + 1 }) })
  .on({ inc: ZodEmpty })
  .emit("Inc")
  .build();

const target = (stream: string) => ({
  stream,
  actor: { id: "u", name: "u" },
});

const resetPorts = async () => {
  await dispose()();
  store(new InMemoryStore());
  cache(new InMemoryCache());
};

// ---------------------------------------------------------------------------
// Bench runner
// ---------------------------------------------------------------------------

interface Scenario {
  readonly name: string;
  /** Once before timed iterations (e.g., seed events into the store). */
  readonly setup: () => Promise<void>;
  /** Before each timed iteration (e.g., clear cache for a cold-replay). */
  readonly preIteration?: () => Promise<void>;
  /** Measured. */
  readonly run: () => Promise<void>;
  /**
   * For batched scenarios (e.g., "50 concurrent commits"), the number
   * of underlying ops per timed run. Drives the `effective_per_sec`
   * field so callers don't have to do the math.
   */
  readonly batchSize?: number;
}

interface BenchResult {
  readonly name: string;
  readonly samples: number;
  readonly p50_ms: number;
  readonly p95_ms: number;
  readonly mean_ms: number;
  readonly ops_per_sec: number;
  /** For batched scenarios: total underlying ops per second. */
  readonly effective_per_sec?: number;
}

async function measure(s: Scenario, iters: number): Promise<BenchResult> {
  await s.setup();

  // Warmup — JIT, allocate caches.
  for (let i = 0; i < 10; i++) {
    if (s.preIteration) await s.preIteration();
    await s.run();
  }

  const samples: number[] = [];
  for (let i = 0; i < iters; i++) {
    if (s.preIteration) await s.preIteration();
    const t0 = performance.now();
    await s.run();
    samples.push(performance.now() - t0);
  }

  samples.sort((a, b) => a - b);
  const p50 = samples[Math.floor(samples.length * 0.5)];
  const p95 = samples[Math.floor(samples.length * 0.95)];
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const opsPerSec = round(1000 / mean, 0);
  const result: BenchResult = {
    name: s.name,
    samples: samples.length,
    p50_ms: round(p50),
    p95_ms: round(p95),
    mean_ms: round(mean),
    ops_per_sec: opsPerSec,
    ...(s.batchSize ? { effective_per_sec: opsPerSec * s.batchSize } : {}),
  };
  return result;
}

const round = (n: number, decimals = 4) => Number(n.toFixed(decimals));

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const scenarios: Scenario[] = [
  {
    name: "action: single commit",
    async setup() {
      await resetPorts();
    },
    async run() {
      await action(Counter, "inc", target("hot"), {});
    },
  },
  {
    name: "load: warm cache hit",
    async setup() {
      await resetPorts();
      // Seed one commit + warm the cache.
      await action(Counter, "inc", target("warm"), {});
      await load(Counter, { stream: "warm" });
    },
    async run() {
      await load(Counter, { stream: "warm" });
    },
  },
  {
    name: "load: cold replay 100 events",
    async setup() {
      await resetPorts();
      for (let i = 0; i < 100; i++) {
        await action(Counter, "inc", target("cold"), {});
      }
    },
    async preIteration() {
      // Clear cache so each iter replays from the store.
      await cache().clear();
    },
    async run() {
      await load(Counter, { stream: "cold" });
    },
  },
  {
    name: "action+load roundtrip",
    async setup() {
      await resetPorts();
    },
    async run() {
      await action(Counter, "inc", target("rt"), {});
      await load(Counter, { stream: "rt" });
    },
  },
  {
    // Concurrent commits across DIFFERENT streams — direct answer to
    // "how many commits/sec across the framework". No contention; the
    // event loop interleaves the parallel actions.
    name: "commits: 50 concurrent (different streams)",
    batchSize: 50,
    async setup() {
      await resetPorts();
    },
    async run() {
      const batch: Promise<unknown>[] = [];
      for (let i = 0; i < 50; i++) {
        batch.push(
          action(Counter, "inc", target(`concurrent-${i}-${Math.random()}`), {})
        );
      }
      await Promise.all(batch);
    },
  },
  {
    // Concurrent commits to the SAME stream — answers "how many
    // concurrent users can hammer a single stream" (e.g. a multiplayer
    // game's shared room state). Under optimistic concurrency, only one
    // commit per version succeeds; the rest retry. Reports realistic
    // throughput including retry overhead.
    name: "commits: 20 contended (same stream, with retries)",
    batchSize: 20,
    async setup() {
      await resetPorts();
    },
    async run() {
      const stream = `contended-${Math.random()}`;
      const tasks = Array.from({ length: 20 }, async () => {
        for (let attempt = 0; attempt < 50; attempt++) {
          try {
            await action(Counter, "inc", target(stream), {});
            return;
          } catch (err) {
            // Retry only on ConcurrencyError; rethrow anything else.
            if (!(err instanceof Error) || !err.message.includes("Concurrency"))
              throw err;
          }
        }
      });
      await Promise.all(tasks);
    },
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Iteration counts tuned to keep total time < 30s on CI hardware.
  const counts: Record<string, number> = {
    "action: single commit": 200,
    "load: warm cache hit": 500,
    "load: cold replay 100 events": 100,
    "action+load roundtrip": 200,
    "commits: 50 concurrent (different streams)": 50,
    "commits: 20 contended (same stream, with retries)": 30,
  };

  const results: BenchResult[] = [];
  for (const s of scenarios) {
    const iters = counts[s.name] ?? 200;
    process.stderr.write(`Running ${s.name} (${iters} iters)...\n`);
    results.push(await measure(s, iters));
  }
  await dispose()();

  process.stdout.write(JSON.stringify({ results }, null, 2) + "\n");
}

void main();
