/**
 * ACT-1103 — fast-lane responsiveness under slow-lane backpressure.
 *
 * Question: when a slow reaction handler holds streams for 100 ms+,
 * does the framework still deliver fast-lane events promptly?
 *
 * Two single-Act configurations, same store:
 *
 *   A) No `withLane(...)` — one DrainController, shared between all
 *      reactions. The current pre-1103 behavior.
 *   B) Two lanes (`slow` + `fast`) — one controller per lane.
 *      `Act._drain_all` calls each controller's drain in parallel
 *      (Promise.all), so a slow handler holding the slow lane's
 *      lease doesn't block the fast lane's claim.
 *
 * Workload per iteration:
 *   - Commit 5 events on slow-source streams (handler sleeps 100 ms).
 *   - Concurrently commit 50 events on fast-source streams (no-op
 *     handler).
 *   - settle() until all targets ack.
 *   - Record commit→ack latency per fast event.
 *
 * Headline metric: fast-event p50 / p95 latency. The lane config
 * should keep fast latency near the no-op floor; the no-lane config
 * has to wait for slow handlers to clear each drain cycle before
 * the next claim picks up fast streams.
 *
 * Run:
 *   pnpm tsx libs/act-pg/scripts/lane-responsiveness.ts
 */

import { performance } from "node:perf_hooks";
import {
  act,
  cache,
  dispose,
  InMemoryCache,
  state,
  store,
  ZodEmpty,
} from "@rotorsoft/act";
import { z } from "zod";
import { PostgresStore } from "../src/postgres-store.js";

const PORT = 5431;
const SCHEMA = "act_lane_resp_bench";
const TABLE = "events";
const ACTOR = { id: "bench", name: "bench" };
const SLOW_HANDLER_MS = 100;
const SLOW_EVENTS = 5;
const FAST_EVENTS = 50;
const ITERATIONS = 6;

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ SlowTick: ZodEmpty, FastTick: ZodEmpty })
  .patch({
    SlowTick: (_, s) => ({ count: s.count + 1 }),
    FastTick: (_, s) => ({ count: s.count + 1 }),
  })
  .on({ slowTick: ZodEmpty })
  .emit(() => ["SlowTick", {}])
  .on({ fastTick: ZodEmpty })
  .emit(() => ["FastTick", {}])
  .build();

/** Per-iteration latency bookkeeping. Latency is measured from
 * `startMark` (set after every commit lands and correlate completes)
 * to the moment each fast handler fires — so the number reflects the
 * orchestrator's responsiveness, not the bench's own commit serialization. */
type Recorder = {
  startMark: number;
  readonly fastSamples: number[];
};

function makeRecorder(): Recorder {
  return { startMark: 0, fastSamples: [] };
}

const sleep = (ms: number) =>
  new Promise<void>((res) => {
    setTimeout(res, ms);
  });

async function resetPorts() {
  await dispose()();
  store(new PostgresStore({ port: PORT, schema: SCHEMA, table: TABLE }));
  cache(new InMemoryCache());
  await store().drop();
  await store().seed();
}

async function buildSingleController(rec: Recorder) {
  return act()
    .withState(Counter)
    .on("SlowTick")
    .do(async function slowHandler() {
      await sleep(SLOW_HANDLER_MS);
    })
    .to((event) => ({ target: `slow-target-${event.stream}` }))
    .on("FastTick")
    .do(async function fastHandler() {
      if (rec.startMark > 0)
        rec.fastSamples.push(performance.now() - rec.startMark);
    })
    .to((event) => ({ target: `fast-target-${event.stream}` }))
    .build();
}

