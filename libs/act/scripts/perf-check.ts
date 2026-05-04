/**
 * Compares a fresh perf-bench result against the checked-in baseline.
 * Exits non-zero if any scenario's p50 regresses past `TOLERANCE` × the
 * baseline. Tolerance is generous enough to absorb CI runner noise but
 * tight enough to catch genuine regressions (e.g., accidentally
 * restoring an O(N²) hot path).
 *
 * Usage:
 *   pnpm tsx libs/act/scripts/perf-bench.ts > libs/act/perf-result.json
 *   pnpm tsx libs/act/scripts/perf-check.ts
 *
 * To refresh the baseline (in a labeled PR):
 *   pnpm tsx libs/act/scripts/perf-bench.ts > libs/act/perf-baseline.json
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

// Paths are relative to libs/act/ (cwd when invoked via
// `pnpm -F @rotorsoft/act bench:check`).
const here = resolve(import.meta.dirname, "..");
const baseline = JSON.parse(
  readFileSync(resolve(here, "perf-baseline.json"), "utf8")
) as Report;
const result = JSON.parse(
  readFileSync(resolve(here, "perf-result.json"), "utf8")
) as Report;

let failed = false;
console.log(
  `Perf check (tolerance: p50 ≤ ${TOLERANCE.toFixed(1)}× baseline)\n`
);
console.log(
  "scenario".padEnd(40) +
    "baseline_p50".padStart(14) +
    "current_p50".padStart(14) +
    "ratio".padStart(10) +
    "  status"
);
console.log("-".repeat(85));

for (const r of result.results) {
  const b = baseline.results.find((x) => x.name === r.name);
  if (!b) {
    console.log(
      r.name.padEnd(40) +
        "—".padStart(14) +
        r.p50_ms.toFixed(3).padStart(14) +
        "—".padStart(10) +
        "  NEW"
    );
    continue;
  }
  const ratio = r.p50_ms / b.p50_ms;
  const ok = ratio <= TOLERANCE;
  if (!ok) failed = true;
  console.log(
    r.name.padEnd(40) +
      b.p50_ms.toFixed(3).padStart(14) +
      r.p50_ms.toFixed(3).padStart(14) +
      `${ratio.toFixed(2)}×`.padStart(10) +
      `  ${ok ? "OK" : "REGRESSION"}`
  );
}

console.log();
if (failed) {
  console.error(
    "Perf regression detected. Either fix the regression, or — if the\n" +
      "slowdown is intentional — refresh the baseline in a PR labeled\n" +
      "`perf-baseline-update` and document the rationale in PERFORMANCE.md."
  );
  process.exit(1);
}
console.log("All scenarios within tolerance.");
