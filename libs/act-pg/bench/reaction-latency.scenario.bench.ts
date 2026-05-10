/**
 * ACT-103 — single-process commit→reaction latency on PostgreSQL.
 *
 * Mirrors `libs/act/bench/reaction-latency.scenario.bench.ts`
 * (InMemoryStore) with the PG adapter swapped in. Same three
 * steady-state scenarios — idle / low / high — same recorder, same
 * percentile reporting.
 *
 * **Scope.** Single-process: writer and reader live on the same Act
 * instance, so notify wake-up is irrelevant — local commits arm the
 * drain via `do()` directly. Cross-process latency (writer and
 * reader on separate processes, with and without notify) lives in
 * `bench/notify-perf.scenario.bench.ts`.
 *
 * Run:
 *
 *   pnpm bench:scenarios libs/act-pg/bench/reaction-latency.scenario.bench.ts
 */

import type { ReactionHandler } from "@rotorsoft/act";
import { act, dispose, state, store } from "@rotorsoft/act";
import { z } from "zod";
import { PostgresStore } from "../src/postgres-store.js";

const PORT = 5431;
const SCHEMA = "act_latency_bench";
const TABLE = "events";
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
  snapshot: () => number[];
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

async function buildApp(rec: LatencyRecorder) {
  store(new PostgresStore({ port: PORT, schema: SCHEMA, table: TABLE }));
  await store().drop();
  await store().seed();

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

async function runScenario(
  commitsPerSec: number,
  durationMs: number
): Promise<{ samples: number[]; commits: number }> {
  const rec = recorder();
  const app = await buildApp(rec);
  let commits = 0;

  // Spread commits across many source streams to avoid serialized
  // contention on a single stream's version. With one stream and a
  // high commit rate, every commit races the prior one for
  // expectedVersion — measuring contention, not latency.
  // For the idle scenario (one commit at a time) a single source is
  // fine — no concurrency, no version contention — and lets one
  // warmup pre-pay the connection + dynamic-resolver subscribe cost
  // up front.
  const STREAM_COUNT = commitsPerSec === 0 ? 1 : 256;
  const nextStream = (i: number) => `src-${i % STREAM_COUNT}`;

  // Warm-up: the first commit on a fresh source stream pays for PG
  // connection setup, the initial correlate scan, and registering
  // the dynamic-resolver target. Pre-pay each source once, drain
  // the samples, and start the timed window from a steady state.
  for (let i = 0; i < STREAM_COUNT; i++) {
    await app.do(
      "tick",
      { stream: nextStream(i), actor: ACTOR },
      { id: `warmup-${i}` }
    );
  }
  const warmupDeadline = performance.now() + 2000;
  while (
    rec.snapshot().length < STREAM_COUNT &&
    performance.now() < warmupDeadline
  ) {
    await new Promise((r) => setTimeout(r, 5));
  }
  rec.drain();

  try {
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
        const deadline = performance.now() + 500;
        while (
          rec.snapshot().length === samplesBefore &&
          performance.now() < deadline
        ) {
          await new Promise((r) => setTimeout(r, 1));
        }
      }
    } else {
      const intervalMs = 1000 / commitsPerSec;
      const start = performance.now();
      const inFlight: Promise<unknown>[] = [];
      while (performance.now() - start < durationMs) {
        const id = `r-${commits}`;
        rec.start(id);
        inFlight.push(
          app
            .do("tick", { stream: nextStream(commits), actor: ACTOR }, { id })
            .catch(() => undefined)
        );
        commits++;
        await new Promise((r) => setTimeout(r, intervalMs));
      }
      await Promise.allSettled(inFlight);
      // Trailing window for reactions to drain — PG roundtrips need
      // more headroom than InMemory.
      await new Promise((r) => setTimeout(r, 1500));
    }
    return { samples: rec.drain(), commits };
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

describe("ACT-103 commit→reaction latency (PostgresStore single-process)", () => {
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
    console.log(
      "\n=== ACT-103 commit→reaction latency (PostgresStore single-process) ==="
    );
    // eslint-disable-next-line no-console
    console.table(results);

    // Regression bound: idle p50 (median) must stay under a generous
    // ceiling. We assert on p50 rather than p99 because the idle
    // scenario's small sample count (~50 events) makes p99 highly
    // sensitive to single PG-side outliers (autovacuum, transient
    // I/O, etc.). p50 is stable across runs and catches genuine
    // framework regressions; tail variance lives in the reported
    // table for operators who need it.
    const idleResults = await runScenario(0, 1500);
    const idleP50 = pct(idleResults.samples, 50);
    expect(idleP50).toBeLessThan(50);
  }, 90_000);
});
