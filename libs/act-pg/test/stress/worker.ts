/**
 * Stress worker — child process spawned by `runner.ts`. Connects to the
 * shared Postgres instance, runs the assigned scenario, writes a JSON
 * result line to stdout on completion, exits with status 0 on success
 * and non-zero on uncaught failure.
 *
 * Invocation:
 *   tsx libs/act-pg/test/stress/worker.ts <workerId> <scenario>
 *
 * Scenarios:
 *   commit-storm      — commit N events across a pool of streams
 *   same-stream       — hammer one shared stream with retries
 *   drain-committer   — commit reactive events for `drain-under-churn`
 *   drain-consumer    — claim/handle/ack reactive events
 *   killed            — commit for a while, then process.exit(1)
 *
 * Config comes from env vars set by the runner — keeps the argv compact.
 *
 * @internal
 */

import { ConcurrencyError, dispose, type Schemas, store } from "@rotorsoft/act";
import { PostgresStore } from "../../src/index.js";

const PG_CONFIG = {
  port: Number(process.env.PG_PORT ?? 5431),
  schema: process.env.PG_SCHEMA ?? "stress_test",
  table: process.env.PG_TABLE ?? "events",
};

type WorkerResult = {
  workerId: string;
  scenario: string;
  ok: boolean;
  durationMs: number;
  commitsAttempted: number;
  commitsSucceeded: number;
  retries: number;
  errors: string[];
  // Scenario-specific extras.
  extra?: Record<string, unknown>;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function emitResult(r: WorkerResult): Promise<void> {
  // One line of JSON to stdout — runner parses on close. Wait for the
  // pipe to drain so process.exit doesn't race the flush.
  return new Promise((res) => {
    const ok = process.stdout.write(JSON.stringify(r) + "\n", () => res());
    if (!ok) process.stdout.once("drain", () => res());
  });
}

function setupStore(): void {
  store(new PostgresStore(PG_CONFIG));
  // Workers don't drop or seed — runner does that once before forking.
  // Workers also don't share an InMemoryCache; each process has its own
  // (matches production, where each Node process has its own).
}

// ---------------------------------------------------------------------------
// Scenario: commit-storm
// ---------------------------------------------------------------------------
// N workers commit M events across a fixed pool of streams. Streams are
// partitioned so workers don't collide on the same stream — the goal is
// to stress concurrent commits across many streams, not contention.
async function commitStorm(workerId: string): Promise<WorkerResult> {
  const eventsPerWorker = Number(process.env.EVENTS_PER_WORKER ?? 1000);
  const streamPoolStart = Number(process.env.STREAM_POOL_START ?? 0);
  const streamPoolSize = Number(process.env.STREAM_POOL_SIZE ?? 50);

  const t0 = Date.now();
  let committed = 0;
  const errors: string[] = [];

  for (let i = 0; i < eventsPerWorker; i++) {
    const streamIdx = streamPoolStart + (i % streamPoolSize);
    const stream = `storm-${streamIdx}`;
    try {
      await store().commit(
        stream,
        [{ name: "Inc", data: { workerId, seq: i } }],
        { correlation: workerId, causation: {} }
      );
      committed++;
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
      if (errors.length > 50) break; // bail fast if something is broken
    }
  }

  return {
    workerId,
    scenario: "commit-storm",
    ok: errors.length === 0,
    durationMs: Date.now() - t0,
    commitsAttempted: eventsPerWorker,
    commitsSucceeded: committed,
    retries: 0,
    errors: errors.slice(0, 5),
  };
}

// ---------------------------------------------------------------------------
// Scenario: same-stream contention
// ---------------------------------------------------------------------------
// All workers commit to ONE shared stream with retries. Asserts that
// optimistic concurrency forces serialization correctly: every commit
// eventually lands, no two events end up at the same version.
async function sameStream(workerId: string): Promise<WorkerResult> {
  const eventsPerWorker = Number(process.env.EVENTS_PER_WORKER ?? 100);
  const stream = process.env.SHARED_STREAM ?? "contended-stream";
  const maxRetries = 100;

  const t0 = Date.now();
  let committed = 0;
  let retries = 0;
  const errors: string[] = [];

  for (let i = 0; i < eventsPerWorker; i++) {
    let attempt = 0;
    let success = false;
    while (attempt < maxRetries && !success) {
      attempt++;
      try {
        // Read current head version, then commit with expectedVersion.
        const events: Array<{ version: number }> = [];
        await store().query((e) => events.push(e), {
          stream,
          stream_exact: true,
        });
        const expectedVersion =
          events.length > 0 ? events[events.length - 1].version : -1;
        await store().commit(
          stream,
          [{ name: "Inc", data: { workerId, seq: i } }],
          { correlation: workerId, causation: {} },
          expectedVersion
        );
        success = true;
        committed++;
      } catch (e) {
        if (e instanceof ConcurrencyError) {
          retries++;
          // Tiny jittered backoff to spread contention.
          await sleep(Math.random() * 5);
        } else {
          errors.push(e instanceof Error ? e.message : String(e));
          break;
        }
      }
    }
  }

  return {
    workerId,
    scenario: "same-stream",
    ok: errors.length === 0,
    durationMs: Date.now() - t0,
    commitsAttempted: eventsPerWorker,
    commitsSucceeded: committed,
    retries,
    errors: errors.slice(0, 5),
  };
}

// ---------------------------------------------------------------------------
// Scenario: drain-committer / drain-consumer
// ---------------------------------------------------------------------------
// Committer: writes events that should fire reactions on a known target.
// Consumer: claim/fetch/ack loop, simulating a reaction handler. Together
// they exercise the drain pipeline under concurrent commit pressure.
async function drainCommitter(workerId: string): Promise<WorkerResult> {
  const eventsPerWorker = Number(process.env.EVENTS_PER_WORKER ?? 500);
  const streamPoolStart = Number(process.env.STREAM_POOL_START ?? 0);
  const streamPoolSize = Number(process.env.STREAM_POOL_SIZE ?? 25);

  const t0 = Date.now();
  let committed = 0;
  const errors: string[] = [];

  for (let i = 0; i < eventsPerWorker; i++) {
    const streamIdx = streamPoolStart + (i % streamPoolSize);
    const stream = `drain-source-${streamIdx}`;
    try {
      await store().commit(
        stream,
        [{ name: "Inc", data: { workerId, seq: i } }],
        { correlation: workerId, causation: {} }
      );
      committed++;
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  return {
    workerId,
    scenario: "drain-committer",
    ok: errors.length === 0,
    durationMs: Date.now() - t0,
    commitsAttempted: eventsPerWorker,
    commitsSucceeded: committed,
    retries: 0,
    errors: errors.slice(0, 5),
  };
}

async function drainConsumer(workerId: string): Promise<WorkerResult> {
  const drainTargetStream = process.env.DRAIN_TARGET_STREAM ?? "drain-target";
  const drainTargetSource = process.env.DRAIN_SOURCE_REGEX ?? "drain-source-.*";
  const ttl_ms = Number(process.env.DRAIN_BUDGET_MS ?? 30_000);

  // Subscribe so the drain pipeline knows about us.
  await store().subscribe([
    { stream: drainTargetStream, source: drainTargetSource },
  ]);

  const t0 = Date.now();
  let totalAcked = 0;
  let totalEvents = 0;
  const seenEventIds = new Set<number>();

  while (Date.now() - t0 < ttl_ms) {
    const leases = await store().claim(5, 5, workerId, 5_000);
    if (!leases.length) {
      await sleep(100);
      continue;
    }
    for (const lease of leases) {
      const events: Array<{ id: number; version: number }> = [];
      await store().query<Schemas>((e) => events.push(e), {
        stream: lease.source,
        after: lease.at,
        limit: 50,
      });
      // Consumer "handler" — count events, check for duplicates.
      for (const e of events) {
        if (seenEventIds.has(e.id)) {
          totalEvents = -1; // signal duplicate via sentinel
          break;
        }
        seenEventIds.add(e.id);
        totalEvents++;
      }
      if (events.length > 0) {
        await store().ack([{ ...lease, at: events[events.length - 1].id }]);
        totalAcked++;
      } else {
        // Empty fetch — ack with the lease's at to release.
        await store().ack([lease]);
      }
    }
  }

  return {
    workerId,
    scenario: "drain-consumer",
    ok: totalEvents >= 0,
    durationMs: Date.now() - t0,
    commitsAttempted: 0,
    commitsSucceeded: 0,
    retries: 0,
    errors:
      totalEvents < 0 ? ["duplicate event delivered to drain consumer"] : [],
    extra: { totalAcked, totalEvents, uniqueIds: seenEventIds.size },
  };
}

// ---------------------------------------------------------------------------
// Scenario: killed worker
// ---------------------------------------------------------------------------
// Commits in a tight loop, then exits with code 1 mid-flight. Runner
// asserts that the work the killed worker WAS doing can be picked up by
// surviving workers (lease re-claim after window).
async function killed(workerId: string): Promise<never> {
  const eventsBeforeKill = Number(process.env.EVENTS_BEFORE_KILL ?? 100);
  const streamPoolSize = Number(process.env.STREAM_POOL_SIZE ?? 50);

  let committed = 0;
  for (let i = 0; i < eventsBeforeKill; i++) {
    const stream = `storm-${i % streamPoolSize}`;
    try {
      await store().commit(
        stream,
        [{ name: "Inc", data: { workerId, seq: i, willDie: true } }],
        { correlation: workerId, causation: {} }
      );
      committed++;
    } catch {
      // ignore, we're about to die anyway
    }
  }
  // Emit partial result then exit hard.
  await emitResult({
    workerId,
    scenario: "killed",
    ok: true,
    durationMs: 0,
    commitsAttempted: eventsBeforeKill,
    commitsSucceeded: committed,
    retries: 0,
    errors: [],
    extra: { died: true },
  });
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function main() {
  const [workerId, scenario] = process.argv.slice(2);
  if (!workerId || !scenario) {
    process.stderr.write("usage: worker.ts <workerId> <scenario>\n");
    process.exit(2);
  }

  setupStore();

  let result: WorkerResult;
  try {
    switch (scenario) {
      case "commit-storm":
        result = await commitStorm(workerId);
        break;
      case "same-stream":
        result = await sameStream(workerId);
        break;
      case "drain-committer":
        result = await drainCommitter(workerId);
        break;
      case "drain-consumer":
        result = await drainConsumer(workerId);
        break;
      case "killed":
        await killed(workerId); // never returns
        return;
      default:
        process.stderr.write(`unknown scenario: ${scenario}\n`);
        process.exit(2);
    }
  } catch (e) {
    result = {
      workerId,
      scenario,
      ok: false,
      durationMs: 0,
      commitsAttempted: 0,
      commitsSucceeded: 0,
      retries: 0,
      errors: [e instanceof Error ? e.message : String(e)],
    };
  } finally {
    await dispose()();
  }

  await emitResult(result);
  process.exit(result.ok ? 0 : 1);
}

void main();
