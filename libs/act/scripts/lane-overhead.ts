/**
 * ACT-1103 — lane fan-out overhead on the drain path.
 *
 * Two questions:
 *
 * 1. **Zero regression for zero-lane apps.** An app that never calls
 *    `.withLane(...)` runs on a single implicit controller whose
 *    `claim()` is invoked with `lane: undefined`, so the adapter SQL
 *    collapses to the pre-1103 shape.
 *
 * 2. **Bounded multi-lane cost.** With four lanes declared, `drain()`
 *    walks the controller map and invokes `claim()` once per lane;
 *    each filtered claim still serves from the lane index on durable
 *    adapters. Total drain time should grow by a small constant — not
 *    multiplicatively per stream.
 *
 * Each scenario re-primes its workload before every timed iteration
 * (drain is destructive — once a stream is acked, the next iteration
 * has no work). Numbers feed `libs/act/PERFORMANCE.md`.
 *
 * Usage:
 *   pnpm tsx libs/act/scripts/lane-overhead.ts > /tmp/lane-overhead.json
 */

import { performance } from "node:perf_hooks";
import { z } from "zod";
import { InMemoryCache } from "../src/adapters/in-memory-cache.js";
import { InMemoryStore } from "../src/adapters/in-memory-store.js";
import { act } from "../src/builders/act-builder.js";
import { state } from "../src/builders/state-builder.js";
import { cache, dispose, store } from "../src/ports.js";
import { ZodEmpty } from "../src/types/schemas.js";

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Tick: ZodEmpty })
  .patch({ Tick: (_, s) => ({ count: s.count + 1 }) })
  .on({ tick: ZodEmpty })
  .emit(() => ["Tick", {}])
  .build();

const ACTOR = { id: "bench", name: "bench" };
const STREAMS_PER_ITER = 100;

const resetPorts = async () => {
  await dispose()();
  store(new InMemoryStore());
  cache(new InMemoryCache());
};

async function buildSingleLane() {
  return act()
    .withState(Counter)
    .on("Tick")
    .do(async function noop() {})
    .to((event) => ({ target: `target-${event.stream}` }))
    .build();
}

async function buildFourLanes() {
  return act()
    .withState(Counter)
    .withLane({ name: "slow", leaseMillis: 30_000, streamLimit: 25 })
    .withLane({ name: "fast", leaseMillis: 5_000, streamLimit: 25 })
    .withLane({ name: "best-effort", leaseMillis: 1_000, streamLimit: 25 })
    .on("Tick")
    .do(async function noop() {})
    .to((event) => {
      const lane = (["default", "slow", "fast", "best-effort"] as const)[
        Number(event.stream.split("-")[1]) % 4
      ];
      return { target: `target-${event.stream}`, lane };
    })
    .build();
}

interface BenchResult {
  readonly name: string;
  readonly samples: number;
  readonly p50_ms: number;
  readonly p95_ms: number;
  readonly mean_ms: number;
  readonly drains_per_sec: number;
}

const round = (n: number, d = 4) => Number(n.toFixed(d));

async function measure(
  name: string,
  // Loose `any` — each builder returns an Act narrowed to its declared
  // lane union, and structural matching against an interface that
  // widens `do`'s action parameter trips parameter contravariance.
  // The script only calls do/correlate/drain by name; runtime types
  // line up regardless.
  builder: () => Promise<any>,
  iterations = 30
): Promise<BenchResult> {
  const samples: number[] = [];
  let seq = 0;

  for (let i = 0; i < iterations + 5; i++) {
    await resetPorts();
    const app = await builder();
    for (let s = 0; s < STREAMS_PER_ITER; s++) {
      await app.do("tick", { stream: `stream-${seq}-${s}`, actor: ACTOR }, {});
    }
    seq++;
    await app.correlate();

    const t0 = performance.now();
    // Drain until settled — each lane controller might need multiple
    // cycles to clear `streamLimit` budget.
    let cycle = 0;
    for (;;) {
      const d = (await app.drain({
        streamLimit: 50,
        leaseMillis: 1_000,
      })) as { acked: unknown[]; blocked: unknown[]; leased: unknown[] };
      cycle++;
      if (
        d.acked.length === 0 &&
        d.blocked.length === 0 &&
        d.leased.length === 0
      )
        break;
      if (cycle > 50) break;
    }
    const dt = performance.now() - t0;
    if (i >= 5) samples.push(dt);
  }

  samples.sort((a, b) => a - b);
  const p50 = samples[Math.floor(samples.length * 0.5)];
  const p95 = samples[Math.floor(samples.length * 0.95)];
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  return {
    name,
    samples: samples.length,
    p50_ms: round(p50),
    p95_ms: round(p95),
    mean_ms: round(mean),
    drains_per_sec: round(1000 / mean, 0),
  };
}

async function main() {
  process.stderr.write("Running 1-lane baseline...\n");
  const single = await measure(
    "drain 100 streams — 1 lane (no withLane)",
    buildSingleLane
  );
  process.stderr.write("Running 4-lane fan-out...\n");
  const multi = await measure(
    "drain 100 streams — 4 lanes (default + 3 declared)",
    buildFourLanes
  );

  await dispose()();
  process.stdout.write(
    `${JSON.stringify({ results: [single, multi] }, null, 2)}\n`
  );
}

void main();
