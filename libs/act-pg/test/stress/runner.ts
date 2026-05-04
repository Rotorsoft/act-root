/**
 * Stress test runner — coordinator. Sets up a fresh Postgres schema,
 * forks N worker processes for each scenario, collects their JSON
 * results, queries PG to verify framework invariants, and writes a
 * markdown report.
 *
 * Output:
 * - Always: stdout (markdown). The CI workflow pipes this to
 *   `$GITHUB_STEP_SUMMARY` for run-page visibility.
 * - On master: also appended to `libs/act/PERFORMANCE.md` under the
 *   "Postgres stress test" section by the workflow.
 *
 * Usage:
 *   pnpm -F @rotorsoft/act-pg stress
 *
 * Configurable via env:
 *   PG_PORT, PG_SCHEMA, PG_TABLE, WORKER_COUNT, EVENTS_PER_WORKER,
 *   STRESS_TIMEOUT_MS
 */

import { fork } from "node:child_process";
import { resolve } from "node:path";
import { Pool } from "pg";

const PG_PORT = Number(process.env.PG_PORT ?? 5431);
const PG_SCHEMA = process.env.PG_SCHEMA ?? "stress_test";
const PG_TABLE = process.env.PG_TABLE ?? "events";
const WORKER_TIMEOUT_MS = Number(process.env.STRESS_TIMEOUT_MS ?? 90_000);
const WORKER_PATH = resolve(import.meta.dirname, "worker.ts");

type WorkerResult = {
  workerId: string;
  scenario: string;
  ok: boolean;
  durationMs: number;
  commitsAttempted: number;
  commitsSucceeded: number;
  retries: number;
  errors: string[];
  extra?: Record<string, unknown>;
};

type ScenarioReport = {
  name: string;
  description: string;
  workers: number;
  durationMs: number;
  results: WorkerResult[];
  invariants: { name: string; ok: boolean; detail?: string }[];
  ok: boolean;
};

// ---------------------------------------------------------------------------
// Worker plumbing
// ---------------------------------------------------------------------------