async function buildTwoLanes(rec: Recorder) {
  return act()
    .withState(Counter)
    .withLane({ name: "slow", leaseMillis: 30_000, streamLimit: SLOW_EVENTS })
    .withLane({ name: "fast", leaseMillis: 5_000, streamLimit: 50 })
    .on("SlowTick")
    .do(async function slowHandler() {
      await sleep(SLOW_HANDLER_MS);
    })
    .to((event) => ({ target: `slow-target-${event.stream}`, lane: "slow" }))
    .on("FastTick")
    .do(async function fastHandler() {
      if (rec.startMark > 0)
        rec.fastSamples.push(performance.now() - rec.startMark);
    })
    .to((event) => ({ target: `fast-target-${event.stream}`, lane: "fast" }))
    .build();
}

interface Stats {
  readonly name: string;
  readonly samples: number;
  readonly p50_ms: number;
  readonly p95_ms: number;
  readonly p99_ms: number;
  readonly mean_ms: number;
}

const round = (n: number, d = 4) => Number(n.toFixed(d));

function stats(name: string, samples: number[]): Stats {
  if (samples.length === 0)
    return {
      name,
      samples: 0,
      p50_ms: 0,
      p95_ms: 0,
      p99_ms: 0,
      mean_ms: 0,
    };
  const sorted = [...samples].sort((a, b) => a - b);
  const pct = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))];
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return {
    name,
    samples: sorted.length,
    p50_ms: round(pct(50)),
    p95_ms: round(pct(95)),
    p99_ms: round(pct(99)),
    mean_ms: round(mean),
  };
}

async function runConfig(
  name: string,
  // Loose `any` — each builder returns an Act narrowed to its declared
  // action and lane unions, which trips contravariance against a
  // shared structural interface. Runtime types line up.
  build: (rec: Recorder) => Promise<any>
): Promise<Stats> {
  const samples: number[] = [];
  let seq = 0;

  for (let iter = 0; iter < ITERATIONS; iter++) {
    await resetPorts();
    const rec = makeRecorder();
    const app = (await build(rec)) as any;

    // Commit all slow + all fast events as fast as possible, in
    // commit order. The fast events are committed AFTER the slow
    // ones — what the operator cares about is "do new fast events
    // get serviced while slow handlers are still in flight?"
    seq++;
    for (let i = 0; i < SLOW_EVENTS; i++) {
      const stream = `slow-${seq}-${i}`;
      await app.do("slowTick", { stream, actor: ACTOR }, {});
    }
    for (let i = 0; i < FAST_EVENTS; i++) {
      const stream = `fast-${seq}-${i}`;
      await app.do("fastTick", { stream, actor: ACTOR }, {});
    }
    await app.correlate();

    // Start the latency clock AFTER commits land. Fast-handler latency
    // is then measured from "drain may begin" to "handler fires" —
    // commit serialization stays out of the number.
    rec.startMark = performance.now();

    // Drain to completion. Per-lane configs supply leaseMillis (slow
    // 30s, fast 5s); the bench passes nothing so each lane keeps its
    // own budget.
    let cycle = 0;
    for (;;) {
      const d = await app.drain();
      cycle++;
      if (rec.fastSamples.length >= FAST_EVENTS) break;
      if (d.acked.length === 0 && d.blocked.length === 0 && cycle > 200) break;
      // Give in-flight handlers a chance to make progress between
      // cycles. Without this the loop spins, claim() returns nothing
      // (everything leased), and cycle increments uselessly.
      if (d.leased.length === 0 && d.acked.length === 0) await sleep(5);
    }

    samples.push(...rec.fastSamples);
  }

  return stats(name, samples);
}

async function main() {
  process.stderr.write("Running single-controller (no withLane)...\n");
  const single = await runConfig(
    "fast-event latency — single controller (no withLane)",
    buildSingleController
  );
  process.stderr.write("Running two-lane (slow + fast)...\n");
  const twoLanes = await runConfig(
    "fast-event latency — two lanes (slow + fast)",
    buildTwoLanes
  );

  await dispose()();
  process.stdout.write(
    `${JSON.stringify({ results: [single, twoLanes] }, null, 2)}\n`
  );
}

void main();
