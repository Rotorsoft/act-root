/**
 * ACT-1103 — lane fan-out overhead on PostgresStore.
 *
 * Same shape as `libs/act/scripts/lane-overhead.ts` (InMemoryStore)
 * with the PG adapter swapped in. This is the number that counts —
 * InMemory has no index, so its lane filter scans every subscribed
 * stream; PG serves the lane-filtered claim from `streams_lane_ix`
 * and shows what production deployments actually pay.
 *
 * Each iteration re-primes 100 events on distinct streams, runs
 * `app.correlate()`, then times `app.drain()` until settled. 30
 * timed iterations after 5 warmups.
 *
 * Requires Docker PG on port 5431 (the same instance the test suite
 * uses).
 *
 * Usage:
 *   pnpm tsx libs/act-pg/scripts/lane-overhead.ts > /tmp/lane-overhead-pg.json
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
const SCHEMA = "act_lane_overhead_bench";
const TABLE = "events";
const ACTOR = { id: "bench", name: "bench" };
const STREAMS_PER_ITER = 100;

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Tick: ZodEmpty })
  .patch({ Tick: (_, s) => ({ count: s.count + 1 }) })
  .on({ tick: ZodEmpty })
  .emit(() => ["Tick", {}])
  .build();

const resetPorts = async () => {
  await dispose()();
  store(new PostgresStore({ port: PORT, schema: SCHEMA, table: TABLE }));
  cache(new InMemoryCache());
  await store().drop();
  await store().seed();
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
  // Same `any` rationale as the InMemory version: each builder narrows
  // `do`'s action parameter, which trips contravariance against a
  // shared structural interface. Runtime types line up.
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
  process.stderr.write("Running 1-lane baseline against PG...\n");
  const single = await measure(
    "drain 100 streams — 1 lane (no withLane) — PG",
    buildSingleLane
  );
  process.stderr.write("Running 4-lane fan-out against PG...\n");
  const multi = await measure(
    "drain 100 streams — 4 lanes (default + 3 declared) — PG",
    buildFourLanes
  );

  await dispose()();
  process.stdout.write(
    `${JSON.stringify({ results: [single, multi] }, null, 2)}\n`
  );
}

void main();
