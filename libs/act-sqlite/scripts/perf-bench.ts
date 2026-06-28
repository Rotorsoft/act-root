/**
 * Perf regression bench for `@rotorsoft/act-sqlite`. Measures a small,
 * stable set of hot-path scenarios against a **real on-disk SQLite**
 * database (a scratch file under `scripts/`, not `:memory:`) and writes a
 * JSON report. The companion script `perf-check.ts` compares the report
 * to `perf-baseline.json` and exits non-zero on a budgeted regression.
 *
 * Mirrors `libs/act/scripts/perf-bench.ts` exactly in shape — same
 * `Scenario`/`BenchResult` types, same warmup + percentile math. The
 * difference is the store under test: a real SQLite file exercises the
 * WAL writer, the prepared-statement cache, and the query planner over
 * real indexes — where adapter regressions (a lost index, a snapshot-
 * floor read that scans the whole stream) actually surface. SQLite needs
 * no docker, so this baseline is generated locally and checked in.
 *
 * Why a plain Node script instead of vitest bench: see the sibling note
 * in `libs/act/scripts/perf-bench.ts`. Same reasoning.
 *
 * The `notify` scenario from the act-pg harness is omitted here — SQLite
 * is single-node by design and does not implement `Store.notify`.
 *
 * Usage:
 *   pnpm -F @rotorsoft/act-sqlite bench:run    # writes perf-result.json
 *   pnpm -F @rotorsoft/act-sqlite bench:check  # compares to baseline
 *
 * To refresh the baseline (in a PR labeled `perf-baseline-update`):
 *   pnpm -F @rotorsoft/act-sqlite bench:update # writes perf-baseline.json
 */

import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  act,
  cache,
  dispose,
  type ReactionHandler,
  SNAP_EVENT,
  state,
  store,
  ZodEmpty,
} from "@rotorsoft/act";
import { z } from "zod";
import { SqliteStore } from "../src/sqlite-store.js";

// Co-locate the scratch file with the script that owns it so the
// WAL/SHM sidecars don't leak into the repo root.
const DB_PATH = join(import.meta.dirname, "perf-bench.db");

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

const noopReaction: ReactionHandler<
  { Inc: Record<string, never> },
  "Inc"
> = async () => {};

/** Builds an Act app against the *currently injected* store. */
const buildApp = () =>
  act()
    .withState(Counter)
    .on("Inc")
    .do(noopReaction)
    .to((e) => ({ source: e.stream, target: `proj-${e.stream}` }))
    .build();

let app: ReturnType<typeof buildApp>;

const unlinkDb = () => {
  for (const ext of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(DB_PATH + ext);
    } catch {
      // file may not exist
    }
  }
};

const resetStore = async () => {
  await dispose()();
  unlinkDb();
  store(new SqliteStore({ url: `file:${DB_PATH}` }));
  await store().drop();
  await store().seed();
  // Build the orchestrator AFTER injecting the store.
  app = buildApp();
};

// ---------------------------------------------------------------------------
// Bench runner (identical shape to libs/act/scripts/perf-bench.ts)
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
   * For batched scenarios (e.g., "50-event commit"), the number of
   * underlying ops per timed run. Drives the `effective_per_sec` field.
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
  readonly effective_per_sec?: number;
}

const round = (n: number, decimals = 4) => Number(n.toFixed(decimals));

