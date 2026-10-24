# Contributing

The rules [CLAUDE.md](CLAUDE.md) states in one line each are spelled out here (the pre-handoff workflow) or in `.claude/rules/` (naming conventions and config-validation schemas), where Claude Code loads them while it writes code.

## Pre-handoff workflow

Branch work isn't done until `/release-check` passes cleanly and every CI check on the PR is green. Per-slice `pnpm test -F <pkg>` during development is fine; CI is the final gate. GitHub doesn't block merging a red PR, so read every check before merging.

Sequence at the end of a feature branch:

1. `/release-check` — regenerates and classifies the stability snapshot, runs the doc audit (step 3) and lint, then pushes and reads every CI check (typecheck, lint, tests with 100% coverage, build, stability and the repo checks). A coverage gap fails CI; write the fault-injection test or remove the branch (patterns in `libs/act-pg/test/store.error.spec.ts` / `libs/act-sqlite/test/store.error.spec.ts`). See [.claude/commands/release-check.md](.claude/commands/release-check.md).
2. **Learnings.** If the change taught something that `.claude/skills/simplify-core/learnings.md` doesn't already say, add one entry there: the rule in one line, then the ticket as evidence. Most PRs add nothing.
3. **Doc audit — any PR that changes a public surface, renames a method, migrates a callsite to a new primitive, or alters described semantics must update the relevant docs in the same PR.** This is the one copy of the audit; `/release-check` runs it from here. Find what was renamed or removed, then grep every place docs live for the old name or the old description:
   ```bash
   git diff master --diff-filter=D --name-only -- libs/act/src/ libs/act-*/src/
   grep -rln "<old-name-or-shape>" docs/docs docs/src/scenes docs/flows CLAUDE.md STABILITY.md \
     libs/*/README.md packages/*/README.md recipes .claude/skills .claude/rules
   ```
   Hits get fixed inline; **do not** leave them for a "follow-up PR." Skip the audit only for a PR with no described behavior (a dependency bump, an internal refactor). Specifically:
   - **Port changes** (`Store` / `Cache` / `Logger`) → check `docs/docs/architecture/extension-points.md` and the matching `docs/docs/guides/writing-a-{store,cache,logger}.md`. The method-list snippet in extension-points goes stale every time the interface gains, loses, or renames a method.
   - **Orchestrator / `Act` API changes** → check `docs/docs/concepts/` (especially `event-sourcing.md`, `error-handling.md`, `state-management.md`).
   - **Internal subsystem refactors** (close-cycle, drain, settle, correlate) → check the matching `docs/docs/architecture/` page. Pseudocode, Mermaid diagrams and the animated scenes in `docs/src/scenes/` often spell out the *old* shape ("Phase X: query backward, limit:1") — grep for the literal description, not just the method name.
   - **Lifecycle event additions/changes** → check `docs/docs/concepts/error-handling.md` and `docs/docs/guides/production-checklist.md`.
   - **Timing or outcome changes** (a retry, a debounce, a progress rule, a refusal) → check the animated scenes in `docs/src/scenes/`, the flow specs in `docs/flows/` and the skills that teach the behavior: they describe timing and outcomes, and nothing compiles them against the code.
   The pattern that catches this: the PR's commit message says "we changed X" — every place that *describes* X in the docs needs the same update. Treat the docs as part of the public surface.

   **A doc claim about runtime behavior ships with its test.** Any sentence in `docs/docs/**` or a public port/`Act` doc-comment that asserts a concrete runtime guarantee ("`with_snaps` resumes from the latest snapshot", "the cache is invalidated only on `ConcurrencyError`") must have a TCK or unit test that fails if the claim stops holding, and a row in the [behavior-contract checklist](docs/docs/architecture/behavior-contracts.md): a one-line claim, a link to the doc section that explains it, and the exact test names. No rationale or ticket numbers in the row. `pnpm check:contracts` (run in CI) fails when a cited test doesn't exist, so a test rename updates its row in the same PR.
4. Only then: announce "ready for review", show the diff summary, offer to open a PR via `/pr`.

A branch stacked on another PR's branch conflicts once that PR squash-merges. Merge master into it, and check that its diff against master is only its own change.

**Don't invent ad-hoc gates.** A local `pnpm typecheck` or a glance at `pnpm test` doesn't substitute for CI's result. Narrow to ad-hoc tooling only for targeted debugging mid-development.

Each step closes a failure mode that has actually shipped: per-slice test runs missed what the full gate catches, and PRs that changed described behavior left the docs describing the old shape.

## Changing a port interface

When you add, remove, or change a method on a port in `libs/act/src/types/ports.ts` (`Store`, `Cache`, `Logger`), update the matching `runStoreTck` / `runCacheTck` / `runLoggerTck` in `libs/act-tck/src/` in the same slice. The TCK is the executable contract; adapters validate themselves against it.

