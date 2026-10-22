---
description: Run the checks CI can't, then push and read CI's verdict
allowed-tools: Bash(pnpm:*), Bash(git:*), Bash(gh:*), Bash(jq:*), Bash(grep:*)
---

Verify the current branch is mergeable. CI (`ci-cd.yml` → `ci` job) runs typecheck, lint, the full tests with the 100% coverage threshold, the build, the stability snapshot and the repo checks (paths, contracts, doc snippets, browser safety, READMEs, CLI smoke tests). Docs PRs also run `docs-build.yml` (snippets and the site build). Don't re-run those locally. Run what CI can't decide, then push and read CI.

## Local steps

1. **Charter-covered diff.** Run `pnpm build`, then regenerate the stability snapshot (`pnpm check:stability -u`; it reads `dist/`, so the build comes first and biome must already have formatted the source), then `git diff master --stat -- test/__snapshots__/stability.spec.ts.snap`. The snapshot records the published declarations of every entry point and what they re-export, so an implementation-only change leaves it alone. If it changed, classify it (see below). Commit the regenerated snapshot: CI fails on a stale one.
2. **Doc-staleness audit.** Run the doc-grep recipe from CONTRIBUTING.md "Pre-handoff workflow → Doc audit":
   ```bash
   # Identify renamed/removed identifiers in this PR
   git diff master --diff-filter=D --name-only -- libs/act/src/ libs/act-*/src/
   # For each renamed/removed symbol, grep for it in docs
   grep -rln "<old-name-or-shape>" docs/docs CLAUDE.md libs/*/README.md
   ```
   When the PR migrates a callsite to a new primitive (e.g., `query` → `query_stats`), also grep for the old behavioral description in `docs/docs/architecture/` ASCII diagrams. Report hits — they must be updated in this PR, not a follow-up. Skip cleanly when this is a no-public-surface PR (deps bump, internal refactor).
3. **Lint** (`pnpm lint`) — it takes a second, and fixing a lint error before the push saves a CI round trip. CI runs it too.

## Then push and read CI

Push the branch (open the PR with `/pr` if there isn't one), then wait for every check on it: `gh pr checks <pr> --watch`. List each check by name with its result. A check that was skipped is fine only when its paths didn't change (the `ci` job skips a docs-only PR; `docs-build` runs only for `docs/**`). A missing check is not a pass: say which one is missing.

## Output

Print a single table:

| Step | Status | Notes |
|---|---|---|
| Charter | ✅ / ⚠ | "snapshot unchanged" / "additive" / "needs categorization" |
| Doc audit | ✅ / ⚠ | "clean" / "N stale refs in <files>" |
| Lint | ✅ / ❌ | error count |
| CI | ✅ / ❌ / ⏳ | each check by name: passed / failed / skipped / missing |

End with a one-line verdict: **READY TO MERGE** (every CI check passed or was rightly skipped) or **NOT READY: <reason>**.

## When CI fails on coverage

Coverage below 100% fails the `ci` job's test step. Read the uncovered-line table from its log (`gh run view <run> --log-failed`) as the punch-list, or reproduce one package locally (`npx vitest run libs/<pkg> --coverage`). Don't tolerate a gap as "defensive": write the fault-injection test or remove the branch. Patterns: pg defensive `rowCount ?? 0` branches in `libs/act-pg/test/store.error.spec.ts` (mock `pg.Pool.prototype.query` to return `{ rowCount: null }`); sqlite rollback paths in `libs/act-sqlite/test/store.error.spec.ts` (`mockClientFailOn(<failing SQL fragment>)`).

## When the snapshot changed

`git diff master -- test/__snapshots__/stability.spec.ts.snap` and classify every changed declaration (a change only to doc comments needs none):
- **Additive**: new optional method, field, exported type or event name; a widened input (`string[]` → `string[] | Filter`).
- **Breaking**: rename, removal, narrowed type, changed semantics, removed event name.

A breaking change needs a `BREAKING CHANGE:` footer, a migration note, and a `feat!`/`fix!` title. When ambiguous, ask the user; STABILITY.md is the reference.

## Conventions

- Don't run the full test suite locally to stand in for CI. To debug one failure, run the relevant package's targeted command (`npx vitest run libs/<pkg>`, `pnpm -F <pkg> typecheck`). Don't drill unprompted.
