/**
 * Perf regression bench for `@rotorsoft/act-pg`. Measures a small, stable
 * set of hot-path scenarios against a **real PostgreSQL** instance (the
 * docker service on port 5431 that the act-pg test suite already uses)
 * and writes a JSON report. The companion script `perf-check.ts` compares
 * the report to `perf-baseline.json` and exits non-zero on a budgeted
 * regression.
 *
 * Mirrors `libs/act/scripts/perf-bench.ts` exactly in shape — same
 * `Scenario`/`BenchResult` types, same warmup + percentile math — so the
 * two harnesses stay legible side by side. The difference is the store
 * under test: this one runs on the real planner, real indexes, and real
 * network round-trips, which is where adapter-level regressions (a lost
 * index, an accidental N+1 query, a snapshot-floor read that scans the
 * whole stream) actually show up. InMemory can never surface those.
 *
 * Why a plain Node script instead of vitest bench: see the sibling note
 * in `libs/act/scripts/perf-bench.ts`. Same reasoning.
 *
 * Requires a running Postgres on `localhost:5431` (user/password/database
 * all `postgres`) — the docker service CI already provides. With no DB
 * reachable the script throws on the first `seed()`; that's intentional,
 * the gate is a real-adapter gate.
 *
 * Usage:
 *   pnpm -F @rotorsoft/act-pg bench:run    # writes perf-result.json
 *   pnpm -F @rotorsoft/act-pg bench:check  # compares to baseline
 *
 * To refresh the baseline (in a PR labeled `perf-baseline-update`):
 *   pnpm -F @rotorsoft/act-pg bench:update # writes perf-baseline.json
 */

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
import { PostgresStore } from "../src/postgres-store.js";

const PORT = 5431;
const SCHEMA = "perf_bench";
const TABLE = "events";

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

const newStore = () =>
  new PostgresStore({ port: PORT, schema: SCHEMA, table: TABLE });

const resetStore = async () => {
  await dispose()();
  store(newStore());
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
  /** Once after timed iterations (e.g., dispose ad-hoc stores). */
  readonly teardown?: () => Promise<void>;
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

  // Warmup — JIT, prepare statements, warm the connection pool.
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

  if (s.teardown) await s.teardown();

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
// Scenarios
// ---------------------------------------------------------------------------

const meta = { correlation: "bench", causation: {} };
const incMsgs = (n: number) =>
  Array.from({ length: n }, () => ({ name: "Inc", data: {} }));

const COLD_FLOOR_EVENTS = 50; // events before the snapshot floor
const COLD_TAIL_EVENTS = 50; // events after the snapshot floor
const QS_STREAMS = 200; // streams seeded for query_stats pagination
const QS_PAGE = 50; // page size for the query_stats fetch
const NOTIFY_COMMITS = 1; // events per notify run (one round-trip)

const scenarios: Scenario[] = [
  {
    // Single-event commit — the durable write hot path: one INSERT +
    // version bump + (notify) inside a transaction, one round-trip.
    name: "commit: single event",
    async setup() {
      await resetStore();
    },
    async run() {
      await store().commit(`single-${Math.random()}`, incMsgs(1), meta);
    },
  },
  {
    // Batched commit — 50 events in one transaction. Answers "how cheap
    // is a fat append" and guards against a per-event round-trip
    // regression in the multi-row INSERT path.
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
    // events (the floor), NOT all N+M. A regression that scans the whole
    // stream shows up as p50 climbing with N on the real planner.
    name: "load: cold replay over snapshot floor",
    async setup() {
      await resetStore();
      const stream = "cold-floor";
      await store().commit(stream, incMsgs(COLD_FLOOR_EVENTS), meta);
      // Seed a snapshot at the floor so cold load reads from here, not 0.
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
    // Exercises claim() (FOR UPDATE SKIP LOCKED), the replay query, and
    // ack() — the competing-consumer hot loop.
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
    // (the full-scan tier). Guards the DISTINCT ON / CTE plan against an
    // accidental sequential scan as the streams table grows.
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
  {
    // notify latency — cross-process commit→notification round-trip via
    // LISTEN/NOTIFY. A reader store subscribes; a separate writer store
    // (simulating another process) commits; we time until the reader's
    // handler fires for that correlation.
    name: "notify: commit→listener latency",
    batchSize: NOTIFY_COMMITS,
    setup: notifySetup,
    run: notifyRun,
    teardown: notifyTeardown,
  },
];

// ---------------------------------------------------------------------------
// notify scenario state (kept in module scope so setup/run/teardown share)
// ---------------------------------------------------------------------------

let notifyReader: PostgresStore | undefined;
let notifyWriter: PostgresStore | undefined;
let notifyDisposer: (() => void | Promise<void>) | undefined;
let notifyResolve: (() => void) | null = null;
let notifySeq = 0;

async function notifySetup() {
  notifyReader = new PostgresStore({
    port: PORT,
    schema: SCHEMA,
    table: TABLE,
    notify: true,
  });
  await notifyReader.drop();
  await notifyReader.seed();
  notifyWriter = new PostgresStore({
    port: PORT,
    schema: SCHEMA,
    table: TABLE,
    notify: true,
  });
  // notify is capability-gated; on a store without it the scenario can't
  // run — surface that loudly rather than silently reporting 0ms.
  if (!notifyReader.notify)
    throw new Error("PostgresStore.notify unavailable — cannot bench notify");
  // Iterations are strictly sequential (one commit, one wait), so at most one
  // waiter is ever in flight. Resolve it on the next delivery. (The payload
  // only carries id+name, not stream, so we can't match a specific event — but
  // single-in-flight makes that unnecessary.)
  const disposer = await notifyReader.notify(() => {
    const resolve = notifyResolve;
    if (resolve) {
      notifyResolve = null;
      resolve();
    }
  });
  notifyDisposer = disposer;
}

async function notifyRun() {
  const stream = `notify-${notifySeq++}`;
  // Register the waiter BEFORE committing so a fast NOTIFY can't be missed, and
  // time-bound it so a dropped notification fails loudly instead of hanging the
  // whole bench (the original unbounded wait stalled CI for 40+ minutes).
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      notifyResolve = null;
      reject(new Error("notify: no delivery within 10s"));
    }, 10_000);
    notifyResolve = () => {
      clearTimeout(timer);
      resolve();
    };
    notifyWriter!.commit(stream, incMsgs(1), meta).catch((err) => {
      clearTimeout(timer);
      notifyResolve = null;
      reject(err);
    });
  });
}

async function notifyTeardown() {
  if (notifyDisposer) await notifyDisposer();
  await notifyReader?.dispose();
  await notifyWriter?.dispose();
  notifyReader = notifyWriter = notifyDisposer = undefined;
  notifyResolve = null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Iteration counts tuned to keep total wall time reasonable on a real
  // DB (network round-trips dominate, so far fewer iters than InMemory).
  const counts: Record<string, number> = {
    "commit: single event": 100,
    "commit: 50-event batch": 50,
    "load: cold replay over snapshot floor": 50,
    "drain: correlate+drain 50 events": 30,
    "query_stats: page of 50 (count+names)": 30,
    "notify: commit→listener latency": 30,
  };

  const results: BenchResult[] = [];
  for (const s of scenarios) {
    const iters = counts[s.name] ?? 50;
    process.stderr.write(`Running ${s.name} (${iters} iters)...\n`);
    results.push(await measure(s, iters));
  }
  await dispose()();

  process.stdout.write(JSON.stringify({ results }, null, 2) + "\n");
}

void main();
