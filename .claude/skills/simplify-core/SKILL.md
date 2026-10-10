---
name: simplify-core
description: Self-improving simplicity review of the Act repo. Measures the framework, audits recent changes for accreted complexity, runs rotating review lenses (core API, tests, packages, infra, docs, process, the field), proposes ranked, evidence-backed simplifications for the user to approve, then reviews its own effectiveness and rewrites itself. Use when the user says "run the simplicity review", "weekly review", "simplify the core", "find simplification opportunities", or asks to evaluate the framework's design.
---

# Simplify the core

Event sourcing is simple: commands decide, events record, state folds, reactions follow. A framework for it should be small enough to read in an afternoon. Act has drifted from that: every fix was reasonable on its own day, and together they left a core that is half comments, carries hundreds of ticket numbers, and grows a mechanism for every edge case.

This skill reverses the drift one approved change at a time, and improves itself as it goes. **It proposes; it never edits product code on its own.** The user picks proposals, and each pick goes through the normal ticket → branch → PR workflow.

Files: `lenses.md` (what to look at), `metrics.sh` (how to measure), `history.md` (every run, proposal, decision and self-change), `learnings.md` (what building Act has taught, as rules). Read `history.md` and `learnings.md` before anything else, and check every proposal against the learnings.

## Ground rules

1. **Subtract.** A proposal must make the repo smaller or plainer: fewer exports, methods, options, concepts, packages, files over budget, test files, workflows or lines. If it adds anything it must remove more, in numbers.
2. **The framework is published.** Internal code changes freely. Public surface ([STABILITY.md](../../../STABILITY.md)) is not deprecated or removed: a grep of this repo can't see who uses a published package. Simplify it by not adding to it, by routing internal callers to internal implementations, and by documenting it well. Say exactly what was searched ("no caller in this repo"), never "unused".
3. **I am a source of the complexity.** Review my own recent changes with the most suspicion. My typical mistakes: a fix that needs a second mechanism to undo its own side effect, and machinery for a narrow failure when a recovery path or a doc correction would do.
4. **Behavior stays.** A simplification changes nothing an app observes, except to remove a bug. The suite (100% coverage), the TCK, and the rows in `docs/docs/architecture/behavior-contracts.md` are the proof; consolidating tests may never drop a row or coverage.
5. **Question past decisions, not past rejections.** Any shipped design is open to challenge, including ones recorded in `learnings.md`, memory or docs as settled: a feature built into core that could be a decorator or a leaf package is exactly what this review exists to find. A challenge names the original reasons and shows why they no longer hold. A proposal the user rejected in an earlier run stays rejected unless something material changed, and the proposal says what.

## The bar

Targets the retrospective tracks (adjust them only with the user):

- comments under 25% of core lines; no ticket numbers in source or test names
- no core file over 300 lines; one concept per file
- runtime exports of `@rotorsoft/act` don't grow (54 today); `IAct` stays the small surface handlers see, and each `Act` method beyond it is documented as operator surface
- one implementation per idea: adapter logic shared through the orchestrator or the TCK, config validated once in `internal/config.ts`
- one spec per concept, not per ticket; adapter suites don't repeat the TCK
- each behavior documented in one place and linked elsewhere
- the README quickstart needs few concepts, and that count only goes down

## Modes

- **Weekly (light):** no agents. Steps 1, 2, one lens, 5, 6, 7.
- **Monthly (full):** everything, with the lenses due that month fanned out to at most four read-only specialists in parallel (see "Specialists"). Also the tool-backed checks in `lenses.md` that need CI (mutation testing).
- **Quarterly:** a full run plus the self-review in step 7.

## A run

1. **Measure.** `git checkout master && git pull --ff-only && pnpm build && .claude/skills/simplify-core/metrics.sh`. Compare with the last entry in `history.md`; every metric that grew needs an explanation (which PRs, and whether the growth was earned).
2. **Audit what changed** since the last run: `git log --since=<last run> --stat`. For each PR ask: did it add a concept, option, export, package, workflow or special case? Was a smaller fix available? Is it a fix on a recent fix in the same file? Fix-on-fix chains are where accidental complexity concentrates.
3. **Run lenses.** Pick the lenses due by the rotation in `history.md` (least recently run first, skipping retired ones). Each lens is defined in `lenses.md`.
4. **Check the field** (monthly, or when a lens raises a design question): how KurrentDB/EventStoreDB, Marten, Equinox, Emmett, Axon or the decider pattern answer that specific question. Look for the simpler answer, not missing features. Cite sources.
5. **Propose** at most 5–7 simplifications, ranked by simplicity gained per unit of risk, in the template below. Verified defects (a red test with a control, or a doc that contradicts the code) rank first and don't count toward the cap. Sound proposals that miss the cut go to the backlog in `history.md`; the next run ranks the backlog before looking for new ones.
6. **Report and stop.** Present the ranked list and the metrics delta. Don't open tickets or branches until the user picks.
7. **Retrospective and self-update** (before the report is recorded):
   - **Decisions:** record the user's answers to the *previous* run's proposals (accepted / rejected + reason / deferred). A proposal with no answer stays pending, is listed again, and counts toward the next report's 5–7.
   - **Promises kept:** for proposals shipped since the last run, compare the promised "Removes" with the actual metrics delta. A proposal that removed less than it promised is a lesson about estimating.
   - **Lens yield:** a lens with no accepted proposal in its last three runs is retired (note it in `history.md`; it can be revived with a reason).
   - **Rejection patterns:** the same rejection reason twice becomes a ground rule or a smell in `lenses.md`, worded as a check.
   - **Metric value:** a metric that hasn't informed a decision in three runs leaves `metrics.sh`; a question the run couldn't answer with numbers may add one, if it replaces another.
   - **Self-review (quarterly):** run the simplicity lens on this skill itself. Is every step still earning its keep?
   - **Learnings:** add what this run or the merged PRs taught that `learnings.md` lacks; merge duplicates, drop entries no longer true, keep it under 150 lines.
   - **Write the changes** to `SKILL.md`, `lenses.md` and `metrics.sh` directly, and log each in `history.md` with its evidence. `SKILL.md` stays under 150 lines and `lenses.md` under 200: an addition that would cross the budget must replace something.
   - All of it ships in **one PR** with the history entry, so the user reviews every self-change. Never edit the skill outside a run.

## Proposal template

```
### P<run date>-<n>. <one-line title>
Kind: internal | docs | tests | infra
Removes: <exports / methods / options / concepts / files / tests / ~lines, with numbers>
Evidence: <file:line, usage counts, what a reader must hold in their head today>
Proposal: <the change, concretely; a before/after sketch if it helps>
Risk: <what could break; which tests, TCK cases and contract rows prove it doesn't>
```

The id lets the next retrospective find it.

## Specialists (monthly)

When the month's lenses are independent, fan them out instead of running them in sequence: at most four agents, one message, read-only. Suggested owners: `act-code-reviewer` for code lenses, `act-test-author` for the tests lens, `act-doc-writer` for docs, general-purpose for infra, packages and the field. Every specialist gets ground rules 1–5, its lens text from `lenses.md`, the proposal template, a cap of five proposals, and this instruction first: *create your notes file at `<scratchpad>/simplify/<lens>.md` and append to it as you go*. No edits, no tickets.

Then synthesize in the main loop: merge duplicates, drop anything that adds more than it removes or conflicts with another proposal, check the strongest claims yourself, and rank one list. A behavior claim (a bug, a broken promise) ranks only after the main loop reproduces it with an asserting test and a control. Specialists optimize their corner; the main loop decides.
