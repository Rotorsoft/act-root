/**
 * ACT-103 — single-process commit→reaction latency.
 *
 * Question: "from `app.do()` to the reaction handler firing, how long?"
 * Architects evaluating Act for time-sensitive workflows ask this
 * first, and PERFORMANCE.md should answer it in writing.
 *
 * Three steady-state scenarios per adapter:
 *   - **idle**: one commit at a time, reaction fires, repeat. Measures
 *     the floor — settle debounce + correlate + drain + handler.
 *   - **low**: 100 commits/sec sustained for ~3 s. Realistic
 *     interactive workload.
 *   - **high**: 1000 commits/sec sustained for ~3 s. Stress test —
 *     reveals where the framework saturates on InMemory and how the
 *     PG adapter copes with a busy commit pipeline.
 *
 * For each scenario we record commit→reaction latency per event and
 * report p50/p95/p99. Numbers feed `libs/act/PERFORMANCE.md`.
 *
 * **Adapter coverage:** InMemoryStore here. PostgresStore latency
 * lives in `libs/act-pg/test/notify-perf.bench.ts` (cross-process)
 * and the act-pg single-process variant gets added once we have a
 * stable single-process baseline.
 *
 * Filename uses `.bench.ts` so the default `vitest run` glob skips
 * it. Invoke explicitly:
 *
 *   pnpm -F @rotorsoft/act exec vitest run --config vitest.bench.config.ts
 */
import { z } from "zod";
import { InMemoryStore } from "../src/adapters/in-memory-store.js";
import { act } from "../src/builders/act-builder.js";
import { state } from "../src/builders/state-builder.js";
import { dispose, store } from "../src/ports.js";
import type { ReactionHandler } from "../src/types/index.js";

const ACTOR = { id: "bench", name: "bench" };

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Tick: z.object({ id: z.string() }) })
  .on({ tick: z.object({ id: z.string() }) })
  .emit("Tick")
  .build();

type LatencyRecorder = {
  start: (id: string) => void;
  finish: (id: string) => void;
  /** Snapshot of collected samples without consuming them. */
  snapshot: () => number[];
  /** Take the samples and reset the buffer. */
  drain: () => number[];
};

function recorder(): LatencyRecorder {
  const starts = new Map<string, number>();
  const samples: number[] = [];
  return {
    start: (id) => starts.set(id, performance.now()),
    finish: (id) => {
      const t = starts.get(id);
      if (t !== undefined) {
        samples.push(performance.now() - t);
        starts.delete(id);
      }
    },
    snapshot: () => samples.slice(),
    drain: () => samples.splice(0),
  };
}

function pct(samples: number[], p: number) {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))
  ];
}

/**
 * Build an Act instance with a `Tick` reaction whose handler records
 * the per-event latency. Returns the wired components plus the
 * recorder so callers can inspect samples.
 */
function buildApp(rec: LatencyRecorder) {
  store(new InMemoryStore());

  const handler: ReactionHandler<{ Tick: { id: string } }, "Tick"> = async (
    event
  ) => {
    rec.finish(event.data.id);
  };

  const app = act()
    .withState(Counter)
    .on("Tick")
    .do(handler)
    .to((e) => ({ source: e.stream, target: `proj-${e.stream}` }))
    .build();

  // Production pattern: settle on every commit so reactions wake on
  // the local fast path (do → arm drain → settle debounced).
  app.on("committed", () => app.settle({ debounceMs: 0 }));

  return app;
}

/**
 * Drive a steady-state commit rate for `durationMs` and return the
 * collected latency samples. `commitsPerSec === 0` means one-at-a-time
 * (the idle floor) — wait for each reaction before issuing the next.
 */
