---
name: simplify-core
description: Weekly architecture review of the Act core (libs/act) aimed at making it simpler — smaller public surface, smaller files, DRY code, comments that explain instead of narrate, and examples a newcomer can follow. Measures the core, audits what the past week added, runs one or two review lenses, and proposes ranked, evidence-backed simplifications for the user to approve. Use when the user says "run the simplicity review", "weekly review", "simplify the core", "find simplification opportunities", or asks to evaluate the framework's design.
---

# Simplify the core

Event sourcing is simple: commands decide, events record, state folds, reactions follow. A framework for it should be small enough to read in an afternoon. Act has drifted from that. Every fix was reasonable on its own day, and together they left a core that is half comments, carries hundreds of ticket numbers, and grows a mechanism for every edge case.

This review exists to reverse that drift, one approved change at a time. **The output is proposals, not edits.** The user picks; each pick then goes through the normal ticket → branch → PR workflow.

## Ground rules

1. **Subtract.** A proposal must make the core smaller or plainer: fewer exports, methods, options, concepts, files over budget, or lines. "Add X to simplify Y" is not a simplification. If a proposal adds anything, it must remove more, and say so in numbers.
2. **The framework is published.** Internal code (`libs/act/src/internal/`, private members, comments) can change freely. Public surface ([STABILITY.md](../../../STABILITY.md)) changes only with a deprecation path: keep the old name working, mark it `@deprecated`, document the migration, remove it in the next major. Say which kind every proposal is.
3. **I am a source of the complexity.** Much of the recent growth came from my own fixes. Review my changes with the most suspicion, and never defend a mechanism because I added it. The signal of my typical mistake: a fix that needs a second mechanism to undo its own side effect (#1795), or a narrow failure answered with machinery when a recovery path or a doc correction would do.
4. **Behavior stays.** A simplification never changes what an app observes, except to remove a bug. The suite (100% coverage) and the TCK are the proof; a proposal that needs tests rewritten to pass is a behavior change and must say so.
5. **Don't relitigate.** Read `history.md` first. A proposal the user rejected stays rejected unless something material changed, and then the proposal says what changed.

## The bar

What "simple" means here, concretely:

- **Small public interface.** A newcomer should meet a handful of nouns: `state`, `slice`, `projection`, `act`, the `Store`/`Cache`/`Logger` ports, and an app with `do`, `load`, `query`, `drain`/`settle`, `close`. Everything else is either a deliberate advanced tool or a candidate to fold, hide, or remove.
- **Small files, one concept each.** A file over ~300 lines, or one a reader can't summarize in one sentence, is a split or a shrink candidate.
- **DRY.** One implementation per idea. Adapter logic that repeats across InMemory/Postgres/SQLite belongs in the orchestrator or the TCK. Option validation lives in `internal/config.ts` once.
- **Comments explain why, briefly.** No ticket numbers, no history ("before #1234 this…"), no restating the code, no essays. The *why* behind a rejected design belongs in `book/` or the PR, not the source. A comment longer than the code it explains is a smell.
- **No defensive code the contract already guarantees.** A branch that can't happen is noise (and a coverage burden).
- **Real examples.** Every public concept has a short runnable example in `packages/` or the docs that a reader can copy. If the example needs a paragraph of caveats, the API is too complicated.

## Weekly run

### 1. Measure

```bash
git checkout master && git pull --ff-only && pnpm build
.claude/skills/simplify-core/metrics.sh
```

Compare with the last entry in `history.md`. Any metric that grew needs an explanation in the report (which PRs grew it, and whether that growth was earned).

### 2. Audit what changed since the last run

```bash
git log --since="<last run date>" --stat -- libs/act/src
```

For each PR that touched `libs/act/src`, ask:

- Did it add a concept, option, export, flag, or special case? Was a smaller fix available (a doc correction, an existing recovery path, reusing an existing mechanism)?
- Is it a fix on top of a recent fix in the same file? Fix-on-fix chains are where accidental complexity concentrates; look for the simpler design the chain is circling.
- Did it add a comment that narrates the change instead of explaining the code?

This step catches drift while it is still cheap to undo.

### 3. Run one or two lenses

Rotate so each lens comes around every few weeks; record which ran in `history.md`.

- **Public surface.** List every runtime export and every `Act` public method. For each: who uses it (`packages/`, docs, other libs)? Is it a duplicate path to something else? Could it be internal, folded into another call, or an option instead of a method? Note `IAct` declares fewer methods than the class exposes; decide which side is right.
- **File budget.** Take the largest files. What concepts does each hold? Propose the split (by concept, not by size) or the shrink (dead branches, duplicated helpers, comment noise).
- **Comment noise.** Sample a large file. Propose a rewrite of its comments: keep the *why*, cut ticket numbers, history and restated code. This is internal and low-risk, and it is often the single biggest readability win. Batch by file.
- **Concepts and options.** List the named mechanisms (lanes, priority, fairness reserve, correlation lease, work mark, defer, backoff, breaker, close lock, …) and the `ActOptions` / reaction options. For each: what problem does it solve, how many apps need it, does an option exist that nobody sets, do two mechanisms overlap? Propose folds and removals.
- **DRY across adapters and builders.** Find logic implemented three times (InMemory/PG/SQLite) or twice (act-builder/slice-builder). Propose the single home.
- **Reading path.** Read the README quickstart, then follow `app.do` → `action` → `commit`, and `app.settle` → correlate → drain, as a newcomer would. Every place you have to jump files or hold more than a few names in your head is a finding.
- **Examples.** Do the examples in `packages/` and the docs show the simple path first? Does each one compile against today's API and use the fewest concepts it can?

### 4. Check the field (monthly, or when a lens raises a question)

Compare a specific design question against how established event-sourcing systems answer it: KurrentDB/EventStoreDB, Marten, Equinox, Emmett, Axon, the decider pattern. Look for the simpler answer, not new features to add. Cite what you read. "System X does this with one concept where Act uses three" is a strong proposal; "System X has a feature Act lacks" is not this skill's business.

### 5. Propose

Write at most 5–7 proposals, ranked by simplicity gained per unit of risk. Each one:

```
### N. <one-line title>
Kind: internal | public (deprecation path: …)
Removes: <exports / methods / options / concepts / files / ~lines, with numbers>
Evidence: <file:line, usage counts, what the reader must hold in their head today>
Proposal: <the change, concretely; a before/after sketch if it helps>
Risk: <what could break; which tests and TCK cases prove it doesn't>
```

Prefer proposals that can ship as one small PR. If a proposal needs an RFC (new public surface, even as a replacement), say so and keep it in the list only if it removes clearly more than it adds.

### 6. Record and stop

Append to `history.md`: the date, the metrics block, the lenses run, the proposals (one line each), and, once the user answers, what was accepted or rejected and why. Then present the report and **stop**. Don't open tickets or branches until the user picks.

## Smells worth naming

These have shown up in this codebase; check for them by name:

- **A mechanism that undoes another mechanism** — an exemption, a guard, or a reset whose only job is to cancel a side effect of something else.
- **Run-once latches and armed flags** that need resetting from several places.
- **Comments longer than the code**, or comments that cite tickets and describe what the code used to do.
- **Options with one sensible value**, or defaults nobody overrides.
- **Two paths to the same result** (two entry points, two builders, a method and an option that both do it).
- **Adapter code that re-implements orchestrator logic**, or orchestrator code that re-implements a store's job.
- **A behavior documented in four places**, each slightly different. One source of truth, others link to it.
