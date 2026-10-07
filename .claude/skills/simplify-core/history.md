# Simplify-core history

The skill's memory. Read it first on every run; the retrospective (step 7) updates it. Newest run last.

## Lens rotation

Least recently run goes next. A lens with no accepted proposal in its last three runs is retired (it can be revived with a reason).

| lens | last run | runs | accepted | status |
|---|---|---|---|---|
| Public surface | 2026-10-07 | 1 | 0 | active (its deprecations were rejected; scope narrowed by rule 2) |
| Dead code (tool) | 2026-10-07 | 1 | 2 | active |
| Hotspots (tool) | 2026-10-07 | 1 | 1 | active |
| File budget | 2026-10-08 | 2 | 0 | active |
| Comment noise | 2026-10-07 | 1 | 1 | active |
| Concepts and options | 2026-10-07 | 1 | 1 | active |
| Core or decorator? | 2026-10-08 | 1 | 0 | active (PII examined: stays in core) |
| DRY across adapters and builders | 2026-10-07 | 1 | 1 | active |
| Reading path | 2026-10-08 | 1 | 0 | active |
| Newcomer test (quarterly) | never | 0 | 0 | active |
| Tests by concept | 2026-10-07 | 1 | 1 | active |
| Mutation evidence (monthly, CI) | never | 0 | 0 | retired: setup removed (#1805), see baselines below |
| Packages earn their place | 2026-10-08 | 2 | 0 | active (no removals possible; found no subtraction) |
| Infra | 2026-10-07 | 1 | 1 | active |
| One source of truth | 2026-10-08 | 2 | 0 | active |
| Examples | 2026-10-08 | 1 | 0 | active |
| Process | 2026-10-08 | 1 | 0 | active |

## Mutation baselines

The last trusted Stryker scores, recorded when the setup was removed (#1805) because it can't run on vitest 5. A revived setup compares against these.

| package | score | old break floor |
|---|---|---|
| act | 85.7% | 80 |
| act-pg | 94.4% | 88 |
| act-sqlite | 93.0% | 87 |
| act-http | 92.4% | 86 |
| act-crypto | 92.9% | 87 |
| act-ops | 98.4% | 92 |
| act-patch | 79.1% | 73 |
| act-tck | 39.7% | 34 |

## Backlog

Sound proposals that missed a run's cut. The next run ranks these before looking for new ones.

_(promoted to proposals P2026-10-08-1..5; the `KafkaBroker` removal was dropped: it is public, and rule 2 no longer allows deprecations)_

## Self-changes

Every change the retrospective made to `SKILL.md`, `lenses.md` or `metrics.sh`, with the evidence that prompted it.

- 2026-10-08 (third run): a proposal with no decision stays pending and counts toward the next report's 5–7. The user asked for a new run before deciding on the previous five; without this rule the list would only grow.
- 2026-10-08 (third run): the Examples lens now covers the `scaffold-act-app` skill (two of its calls crash and nothing compiles it); the Process lens says how to count from PR and run history; two smells added (a pass-through layer kept for one decorated call; a gate most PRs declare away).

- 2026-10-08: ground rule 2 no longer allows deprecating or removing public surface, and the next-major list is gone. The user rejected the 17 deprecations in P2026-10-07-6 ("dont deprecate anything"): they rested on a grep of this repo, which can't see who uses a published package. The bar's "around 30 exports" became "exports don't grow"; the proposal template's kinds no longer include public/next-major; the Public surface and Core-or-decorator lenses were reworded to match.
- 2026-10-08: `metrics.sh` exited silently once ticket references reached zero: two `grep`s with no match fail under `set -euo pipefail`. Both now tolerate an empty match.
- 2026-10-07: the bar said `IAct` and `Act` should expose the same methods. `IAct` is deliberately the narrow surface reaction handlers receive; matching them would grow the handler surface. Reworded: `IAct` stays small, extra `Act` methods are documented as operator surface. (Evidence: surface specialist, `types/action.ts` IAct doc.)
- 2026-10-07: added the backlog. Four specialists returned 20 proposals and the 5–7 cap dropped sound ones; without a backlog the next run would rediscover them.
- 2026-10-07: a behavior claim ranks only after the main loop reproduces it with an asserting test and a control. The specialist's `start_correlations` probe only logged; it turned out right, but an unasserted probe is not evidence.
- 2026-10-08: added `learnings.md`, read at the start of every run and curated in step 7. It replaces the per-ticket essays in `book/` (76 essays, ~3,500 lines, deleted), which the user won't use; the goal is lessons for the architect, not stories. CLAUDE.md's pre-handoff step 3 now asks for one learnings entry when a change taught something, instead of `/book-note` (deleted).
- 2026-10-08: ground rule 5 changed from "don't relitigate" to "question past decisions, not past rejections": shipped designs (even ones memory or learnings call settled) are open to challenge with evidence; only proposals the user rejected in a run stay closed. Added the "Core or decorator?" lens. Prompted by the user, citing PII in core rather than as a decorator.
- 2026-10-07: mutation lens marked blocked. `mutation.yml` documents that Stryker's vitest runner can't match vitest 5 test names, so every mutant survives and the run is meaningless.

## Runs

### 2026-10-07 — baseline (no lenses)

| metric | value |
|---|---|
| core lines (libs/act/src) | 21389 |
| code lines / comment lines | 10221 / 11168 (52% comments) |
| ticket refs in source | 404 |
| files over 300 lines | 21 |
| runtime exports (@rotorsoft/act) | 54 |
| IAct methods / Act class public methods | 8 / 20 |
| Store port methods | 18 |
| ActOptions fields | 14 |
| spec files / test lines (all libs: 45523 src lines) | 241 / 60936 |
| test names citing tickets | 200 |
| published packages (libs/) | 12 |
| CI workflows / lines | 8 / 1132 |
| docs lines (excl. generated API) / CLAUDE.md lines | 9552 / 333 |

Largest files:
- libs/act/src/act.ts (2369)
- libs/act/src/types/ports.ts (1476)
- libs/act/src/adapters/in-memory-store.ts (1434)
- libs/act/src/types/action.ts (1228)
- libs/act/src/internal/correlate-cycle.ts (961)
- libs/act/src/builders/state-builder.ts (919)
- libs/act/src/internal/event-sourcing.ts (899)

Context: the framework is published, and many recent changes were bug fixes that each added mechanism; the user notes some of them overcomplicated things (e.g. #1795, closed unmerged in favor of a doc fix). Notable starting points: 52% of core lines are comments; 404 ticket references in source and 200 in test names; 21 core files over 300 lines; `IAct` declares 8 methods while the `Act` class exposes 20; tests (61k lines) outweigh library source (45k); 104 core spec files, many named per ticket (seven `correlate-*` specs).

Proposals: none (baseline). Decisions pending: none.

### 2026-10-07 — first full run (four specialists)

| metric | baseline | now | why |
|---|---|---|---|
| core lines | 21389 | 21396 | +7 from #1796/#1798 (wave-27 fixes) |
| comment lines | 11168 | 11175 (52%) | same PRs; comments citing tickets |
| ticket refs in source | 404 | 407 | same PRs: my fixes still add ticket numbers to comments |
| test lines | 60936 | 60995 | regression tests for the wave-27 fixes (earned) |
| test names citing tickets | 200 | 202 | same; should have been named by behavior |
| everything else | | unchanged | |

Audit: since the baseline, 13 fix PRs merged, all mine. Two were fix-on-fix in the same area and were cut back (#1795 closed for the doc fix #1801; #1760 replaced by #1769). The habit to stop: ticket numbers in new comments and test names.

Lenses: Public surface, Dead code, Hotspots, File budget, Comment noise, Concepts and options, DRY, Tests by concept, Packages, Infra, One source of truth. Mutation: blocked.

Proposals (decisions due next run):
- P2026-10-07-1. Make `start_correlations` drain what it finds (bug: polling marks remote work but never runs reactions; reproduced with a control) by turning it into a timer around `settle()`, and delete the separate polling path.
- P2026-10-07-2. Delete the dead Stryker setup (18 files, ~690 lines).
- P2026-10-07-3. Strip ticket numbers and history from internal comments (~330 refs, ~1,500 lines).
- P2026-10-07-4. Tests by concept: merge the six `correlate-*` specs, delete tests of dead private fields, fix the correlator flake, rename 246 ticket-named tests.
- P2026-10-07-5. CI and repo cleanup: fix the docs deploy filter (misses 6 packages), build docs once, delete `npm_migration.md`, the stale root CHANGELOG and 4 copied tsup configs.
- P2026-10-07-6. Deprecate 16 unused public exports and `Act.stop_settling`; knip cleanup of internal dead code; queue the dead autoclose options for the next major.
- P2026-10-07-7. Rewrite `InMemoryStore.query` as one loop (complexity 65 → ~15); move drain defaults into `internal/config.ts`.

Decisions on the 2026-10-07 proposals:
- P1 accepted, shipped #1811 (polling now drains; separate polling path deleted).
- P2 accepted, shipped #1812. Promised ~690 lines; removed 1,623 (lockfile included).
- P3 accepted, shipped #1820. Ticket refs 407 → 0 (520 incl. adapters). Promised comments under 40%; got 52% → 49%: most comment volume is explanation and public docs, not history. Estimate by sampling before promising a percentage.
- P4 accepted, shipped #1821 (+ flake fix #1818). 7 correlate specs → 1; 257 test names cleaned. Test lines barely moved (60,995 → 60,970): merging files without a shared fixture saves files, not lines.
- P5 accepted, shipped #1813. Workflows 8 → 7, lines 1,132 → 986; deploy filter bug fixed.
- P6 partly rejected: the 17 public deprecations were dropped ("dont deprecate anything"); the internal dead-code half shipped as #1817.
- P7 accepted, shipped #1814 (`InMemoryStore.query` complexity 65 → under 15; defaults in config.ts).
Also from the run: #1489 (split Store) closed as not needed; `book/` replaced by `learnings.md` (#1815, #1819); rule 5 opened past decisions to challenge (#1816).

### 2026-10-08 — weekly (one lens: Core or decorator?)

| metric | 2026-10-07 | now | why |
|---|---|---|---|
| core lines | 21396 | 20339 | #1811, #1814, #1817, #1820 |
| comments | 52% | 49% | #1820 |
| ticket refs in source / test names | 407 / 202 | 0 / 0 | #1820, #1821 |
| files over 300 lines | 21 | 21 | unchanged |
| runtime exports | 54 | 54 | deprecations rejected |
| spec files / test lines | 241 / 60995 | 235 / 60970 | #1821, #1812 |
| CI workflows / lines | 8 / 1132 | 7 / 986 | #1812, #1813 |

Audit: 7 PRs since the run, all simplifications from it; none added a concept, option, export or workflow.

Lens, Core or decorator? (PII): PII touches 21 core files (370 lines) but is concentrated in `internal/sensitive.ts` and `builders/event-builder.ts`; the pipelines touch it in 3–10 lines each. The Store carries a `pii` column, a `with_pii` read flag and an optional `forget_pii`. Actor-gated reads (`.discloses`) and handler stripping need the registry's schema markers and the actor, which a `Store` decorator never sees, so a decorator cannot carry the feature; moving it to a leaf package would be breaking for little gain. Finding: keep it in core. No proposal.

Proposals (decisions due next run), from the backlog:
- P2026-10-08-1. Move adapter tests that repeat a contract (priority, Date revival, stream patterns, notify, `query_stats` paging) into the TCK; fix the stale Date-revival claim in behavior-contracts row 149.
- P2026-10-08-2. Fold the duplicated Postgres fault-injection cases (`store.spec.ts` error block, `commit.error.spec.ts`) into `store.error.spec.ts`.
- P2026-10-08-3. One home for blocked-stream recovery in the docs (`error-handling.md`); the ~12 other places link to it; trim the CLAUDE.md bullet; fix the 3 stale code paths in CLAUDE.md.
- P2026-10-08-4. Move the close lock and close catch-up out of `act.ts` (2,098 lines) into the close module.
- P2026-10-08-5. Trim rationale from the public type docs in `types/ports.ts`, `types/action.ts`, `types/reaction.ts` (doc text only; signatures untouched).

### 2026-10-08 — full run (four specialists: reading path + file budget, examples, process, source of truth + packages)

Metrics: unchanged from the weekly run earlier today (only the skill record merged since). No PRs to audit.

Decisions on the weekly run's P2026-10-08-1..5: none yet; pending.

Verified in the main loop before ranking: the scaffold skill's two crashing calls (`stop()` on a boolean, `leased` on a correlate result); the backoff docs' "exactly maxRetries attempts" against `backoff.spec.ts` (maxRetries 2 → 3 attempts); the close-the-books recipe's removed predicate form; the guide's metric names (1 of 7 matches act-otel); `build_drain` returning bare ops except `subscribe`; the `IAct.forget` "throws at build time" claim (it throws on call; the specialist's probe had a control); the stability walk following imports; 175 of 300 PRs carrying an rfc-gate exemption; CLAUDE.md's nonexistent per-package `stability.spec.ts`.

Packages: 12 published; act-http has the highest fix rate (34 of 42 commits in 90 days are fixes) and should not grow new transports; no subtraction found (removal is ruled out).

Proposals (pending), ranked:
- P2026-10-08b-1. Fix the broken promises in docs and skills: backoff attempt count (error-handling.md:331, CLAUDE.md, `ReactionOptions` doc), the recipe's predicate form, `IAct.forget`'s build-time claim, event-sourcing.md's "correlate is skipped", the scaffold skill's crashing calls, CLAUDE.md's stability-spec claim, ~15 stale paths and names (`PostgresStore.ts`, `_drainAll`, `classifyRegistry`, `ACT_ONLY_LANES`, `internal/build-classify.ts`).
- P2026-10-08b-2. Make the stability snapshot record each entry point's exported names and declared types instead of copying all source (internal spec only; `runStabilityTck` unchanged). Shrinks a 65,390-line file that changed in 289 commits.
- P2026-10-08b-3. Once b-2 lands, drop the rfc-gate CI job and its 191-line script (0 true catches, 175/300 PRs exempt); keep RFCs as a review convention.
- P2026-10-08b-4. Delete the `DrainOps` / `build_drain` / `internal/drain.ts` layer (~120 lines, 1 file, 3 names) and pass `run_drain_cycle` its deps object instead of 13 positional arguments.
- P2026-10-08b-5. Examples: strip the calculator hello-world to ~11 concepts (no lanes, no explicit `reactingTo`, settle instead of bare drains), drop the redundant `reactingTo` from wolfdesk and the docs, make wolfdesk's `committed` listener settle, take ticket history out of example comments.
- P2026-10-08b-6. Make act-otel the one home for metric names: replace the guide's hand-wired walkthrough (~90 lines) with the bridge's table, fixing the alert table.
- P2026-10-08b-7. Move conformance.yml and stress.yml to one weekly workflow plus dispatch (0 code catches in ~870 runs).

Tickets (user: "open tickets for all findings"; overlaps merged): #1824 broken promises (b-1), #1825 surface-only snapshot (b-2), #1826 drop rfc-gate (b-3), #1827 DrainOps layer (b-4), #1828 examples (b-5; scoped to calculator's `main.ts`, since the package is imported by client and server and used by CI, docs and specs), #1829 act-otel metric names (b-6), #1830 weekly conformance/stress (b-7), #1831 adapter tests into the TCK (P2026-10-08-1 + autoclose specs), #1832 PG fault-injection fold (P2026-10-08-2), #1833 blocked-stream docs + CLAUDE.md index (P2026-10-08-3 + backlog), #1834 close machinery out of act.ts (P2026-10-08-4 + backlog), #1835 public type docs (P2026-10-08-5), #1836 behavior-contracts table (decision), #1837 close-the-books recipe.

Backlog (sound, missed the cut, now ticketed above): drop the behavior-contracts row rule (53 of 479 cited names don't resolve; nothing checks it — the user's call); trim CLAUDE.md to an index and fold `/coverage` and `/charter-diff` into `/release-check`; dedupe the two `run_close_cycle` deps bags in act.ts and reattach `close()`'s orphaned doc; shrink the close-the-books recipe to a link; move the mirrored autoclose adapter specs into the TCK.

