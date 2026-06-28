/**
 * Compares a fresh act-sqlite perf-bench result against the checked-in
 * baseline. Exits non-zero if any scenario's p50 regresses past
 * `TOLERANCE` × the baseline p50.
 *
 * Differences from the core `libs/act/scripts/perf-check.ts`:
 *
 *   - **TOLERANCE = 1.5** — the same budget as the core InMemory gate.
 *     Embedded SQLite has no network and no connection pool, so its
 *     noise band is far tighter than act-pg's; a 1.5× budget catches
 *     real regressions without the 2.0× headroom Postgres needs.
 *
 *   - **FLOOR_MS = 1.0** absolute floor. Sub-millisecond baseline p50s
 *     are noise-dominated even on an embedded store — a 0.2 ms → 0.5 ms
 *     swing is a 2.5× ratio that means nothing. Any scenario whose
 *     **baseline** p50 is below the floor is reported but never fails
 *     the gate. The core act gate lacks this floor; the adapter gate
 *     adds it because cheap single-row commits genuinely land under 1 ms
 *     on a warm WAL.
 *
 * Scenarios present in the result but absent from the baseline are
 * treated as NEW and pass — identical to the core gate.
 *
 * Usage:
 *   pnpm -F @rotorsoft/act-sqlite bench:run
 *   pnpm -F @rotorsoft/act-sqlite bench:check
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

const TOLERANCE = 1.5; // p50 may rise to 1.5× baseline before failing
const FLOOR_MS = 1.0; // skip the ratio check when baseline p50 < 1.0 ms

// Paths are relative to libs/act-sqlite/ (cwd when invoked via
// `pnpm -F @rotorsoft/act-sqlite bench:check`).
const here = resolve(import.meta.dirname, "..");
const baseline = JSON.parse(
  readFileSync(resolve(here, "perf-baseline.json"), "utf8")
) as Report;
const result = JSON.parse(
  readFileSync(resolve(here, "perf-result.json"), "utf8")
) as Report;

let failed = false;
console.log(
  `Perf check — act-sqlite (tolerance: p50 ≤ ${TOLERANCE.toFixed(1)}× baseline, ` +
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
    "Perf regression detected on act-sqlite. Either fix the regression, or —\n" +
      "if the slowdown is intentional — refresh the baseline in a PR labeled\n" +
      "`perf-baseline-update` and document the rationale in PERFORMANCE.md."
  );
  process.exit(1);
}
console.log("All scenarios within tolerance.");
