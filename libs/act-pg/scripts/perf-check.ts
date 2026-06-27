/**
 * Compares a fresh act-pg perf-bench result against the checked-in
 * baseline. Exits non-zero if any scenario's p50 regresses past
 * `TOLERANCE` × the baseline p50.
 *
 * Differences from the core `libs/act/scripts/perf-check.ts`:
 *
 *   - **TOLERANCE = 2.0** (vs 1.5 for the InMemory gate). A real
 *     Postgres over docker has a wider noise band than the in-process
 *     store — connection-pool scheduling, autovacuum, OS page cache, and
 *     CI neighbours all add jitter that the InMemory path never sees. A
 *     2.0× budget still catches an order-of-magnitude regression (a lost
 *     index, a reintroduced N+1) without flapping on runner noise.
 *
 *   - **FLOOR_MS = 1.0** absolute floor. Sub-millisecond baseline p50s
 *     are noise-dominated on a real DB — a 0.3 ms → 0.7 ms swing is a
 *     2.3× ratio that means nothing. Any scenario whose **baseline** p50
 *     is below the floor is reported but never fails the gate. The core
 *     act gate lacks this floor because its scenarios are all comfortably
 *     above 1 ms; the adapter gate adds it because cheap indexed lookups
 *     (e.g. a warm single-row read) genuinely land under 1 ms.
 *
 * Scenarios present in the result but absent from the baseline are
 * treated as NEW and pass — identical to the core gate. This is what
 * lets the pg baseline ship empty (`{"results":[]}`): until CI or a
 * maintainer with a local docker pg runs `bench:update`, every scenario
 * is "new" and the gate is a no-op. Once the baseline is populated the
 * budget engages.
 *
 * Usage:
 *   pnpm -F @rotorsoft/act-pg bench:run
 *   pnpm -F @rotorsoft/act-pg bench:check
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface Result {
  readonly name: string;
  readonly samples: number;
  readonly p50_ms: number;
  readonly p95_ms: number;
  readonly mean_ms: number;
  readonly ops_per_sec: number;
}

interface Report {
  readonly results: Result[];
}

const TOLERANCE = 2.0; // p50 may rise to 2.0× baseline before failing
const FLOOR_MS = 1.0; // skip the ratio check when baseline p50 < 1.0 ms

// Paths are relative to libs/act-pg/ (cwd when invoked via
// `pnpm -F @rotorsoft/act-pg bench:check`).
const here = resolve(import.meta.dirname, "..");
const baseline = JSON.parse(
  readFileSync(resolve(here, "perf-baseline.json"), "utf8")
) as Report;
const result = JSON.parse(
  readFileSync(resolve(here, "perf-result.json"), "utf8")
) as Report;

let failed = false;
console.log(
  `Perf check — act-pg (tolerance: p50 ≤ ${TOLERANCE.toFixed(1)}× baseline, ` +
    `floor: skip < ${FLOOR_MS.toFixed(1)}ms)\n`
);
console.log(
  "scenario".padEnd(42) +
    "baseline_p50".padStart(14) +
    "current_p50".padStart(14) +
    "ratio".padStart(10) +
    "  status"
);
console.log("-".repeat(89));

for (const r of result.results) {
  const b = baseline.results.find((x) => x.name === r.name);
  if (!b) {
    console.log(
      r.name.padEnd(42) +
        "—".padStart(14) +
        r.p50_ms.toFixed(3).padStart(14) +
        "—".padStart(10) +
        "  NEW"
    );
    continue;
  }
  // Absolute floor: sub-ms baselines are noise; report but never fail.
  if (b.p50_ms < FLOOR_MS) {
    console.log(
      r.name.padEnd(42) +
        b.p50_ms.toFixed(3).padStart(14) +
        r.p50_ms.toFixed(3).padStart(14) +
        `${(r.p50_ms / b.p50_ms).toFixed(2)}×`.padStart(10) +
        "  FLOOR (skipped)"
    );
    continue;
  }
  const ratio = r.p50_ms / b.p50_ms;
  const ok = ratio <= TOLERANCE;
  if (!ok) failed = true;
  console.log(
    r.name.padEnd(42) +
      b.p50_ms.toFixed(3).padStart(14) +
      r.p50_ms.toFixed(3).padStart(14) +
      `${ratio.toFixed(2)}×`.padStart(10) +
      `  ${ok ? "OK" : "REGRESSION"}`
  );
}

console.log();
if (failed) {
  console.error(
    "Perf regression detected on act-pg. Either fix the regression, or —\n" +
      "if the slowdown is intentional — refresh the baseline in a PR labeled\n" +
      "`perf-baseline-update` and document the rationale in PERFORMANCE.md."
  );
  process.exit(1);
}
console.log("All scenarios within tolerance.");