1. Add or update cases in `libs/act-tck/src/{store,cache,logger}-tck.ts`.
2. If the method is optional, add a flag to the matching `Capabilities` type and gate the new tests on it, so existing adapters keep passing until they opt in.
3. Update the `docs/docs/guides/writing-a-*.md` walkthrough for that port.
4. Run the TCK against every in-tree adapter: InMemory, act-pg, act-sqlite, act-notify (over Postgres) and act-pino.

Example: `Store.query_stats(input, options)` landed as a required method (every adapter implements it), and `store-tck.ts` gained its `describe("query_stats", …)` block in the same change.

## Naming conventions

Lives in [`.claude/rules/naming.md`](.claude/rules/naming.md), so Claude Code loads it whenever it reads or writes TypeScript under `libs/`, `packages/`, `recipes/` or `test/`. It is the one copy: edit it there.

## Config-validation schemas

Lives in [`.claude/rules/config-validation.md`](.claude/rules/config-validation.md), loaded whenever Claude Code touches a file under `libs/*/src/`. It is the one copy: edit it there.

## Performance Optimization Workflow

Pattern used for Act framework performance tickets. Follow this process when creating and implementing optimization issues.

### Phase 1: Analysis

1. Deep-read the current implementation — all relevant source files with line numbers
2. Identify the bottleneck with specific code paths and data flow
3. Name the pattern being applied (e.g., "competing consumers", "cursor-based processing")
4. Map existing mechanisms (watermarks, frontiers, caches) before proposing new ones
5. Understand why the current approach works before changing it

### Phase 2: Issue Creation

Each issue should include:

- **Problem** — current behavior with code references, impact at scale
- **Pattern** — named pattern with explanation (e.g., `FOR UPDATE SKIP LOCKED`, cursor-based processing)
- **Strategy** — implementation approach with interface changes, SQL, and code sketches
- **Benchmarking plan** — specific scenarios to measure, before/after methodology
- **Documentation tasks** — CLAUDE.md, READMEs, Docusaurus, skills, PERFORMANCE.md
- **Acceptance criteria** — checklist including tests, docs, and benchmark results

### Phase 3: Implementation

- Present plan and get confirmation before coding
- Use short names matching existing vocabulary (`claim`, `subscribe`, `max_at`)
- Classify behaviors at build time when possible (static vs dynamic resolvers)
- Reuse existing mechanisms (watermarks as checkpoints) before creating new ones
- Keep the Store interface minimal — fold implementation details into existing methods
- Run tests after every change

### Phase 4: Benchmarking

- Write benchmarks that exercise the **exact scenario** being fixed
- Separate benchmarks per optimization dimension when a ticket solves multiple problems
- Run on master code (checkout source, build, run) for real before/after comparison
- Run on feature branch with same benchmark for after numbers
- Report honestly — if numbers are within noise, say so and explain the architectural value

### Phase 5: Documentation

- **`libs/act/PERFORMANCE.md`** — detailed benchmark tables, pattern explanation, before/after comparison
- **`libs/act/README.md`** — current patterns only, link to PERFORMANCE.md for history
- **`docs/docs/architecture/extension-points.md`** — the Store contract, when the change touches it
- **Docusaurus** — concept pages with optimization notes
- **Scaffold skill** — update `act-api.md` as needed
- Verify Docusaurus build passes before PR

### Key Principles

- Understand existing mechanisms deeply before proposing new ones
- Don't add to the Store interface unless strictly necessary — fold into existing methods
- Benchmarks must show real improvement in the specific scenario being fixed
- Multiple optimizations in one ticket need multiple benchmarks
- Document the pattern, not just the code — explain why it works

## Dependency Updates

This repo uses **Renovate** for version updates and **Dependabot for security alerts only**. There is no `.github/dependabot.yml` — please don't open Dependabot version-update PRs; Renovate already handles them.

- **Direct deps** — Renovate opens PRs grouped by `Types packages` and `Dev dependencies`. Patch updates auto-merge; minor/major need review.
- **Lockfile maintenance** — runs weekly (Mon < 03:00 UTC) to refresh transitive resolutions.
- **Stuck transitive vulnerabilities** — when a transitive dep can't be lifted by Renovate (the parent hasn't released, or the resolution graph won't bump), pin it in the `overrides` block of `pnpm-workspace.yaml`. Use a version-range key so the override is scoped to the vulnerable range only.
- **Vulnerability alerts** — Dependabot security alerts are enabled. Triage promptly; fix via Renovate PR, manual `pnpm update`, or an `overrides` entry in `pnpm-workspace.yaml` depending on where the vuln sits in the tree.
