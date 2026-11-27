#!/usr/bin/env node
/**
 * The adapter perf gate: compares a package's `perf-result.json` (from its
 * `bench:run`) with its `perf-baseline.json` and fails when a scenario's p50
 * rises past the tolerance, or when a baseline scenario is missing from the
 * result (the bench stopped early).
 *
 * Usage, from the package directory (as `pnpm -F <pkg> bench:check` runs it):
 *   node ../../scripts/perf-check.mjs <label> <tolerance>
 *
 * Tolerance is per adapter: Postgres runs 2.0, because a real database over
 * docker adds pool scheduling, autovacuum and page-cache jitter; SQLite runs
 * 1.5, because an embedded store has no network or pool. Either still catches
 * an order-of-magnitude regression (a lost index, a reintroduced N+1).
 *
 * A baseline p50 under 1 ms is reported but never fails: on a real store a
 * 0.3 → 0.7 ms swing is a 2.3× ratio that means nothing, and cheap indexed
 * reads land there. A scenario in the result but not in the baseline is NEW
 * and passes. The baselines come from the CI runner (`perf-baseline.yml`).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const [label, tolerance_arg] = process.argv.slice(2);
const TOLERANCE = Number(tolerance_arg);
if (!label || !(TOLERANCE > 0)) {
  console.error("usage: perf-check.mjs <label> <tolerance>");
  process.exit(2);
}
const FLOOR_MS = 1.0;

const read = (file) => JSON.parse(readFileSync(resolve(file), "utf8"));
const baseline = read("perf-baseline.json");
const result = read("perf-result.json");

let failed = false;
console.log(
  `Perf check — ${label} (tolerance: p50 ≤ ${TOLERANCE.toFixed(1)}× baseline, ` +
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

const row = (name, base, current, ratio, status) =>
  console.log(
    name.padEnd(42) +
      base.padStart(14) +
      current.padStart(14) +
      ratio.padStart(10) +
      `  ${status}`
  );

for (const r of result.results) {
  const b = baseline.results.find((x) => x.name === r.name);
  const current = r.p50_ms.toFixed(3);
  if (!b) {
    row(r.name, "—", current, "—", "NEW");
    continue;
  }
  const ratio = r.p50_ms / b.p50_ms;
  const shown = `${ratio.toFixed(2)}×`;
  if (b.p50_ms < FLOOR_MS) {
    row(r.name, b.p50_ms.toFixed(3), current, shown, "FLOOR (skipped)");
    continue;
  }
  const ok = ratio <= TOLERANCE;
  if (!ok) failed = true;
  row(r.name, b.p50_ms.toFixed(3), current, shown, ok ? "OK" : "REGRESSION");
}

// A scenario the bench didn't report means it stopped early.
for (const b of baseline.results)
  if (!result.results.some((r) => r.name === b.name)) {
    failed = true;
    console.log(`${b.name.padEnd(42)}  MISSING (the bench stopped before it)`);
  }

console.log();
if (failed) {
  console.error(
    `Perf check failed on ${label}: a scenario is MISSING (the bench stopped; its\n` +
      "error is above) or a REGRESSION. Fix the bench or the regression, or —\n" +
      "if the slowdown is intentional — refresh the baseline in a PR labeled\n" +
      "`perf-baseline-update` and document the rationale in PERFORMANCE.md."
  );
  process.exit(1);
}
console.log("All scenarios within tolerance.");