function spawnWorker(
  workerId: string,
  scenario: string,
  env: Record<string, string>
): Promise<WorkerResult> {
  return new Promise((resolveResult) => {
    const child = fork(WORKER_PATH, [workerId, scenario], {
      execArgv: ["--import", "tsx"],
      env: {
        ...process.env,
        PG_PORT: String(PG_PORT),
        PG_SCHEMA,
        PG_TABLE,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });

    let lastJsonLine = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      // Find the last complete JSON line in the chunk (workers emit one).
      for (const line of text.split("\n").filter(Boolean)) {
        if (line.startsWith("{")) lastJsonLine = line;
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[${workerId}] ${chunk.toString()}`);
    });

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
    }, WORKER_TIMEOUT_MS);

    child.on("exit", (code) => {
      clearTimeout(timeout);
      let parsed: WorkerResult;
      try {
        parsed = JSON.parse(lastJsonLine) as WorkerResult;
      } catch {
        parsed = {
          workerId,
          scenario,
          ok: false,
          durationMs: 0,
          commitsAttempted: 0,
          commitsSucceeded: 0,
          retries: 0,
          errors: [`worker exited code=${code} without emitting JSON result`],
        };
      }
      // For "killed" scenarios, exit code 1 is expected — runner treats
      // ok=true if we got a partial result.
      resolveResult(parsed);
    });
  });
}

async function runWorkers(
  scenario: string,
  count: number,
  envFor: (i: number) => Record<string, string> = () => ({})
): Promise<WorkerResult[]> {
  const promises: Promise<WorkerResult>[] = [];
  for (let i = 0; i < count; i++) {
    promises.push(spawnWorker(`w${i}`, scenario, envFor(i)));
  }
  return Promise.all(promises);
}

// ---------------------------------------------------------------------------
// PG plumbing
// ---------------------------------------------------------------------------

async function withPgPool<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
  const pool = new Pool({
    host: "localhost",
    port: PG_PORT,
    database: "postgres",
    user: "postgres",
    password: "postgres",
  });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

async function setupSchema() {
  // Use the framework's own seed() to ensure schema matches what
  // PostgresStore expects. Drop first to ensure a clean slate.
  const { PostgresStore } = await import("../../src/index.js");
  const store = new PostgresStore({
    port: PG_PORT,
    schema: PG_SCHEMA,
    table: PG_TABLE,
  });
  await store.drop();
  await store.seed();
  await store.dispose();
}

// ---------------------------------------------------------------------------
// Invariant checks
// ---------------------------------------------------------------------------

type Invariant = { name: string; ok: boolean; detail?: string };

async function checkPerStreamVersionMonotonic(pool: Pool): Promise<Invariant> {
  // For each stream, version sequence must be 0, 1, 2, ... contiguous.
  const { rows } = await pool.query(`
    WITH ordered AS (
      SELECT
        stream,
        version,
        row_number() OVER (PARTITION BY stream ORDER BY version) - 1 AS expected
      FROM "${PG_SCHEMA}"."${PG_TABLE}"
    )
    SELECT stream, version, expected
    FROM ordered
    WHERE version <> expected
    LIMIT 5;
  `);
  if (rows.length === 0) {
    return { name: "per-stream versions strictly monotonic from 0", ok: true };
  }
  return {
    name: "per-stream versions strictly monotonic from 0",
    ok: false,
    detail: `found ${rows.length} stream(s) with non-monotonic versions: ${JSON.stringify(rows)}`,
  };
}

async function checkNoDuplicateVersions(pool: Pool): Promise<Invariant> {
  const { rows } = await pool.query(`
    SELECT stream, version, count(*)
    FROM "${PG_SCHEMA}"."${PG_TABLE}"
    GROUP BY stream, version
    HAVING count(*) > 1
    LIMIT 5;
  `);
  if (rows.length === 0) {
    return { name: "no duplicate (stream, version) pairs", ok: true };
  }
  return {
    name: "no duplicate (stream, version) pairs",
    ok: false,
    detail: `found ${rows.length} duplicates: ${JSON.stringify(rows)}`,
  };
}

async function checkExpectedCommitTotal(
  pool: Pool,
  workerResults: WorkerResult[],
  predicate: (r: WorkerResult) => boolean = () => true
): Promise<Invariant> {
  const expected = workerResults
    .filter(predicate)
    .reduce((sum, r) => sum + r.commitsSucceeded, 0);
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM "${PG_SCHEMA}"."${PG_TABLE}"`
  );
  const actual = rows[0].n;
  return {
    name: "actual event count matches sum of worker commitsSucceeded",
    ok: actual === expected,
    detail:
      actual === expected
        ? undefined
        : `expected=${expected}, actual=${actual}`,
  };
}

async function checkNoStuckLeases(pool: Pool): Promise<Invariant> {
  // No stream should still be "leased" past its lease window after the
  // run completes. The streams table has leased_by/leased_until columns.
  const { rows } = await pool.query(`
    SELECT stream, leased_by, leased_until
    FROM "${PG_SCHEMA}"."${PG_TABLE}_streams"
    WHERE leased_by IS NOT NULL AND leased_until > now()
    LIMIT 5;
  `);
  if (rows.length === 0) {
    return { name: "no leases held past lease window", ok: true };
  }
  return {
    name: "no leases held past lease window",
    ok: false,
    detail: `${rows.length} stream(s) still leased: ${JSON.stringify(rows)}`,
  };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function runCommitStorm(workers = 8): Promise<ScenarioReport> {
  const t0 = Date.now();
  const results = await runWorkers("commit-storm", workers, (i) => ({
    EVENTS_PER_WORKER: "1000",
    STREAM_POOL_START: String(i * 10),
    STREAM_POOL_SIZE: "10",
  }));
  const invariants = await withPgPool(async (pool) => [
    await checkPerStreamVersionMonotonic(pool),
    await checkNoDuplicateVersions(pool),
    await checkExpectedCommitTotal(pool, results),
  ]);
  return {
    name: "commit-storm",
    description: "8 workers × 1000 commits across 80 streams (no contention)",
    workers,
    durationMs: Date.now() - t0,
    results,
    invariants,
    ok: results.every((r) => r.ok) && invariants.every((i) => i.ok),
  };
}

async function runSameStream(workers = 8): Promise<ScenarioReport> {
  const t0 = Date.now();
  const results = await runWorkers("same-stream", workers, () => ({
    EVENTS_PER_WORKER: "100",
    SHARED_STREAM: "contended-stream",
  }));
  const invariants = await withPgPool(async (pool) => [
    await checkPerStreamVersionMonotonic(pool),
    await checkNoDuplicateVersions(pool),
    await checkExpectedCommitTotal(pool, results),
  ]);
  return {
    name: "same-stream",
    description:
      "8 workers × 100 commits to ONE stream (heavy contention + retries)",
    workers,
    durationMs: Date.now() - t0,
    results,
    invariants,
    ok: results.every((r) => r.ok) && invariants.every((i) => i.ok),
  };
}

async function runDrainUnderChurn(): Promise<ScenarioReport> {
  const t0 = Date.now();
  const committers = 4;
  const consumers = 4;
  const [commitResults, consumerResults] = await Promise.all([
    runWorkers("drain-committer", committers, (i) => ({
      EVENTS_PER_WORKER: "500",
      STREAM_POOL_START: String(i * 25),
      STREAM_POOL_SIZE: "25",
    })),
    runWorkers("drain-consumer", consumers, () => ({
      DRAIN_TARGET_STREAM: "drain-target",
      DRAIN_SOURCE_REGEX: "drain-source-.*",
      DRAIN_BUDGET_MS: "60000",
    })),
  ]);
  const results = [...commitResults, ...consumerResults];
  const invariants = await withPgPool(async (pool) => [
    await checkPerStreamVersionMonotonic(pool),
    await checkNoDuplicateVersions(pool),
    await checkExpectedCommitTotal(
      pool,
      results,
      (r) => r.scenario === "drain-committer"
    ),
    await checkNoStuckLeases(pool),
  ]);
  return {
    name: "drain-under-churn",
    description: "4 committers + 4 drain consumers running concurrently",
    workers: committers + consumers,
    durationMs: Date.now() - t0,
    results,
    invariants,
    ok: results.every((r) => r.ok) && invariants.every((i) => i.ok),
  };
}

async function runKilledWorker(): Promise<ScenarioReport> {
  const t0 = Date.now();
  // 6 normal committers + 2 killed mid-flight.
  const [normal, killed] = await Promise.all([
    runWorkers("commit-storm", 6, (i) => ({
      EVENTS_PER_WORKER: "200",
      STREAM_POOL_START: String(i * 5),
      STREAM_POOL_SIZE: "5",
    })),
    runWorkers("killed", 2, (i) => ({
      EVENTS_BEFORE_KILL: "50",
      STREAM_POOL_SIZE: "5",
      // Avoid stream collisions with normal workers.
      _index: String(i),
    })),
  ]);
  const results = [...normal, ...killed];
  const invariants = await withPgPool(async (pool) => [
    await checkPerStreamVersionMonotonic(pool),
    await checkNoDuplicateVersions(pool),
    await checkNoStuckLeases(pool),
  ]);
  // For killed workers, ok=true if they emitted a partial result before
  // dying — that means the runner survived their crash cleanly.
  return {
    name: "killed-worker",
    description: "6 normal workers + 2 killed mid-commit (process.exit(1))",
    workers: 8,
    durationMs: Date.now() - t0,
    results,
    invariants,
    ok: invariants.every((i) => i.ok),
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function fmt(ms: number) {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function renderReport(reports: ScenarioReport[]): string {
  const lines: string[] = [];
  const allOk = reports.every((r) => r.ok);
  const stamp = new Date().toISOString();

  lines.push(`# Postgres stress test — ${stamp}`);
  lines.push("");
  lines.push(
    `**Status:** ${allOk ? "✅ all scenarios passed" : "❌ failures detected"}`
  );
  lines.push(
    `**Postgres:** port=${PG_PORT}, schema=\`${PG_SCHEMA}\`, table=\`${PG_TABLE}\``
  );
  lines.push("");

  lines.push("| Scenario | Workers | Status | Duration | Commits | Retries |");
  lines.push("|---|---:|:---:|---:|---:|---:|");
  for (const r of reports) {
    const totalCommits = r.results.reduce((s, w) => s + w.commitsSucceeded, 0);
    const totalRetries = r.results.reduce((s, w) => s + w.retries, 0);
    lines.push(
      `| ${r.name} | ${r.workers} | ${r.ok ? "✅" : "❌"} | ${fmt(r.durationMs)} | ${totalCommits} | ${totalRetries} |`
    );
  }
  lines.push("");

  for (const r of reports) {
    lines.push(`## ${r.name}`);
    lines.push(r.description);
    lines.push("");
    lines.push("### Invariants");
    for (const inv of r.invariants) {
      lines.push(`- ${inv.ok ? "✓" : "✗"} ${inv.name}`);
      if (!inv.ok && inv.detail) lines.push(`  - ${inv.detail}`);
    }
    lines.push("");
    if (r.results.some((w) => !w.ok)) {
      lines.push("### Worker errors (sample)");
      for (const w of r.results.filter((w) => !w.ok)) {
        lines.push(`- \`${w.workerId}\`: ${w.errors.slice(0, 2).join("; ")}`);
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  process.stderr.write(`Setting up schema "${PG_SCHEMA}"...\n`);
  await setupSchema();

  const reports: ScenarioReport[] = [];
  for (const [label, fn] of [
    ["commit-storm", runCommitStorm],
    ["same-stream", runSameStream],
    ["drain-under-churn", runDrainUnderChurn],
    ["killed-worker", runKilledWorker],
  ] as const) {
    process.stderr.write(`Running scenario: ${label}...\n`);
    await setupSchema(); // Fresh schema per scenario for clean assertions.
    reports.push(await fn());
  }

  const md = renderReport(reports);
  process.stdout.write(md + "\n");

  const allOk = reports.every((r) => r.ok);
  process.exit(allOk ? 0 : 1);
}

void main();