async function runScenario(
  commitsPerSec: number,
  durationMs: number
): Promise<{ samples: number[]; commits: number; capturedFraction: number }> {
  const rec = recorder();
  const app = buildApp(rec);
  let commits = 0;

  try {
    // Spread commits across many source streams to avoid serialized
    // contention on a single stream's version. With one stream and
    // 1000 commits/sec, every commit races the prior one for
    // expectedVersion — measuring contention, not latency.
    const STREAM_COUNT = 256;
    const nextStream = (i: number) => `src-${i % STREAM_COUNT}`;

    if (commitsPerSec === 0) {
      // Idle scenario — strictly one commit at a time. Wait for the
      // reaction to land before issuing the next so the measurement
      // captures the full do→reaction round-trip without queue
      // interference.
      const start = performance.now();
      while (performance.now() - start < durationMs) {
        const id = `idle-${commits}`;
        rec.start(id);
        const samplesBefore = rec.snapshot().length;
        await app.do(
          "tick",
          { stream: nextStream(commits), actor: ACTOR },
          { id }
        );
        commits++;
        // Wait until the reaction handler has appended a new
        // sample. Settle is debounced at 0ms so the handler
        // typically fires within a few ms.
        const deadline = performance.now() + 200;
        while (
          rec.snapshot().length === samplesBefore &&
          performance.now() < deadline
        ) {
          await new Promise((r) => setTimeout(r, 1));
        }
      }
    } else {
      // Steady-state — fire commits at a fixed rate, round-robin
      // across source streams. Reactions land asynchronously; the
      // recorder collects whatever drains through during the window.
      const intervalMs = 1000 / commitsPerSec;
      const start = performance.now();
      const inFlight: Promise<unknown>[] = [];
      while (performance.now() - start < durationMs) {
        const id = `r-${commits}`;
        rec.start(id);
        inFlight.push(
          app
            .do("tick", { stream: nextStream(commits), actor: ACTOR }, { id })
            // Treat concurrency races as best-effort — the latency
            // sample is dropped (the recorder never sees a finish).
            .catch(() => undefined)
        );
        commits++;
        await new Promise((r) => setTimeout(r, intervalMs));
      }
      // Let the in-flight commits finish + reactions drain.
      await Promise.allSettled(inFlight);
      await new Promise((r) => setTimeout(r, 500));
    }
    const samples = rec.drain();
    return {
      samples,
      commits,
      capturedFraction: samples.length / Math.max(1, commits),
    };
  } finally {
    app.stop_correlations();
    app.stop_settling();
    await dispose()("EXIT").catch(() => {});
  }
}

const SCENARIOS: ReadonlyArray<{
  name: string;
  rate: number;
  durationMs: number;
}> = [
  { name: "idle", rate: 0, durationMs: 1500 },
  { name: "low (100/s)", rate: 100, durationMs: 3000 },
  { name: "high (1000/s)", rate: 1000, durationMs: 3000 },
];

describe("ACT-103 commit→reaction latency (InMemoryStore)", () => {
  it("p50/p95/p99 across idle / low / high steady-state rates", async () => {
    const results: Record<string, Record<string, string>> = {};

    for (const s of SCENARIOS) {
      const r = await runScenario(s.rate, s.durationMs);
      results[`${s.name} (n=${r.samples.length}/${r.commits})`] = {
        p50: `${pct(r.samples, 50).toFixed(1)} ms`,
        p95: `${pct(r.samples, 95).toFixed(1)} ms`,
        p99: `${pct(r.samples, 99).toFixed(1)} ms`,
      };
    }

    // eslint-disable-next-line no-console
    console.log("\n=== ACT-103 commit→reaction latency (InMemoryStore) ===");
    // eslint-disable-next-line no-console
    console.table(results);

    // Regression bound: the idle p99 must stay under a generous
    // ceiling. Picked at 5× the empirical floor — anything that
    // crosses it is a real regression in the do→settle→drain path.
    const idleResults = await runScenario(0, 1000);
    const idleP99 = pct(idleResults.samples, 99);
    expect(idleP99).toBeLessThan(50);
  }, 60_000);
});
