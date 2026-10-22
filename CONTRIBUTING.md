# Contributing

The rules [CLAUDE.md](CLAUDE.md) states in one line each are spelled out here (the pre-handoff workflow) or in `.claude/rules/` (naming conventions and config-validation schemas), where Claude Code loads them while it writes code.

## Pre-handoff workflow

Branch work isn't done until `/release-check` passes cleanly. Per-slice `pnpm test -F <pkg>` during development is fine; the final gate is **not optional**.

Sequence at the end of a feature branch:

1. `/release-check` — runs typecheck + tests + 100% coverage + lint + build + charter-diff in parallel. See [.claude/commands/release-check.md](.claude/commands/release-check.md).
2. If coverage < 100% on any metric: `/release-check` prints the uncovered lines; write the fault-injection test or restructure the code to remove the branch. See the patterns in `libs/act-pg/test/store.error.spec.ts` / `libs/act-sqlite/test/store.error.spec.ts`.
3. **Learnings.** If the change taught something that `.claude/skills/simplify-core/learnings.md` doesn't already say, add one entry there: the rule in one line, then the ticket as evidence. Most PRs add nothing.
4. **Doc audit — any PR that changes a public surface, renames a method, migrates a callsite to a new primitive, or alters described semantics must update the relevant docs in the same PR.** Run the stale-reference grep:
   ```bash
   grep -rln "<old-name-or-shape>" docs/docs CLAUDE.md STABILITY.md libs/*/README.md
   ```
   Hits get fixed inline; **do not** leave them for a "follow-up PR." Specifically:
   - **Port changes** (`Store` / `Cache` / `Logger`) → check `docs/docs/architecture/extension-points.md` and the matching `docs/docs/guides/writing-a-{store,cache,logger}.md`. The method-list snippet in extension-points goes stale every time the interface gains, loses, or renames a method.
   - **Orchestrator / `Act` API changes** → check `docs/docs/concepts/` (especially `event-sourcing.md`, `error-handling.md`, `state-management.md`).
   - **Internal subsystem refactors** (close-cycle, drain, settle, correlate) → check the matching `docs/docs/architecture/` page. Pseudocode and ASCII pipeline diagrams there often spell out the *old* shape ("Phase X: query backward, limit:1") — grep for the literal description, not just the method name.
   - **Lifecycle event additions/changes** → check `docs/docs/concepts/error-handling.md` and `docs/docs/guides/production-checklist.md`.
   The pattern that catches this: the PR's commit message says "we changed X" — every place that *describes* X in the docs needs the same update. Treat the docs as part of the public surface.

   **A doc claim about runtime behavior ships with its test.** Any sentence in `docs/docs/**` or a public port/`Act` doc-comment that asserts a concrete runtime guarantee ("`with_snaps` resumes from the latest snapshot", "the cache is invalidated only on `ConcurrencyError`") must have a TCK or unit test that fails if the claim stops holding, and a row in the [behavior-contract checklist](docs/docs/architecture/behavior-contracts.md): a one-line claim, a link to the doc section that explains it, and the exact test names. No rationale or ticket numbers in the row. `pnpm check:contracts` (run in CI) fails when a cited test doesn't exist, so a test rename updates its row in the same PR.
5. Only then: announce "ready for review", show the diff summary, offer to open a PR via `/pr`.

**Don't invent ad-hoc gates.** Running `pnpm typecheck` or eyeballing `pnpm test` output once doesn't substitute for the gate. Reach for the slash command first; narrow to ad-hoc tooling only for targeted debugging mid-development.

Each step closes a failure mode that has actually shipped: per-slice test runs missed what the full gate catches, and PRs that changed described behavior left the docs describing the old shape.

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
