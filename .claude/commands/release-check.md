---
description: Run every pre-merge gate in parallel and report a punch-list
allowed-tools: Bash(pnpm:*), Bash(git:*), Bash(jq:*)
---

Verify the current branch is mergeable. Run **every gate in parallel** and surface a single consolidated report.

## Gates (run all in parallel)

1. **Typecheck** — `pnpm typecheck`. Must be clean.
2. **Tests + coverage** — `pnpm test`. Coverage **must** be 100% on every metric (statements / branches / functions / lines). Anything below is a fail.
3. **Lint** — `pnpm lint`. Warnings are fine; errors fail the gate.
4. **Build** — `pnpm build`. Must complete without TS errors.
5. **Charter-covered diff** — `git diff master --stat -- libs/act/src/builders/ libs/act/src/act.ts libs/act/src/types/ports.ts libs/act/src/types/index.ts libs/act/src/ports.ts`. If any file in that list changed, explicitly note "charter surface modified — categorize as additive/breaking before merging."

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

End with a one-line verdict: **READY TO MERGE** or **NOT READY: <reason>**.

## Conventions

- Run the four pnpm gates with `&` and `wait` for concurrency. Don't serialize.
- Use `coverage/coverage-summary.json` (vitest leaves it after `pnpm test`) for coverage percentages — `jq '.total'`.
- If the user wants a deeper drill on any failure, run the relevant package's targeted command (`pnpm -F <pkg> typecheck` etc.). Don't drill unprompted.
