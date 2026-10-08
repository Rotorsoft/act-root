---
description: Run every pre-merge gate in parallel and report a punch-list
allowed-tools: Bash(pnpm:*), Bash(git:*), Bash(jq:*), Bash(grep:*)
---

Verify the current branch is mergeable. Run **every gate in parallel** and surface a single consolidated report.

## Gates (run all in parallel)

1. **Typecheck** — `pnpm typecheck`. Must be clean.
2. **Tests + coverage** — `pnpm test`. Coverage **must** be 100% on every metric (statements / branches / functions / lines). Anything below is a fail.
3. **Lint** — `pnpm lint`. Warnings are fine; errors fail the gate.
4. **Build** — `pnpm build`. Must complete without TS errors.
5. **Charter-covered diff** — `git diff master --stat -- libs/act/src/builders/ libs/act/src/act.ts libs/act/src/types/ports.ts libs/act/src/types/index.ts libs/act/src/ports.ts`. If any file in that list changed, explicitly note "charter surface modified — categorize as additive/breaking before merging."
6. **Doc-staleness audit** — run the doc-grep recipe from CLAUDE.md "Pre-handoff workflow → Doc audit":
   ```bash
   # Identify renamed/removed identifiers in this PR
   git diff master --diff-filter=D --name-only -- libs/act/src/ libs/act-*/src/
   # For each renamed/removed symbol, grep for it in docs
   grep -rln "<old-name-or-shape>" docs/docs CLAUDE.md libs/*/README.md
   ```
   When the PR migrates a callsite to a new primitive (e.g., `query` → `query_stats`), also grep for the old behavioral description in `docs/docs/architecture/` ASCII diagrams. Report hits — they must be updated in this PR, not a follow-up. Skip cleanly when this is a no-public-surface PR (deps bump, internal refactor).

## Output

Print a single table:

| Gate | Status | Notes |
|---|---|---|
| Typecheck | ✅ / ❌ | first error line if failing |
| Tests | ✅ / ❌ | passing count / total |
| Coverage | ✅ / ❌ | statements/branches/funcs/lines % |
| Lint | ✅ / ❌ | error count |
| Build | ✅ / ❌ | failing package if any |
| Charter | ✅ / ⚠ | "additive" / "needs categorization" / "no charter files changed" |
| Doc audit | ✅ / ⚠ | "clean" / "N stale refs in <files>" |

End with a one-line verdict: **READY TO MERGE** or **NOT READY: <reason>**.

## When coverage is below 100%

Print the uncovered-line table (`pnpm test 2>&1 | sed -n '/Uncovered Line/,/Coverage summary/p'`) as the punch-list. Don't tolerate a gap as "defensive": write the fault-injection test or remove the branch. Patterns: pg defensive `rowCount ?? 0` branches in `libs/act-pg/test/store.error.spec.ts` (mock `pg.Pool.prototype.query` to return `{ rowCount: null }`); sqlite rollback paths in `libs/act-sqlite/test/store.error.spec.ts` (`mockClientFailOn(<failing SQL fragment>)`).

## When charter files changed

For each touched charter file, `git diff master -- <file>` and classify every change:
- **Additive**: new optional method, field, exported type or event name; a widened input (`string[]` → `string[] | Filter`).
- **Breaking**: rename, removal, narrowed type, changed semantics, removed event name.

A breaking change needs a `BREAKING CHANGE:` footer, a migration note, and a `feat!`/`fix!` title. When ambiguous, ask the user; STABILITY.md is the reference.

## Conventions

- Run the four pnpm gates with `&` and `wait` for concurrency. Don't serialize.
- Use `coverage/coverage-summary.json` (vitest leaves it after `pnpm test`) for coverage percentages — `jq '.total'`.
- If the user wants a deeper drill on any failure, run the relevant package's targeted command (`pnpm -F <pkg> typecheck` etc.). Don't drill unprompted.
