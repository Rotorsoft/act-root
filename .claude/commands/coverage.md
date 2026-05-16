---
description: Run tests and verify coverage stays at 100% across every metric
allowed-tools: Bash(pnpm:*), Bash(jq:*), Bash(cat:*)
---

Run `pnpm test` and report **only** whether coverage stayed at 100% on every metric. Surface uncovered lines if any.

## Steps

1. Run `pnpm test`.
2. After it completes, read `coverage/coverage-summary.json`.
3. Pull the four numbers via `jq`:
   ```
   jq '.total | "stmts \(.statements.pct)% / branches \(.branches.pct)% / funcs \(.functions.pct)% / lines \(.lines.pct)%"' coverage/coverage-summary.json
   ```
4. If **all four** are exactly `100`, print `✅ coverage 100/100/100/100`.
5. Otherwise:
   - Print the failing metric and percentage.
   - Run `pnpm test 2>&1 | sed -n '/Uncovered Line/,/Coverage summary/p'` and print the uncovered-line table — that's the punch-list of branches to cover.
   - End with: "Coverage below 100% — gate the merge until covered. Don't ship a 99.95% PR."

## Conventions

- Don't suggest tolerating <100% with a comment like "the branch is defensive." The user's rule (from `feedback_full_coverage.md`) is no exceptions. Either write the fault-injection test or restructure the code to remove the branch.
- For pg defensive `rowCount ?? 0` branches, the canonical test pattern lives in `libs/act-pg/test/store.error.spec.ts` (mock `pg.Pool.prototype.query` to return `{ rowCount: null }`).
- For sqlite rollback paths, the pattern lives in `libs/act-sqlite/test/store.error.spec.ts` (`mockClientFailOn(<failing SQL fragment>)`).