async function measure(s: Scenario, iters: number): Promise<BenchResult> {
  await s.setup();

  // Warmup — JIT, prime the prepared-statement cache.
  for (let i = 0; i < 5; i++) {
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
  return {
    name: s.name,
    samples: samples.length,
    p50_ms: round(p50),
    p95_ms: round(p95),
    mean_ms: round(mean),
    ops_per_sec: opsPerSec,
    ...(s.batchSize ? { effective_per_sec: opsPerSec * s.batchSize } : {}),
  };
}

// ---------------------------------------------------------------------------
// Scenarios (act-pg minus notify — SQLite is single-node, no LISTEN/NOTIFY)
// ---------------------------------------------------------------------------

const meta = { correlation: "bench", causation: {} };
const incMsgs = (n: number) =>
  Array.from({ length: n }, () => ({ name: "Inc", data: {} }));

const COLD_FLOOR_EVENTS = 50; // events before the snapshot floor
const COLD_TAIL_EVENTS = 50; // events after the snapshot floor
const QS_STREAMS = 200; // streams seeded for query_stats pagination
const QS_PAGE = 50; // page size for the query_stats fetch

const scenarios: Scenario[] = [
  {
    // Single-event commit — the durable write hot path: one INSERT +
    // version bump inside a transaction (WAL append).
    name: "commit: single event",
    async setup() {
      await resetStore();
    },
    async run() {
      await store().commit(`single-${Math.random()}`, incMsgs(1), meta);
    },
  },
  {
    // Batched commit — 50 events in one transaction. Guards against a
    // per-event statement-prep regression in the multi-row INSERT path.
    name: "commit: 50-event batch",
    batchSize: 50,
    async setup() {
      await resetStore();
    },
    async run() {
      await store().commit(`batch-${Math.random()}`, incMsgs(50), meta);
    },
  },
  {
    // Cold load over a snapshot floor — the #1024 path. Seed N events,
    // commit a `__snapshot__`, seed M more events, clear the cache, then
    // load(). A correct adapter reads only the snapshot + the M tail
    // events (the floor), NOT all N+M.
    name: "load: cold replay over snapshot floor",
    async setup() {
      await resetStore();
      const stream = "cold-floor";
      await store().commit(stream, incMsgs(COLD_FLOOR_EVENTS), meta);
      await store().commit(
        stream,
        [{ name: SNAP_EVENT, data: { count: COLD_FLOOR_EVENTS } }],
        meta
      );
      await store().commit(stream, incMsgs(COLD_TAIL_EVENTS), meta);
    },
    async preIteration() {
      // Drop the cache so each iter replays from the store (cold).
      await cache().clear();
    },
    async run() {
      await app.load(Counter, "cold-floor");
    },
  },
  {
    // Drain throughput — commit a batch to a fresh source stream, then
    // correlate + drain to push every event through a no-op reaction.
    // Exercises claim(), the replay query, and ack().
    name: "drain: correlate+drain 50 events",
    batchSize: 50,
    async setup() {
      await resetStore();
    },
    async run() {
      const src = `drain-src-${Math.random()}`;
      await store().commit(src, incMsgs(50), meta);
      await app.correlate();
      await app.drain({ streamLimit: 100, eventLimit: 1000 });
    },
  },
  {
    // query_stats pagination — one page of 50 streams with count + names
    // (the full-scan tier). Guards the ROW_NUMBER window / CTE plan
    // against an accidental table scan as the streams table grows.
    name: "query_stats: page of 50 (count+names)",
    batchSize: QS_PAGE,
    async setup() {
      await resetStore();
      for (let i = 0; i < QS_STREAMS; i++) {
        await store().commit(
          `qs-${String(i).padStart(4, "0")}`,
          incMsgs(5),
          meta
        );
      }
    },
    async run() {
      await store().query_stats(
        { stream: "^qs-" },
        { count: true, names: true, limit: QS_PAGE }
      );
    },
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const counts: Record<string, number> = {
    "commit: single event": 200,
    "commit: 50-event batch": 100,
    "load: cold replay over snapshot floor": 100,
    "drain: correlate+drain 50 events": 50,
    "query_stats: page of 50 (count+names)": 50,
  };

  const results: BenchResult[] = [];
  for (const s of scenarios) {
    const iters = counts[s.name] ?? 100;
    process.stderr.write(`Running ${s.name} (${iters} iters)...\n`);
    results.push(await measure(s, iters));
  }
  await dispose()();
  unlinkDb();

  process.stdout.write(JSON.stringify({ results }, null, 2) + "\n");
}

void main();
