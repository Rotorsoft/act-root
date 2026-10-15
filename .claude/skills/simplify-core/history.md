# Simplify-core history

The skill's memory. Read it first on every run; the retrospective (step 7) updates it. Newest run last.

## Lens rotation

Least recently run goes next. A lens with no accepted proposal in its last three runs is retired (it can be revived with a reason).

| lens | last run | runs | accepted | status |
|---|---|---|---|---|
| Public surface | 2026-10-15 | 3 | 0 | active (this run: r-3, r-5 pending; retire next run if neither is accepted) |
| Dead code (tool) | 2026-10-11 | 3 | 2 | active (second run found only export keywords; see its false positives in lenses.md) |
| Hotspots (tool) | 2026-10-11 | 3 | 1 | active |
| File budget | 2026-10-15 | 4 | 1 | active (lane wiring move re-measured: −171 code lines from act.ts, no repo shrink) |
| Comment noise | 2026-10-08 | 2 | 2 | active (25% bar unreachable while public type docs stay; see P2026-10-08d-6) |
| Concepts and options | 2026-10-15 | 4 | 1 | active (found the lag/lead ratio serves no row) |
| Core or decorator? | 2026-10-15 | 3 | 0 | retired 2026-10-15: three runs, findings only (PII, audit, breaker, lanes stay; priority is a major-version question) |
| DRY across adapters and builders | 2026-10-11 | 3 | 1 | active |
| Reading path | 2026-10-15 | 3 | 1 | active (found the broken `@example` blocks) |
| Newcomer test (quarterly) | 2026-10-08 | 1 | 0 | active (baseline: 22 concepts, 3 imports) |
| Tests by concept | 2026-10-11 | 3 | 3 | active |
| Mutation evidence (monthly, CI) | never | 0 | 0 | retired: setup removed (#1805), see baselines below |
| Packages earn their place | 2026-10-15 | 4 | 0 | retired 2026-10-15: four runs, no proposal (removal is ruled out; act-tck churn is the snapshot, now P2026-10-15p-1) |
| Infra | 2026-10-15 | 4 | 1 | active |
| One source of truth | 2026-10-15 | 4 | 3 | active |
| Examples | 2026-10-15 | 3 | 1 | active (found 31 arrow-function handlers that throw at build) |
| Process | 2026-10-15 | 3 | 3 | active |
| Feature interactions | 2026-10-15 | 3 | 5 | active (found the idle-rule bug) |

## Interaction register

Where two features meet, and why. The Feature interactions lens reads this first: a justified entry is not re-proposed unless its reason stops holding; an accidental one stays here until a proposal removes it.

| features | where they meet | kind | reason |
|---|---|---|---|
| defer, backoff, autoclose | the persisted `deferred_at` schedule and the per-worker wake | shared primitive | one schedule serves all three |
| retry budget, breaker | `claim` raises `retry`; the drain skips the block while `store_failing` | justified | counting at claim makes a handler that crashes the worker spend its budget; a store outage must not |
| close, drain | a reaction's close request runs after the drain's `ack` | justified | the close guard must see the requesting reaction caught up |
| correlation lease, lanes / explicit correlate / shutdown / checkpoint | lease key includes the `onlyLanes` shard; `app.correlate()` skips the lease; shutdown hands it back last; the key selects the checkpoint row | justified | N workers otherwise read and mark every event N times (#1532) |
| defer, retry count | an explicit defer acks with `retry: -1` | accidental, low value | a sentinel in a public port field; cheap to keep |
| retry timing, lease | removed by #1872: every retry is paced by the reaction's backoff (default fixed 10 s); the lease only keeps workers apart | resolved | P2026-10-10o-2, #1875 |
| lanes, priority | `subscribe` re-lanes on priority ≥ stored (how a restart applies an edited declared lane); correlate reads the row when it has no record, so the row owns a dynamic target's lane and the LRU only caches it | justified once #1878 merges | P2026-10-10o-3, #1876; the coupling itself goes only if priority does (major-version question) |
| breaker, drain / settle | five places feed one consecutive-failure count of **store** failures; a success in one loop resets failures in another | justified | #1877: app code never leaves the loop that ran it (correlate stops before a throwing resolver's event and logs once, drain fails the stream, a reaction close logs non-store failures), so only store and framework errors reach the breaker; a real outage fails every loop; a store failing one kind of call can keep it closed, still visible as `error` events |
| defer wake, breaker | fixed by #1872: the breaker check sits inside the drain's `try`, so `finally` re-aims the wake | resolved | P2026-10-10o-1, #1874 |
| defer wake, drain lock / streamLimit | #1892 keeps a due entry until a drain reaches it; but a pass whose claims all defer or back off still counts as idle (controller disarms, settle stops, the wake re-fires only for due entries), so marked streams never claimed wait for a commit | accidental, and a bug | P2026-10-15o-1 (probed: 5 of 12 ran; control 12/12) |
| drain failure, wake | a failed finalize leaves no wake: the breaker re-drives only once it opens (threshold 5), so a deferred reaction never re-fires on an idle app | accidental, and a bug | P2026-10-15d-2 (probed: 1 run; control 2) |
| app errors, correlation | one throwing resolver stops the scan before its event, so discovery stops for every reaction until it stops throwing | justified | #1913, the user's choice: nothing is lost; isolating one reaction needs per-reaction checkpoints |
| lease, lanes | background drains (wake, settle, `cycleMs`, `start_correlations`) claim with the lane's `leaseMillis`; a per-call `leaseMillis` covers only that call, and the default lane can't be configured | justified, under-documented | P2026-10-11b-2 |

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

- Move CLAUDE.md's naming, config-validation and detailed pre-handoff sections to CONTRIBUTING.md, one-line rule + link each (~9 KB); fix CONTRIBUTING's two dead pointers.
- Drop the pre-push hook (CI tests every push; 3 of 341 master commits were direct pushes) and the unmaintained RFC "Status:" lines.
- Four published exports are tagged `@internal` (`default_scope`, `ExitCodes`, `PackageSchema`, `pii_fields`; the last was made public on purpose by RFC 1228). Remove the wrong tag, record the other three in STABILITY.md as published-but-not-for-use. `export *` over `ports.ts`, `utils.ts`, `config.ts` publishes anything added there without an RFC.
- act-tck README and tck-conformance.md hand-copy stale peer versions (vitest >=3.0.9, zod ^4.4.3) and carry history banners.
- Design finding, no action: every runnable example needs `app.on("committed", () => app.settle())` (~10 copies, each with a caveat); worth asking whether that should be a default.
- Design finding for a future major: priority (required `prioritize` port method, a column and two indexes per SQL adapter, a fairness reserve in 3 claims, the lane-rides-priority rule in 3 subscribes, 7 bugs) has no example user in this repo and no counterpart in other ES frameworks, which use separate processors (Act's lanes). Removing it is breaking; it is the user's question. 2026-10-11: Marten (per shard), Axon (per processor/segment), Kurrent (per group) and Emmett (per processor) all answer "a slow reaction must not block a fast one" with separate processors and none orders claims by priority; priority touches 13 source and 26 test files, and dropping it also drops the lane/priority coupling behind #1599 and #1876.
- `ci-cd.yml` comments: ~100 of 158 comment lines are history; one misplaced.
- act-http tests: drop the tRPC and Hono error tables that repeat the parity table and `api/errors.spec.ts` (~170 lines); `audit.spec.ts` collector helper and shared `meta` (~140 lines).

- Tests: replace `sleep`-then-`expect` with `vi.waitFor` (~18 sites; thin margins in public-defer, backoff, intra-event-ack) and drop the two hand-written `until` helpers; `action-retry` asserts `elapsed < 50`. (P2026-10-11c-4)
- act-pg / act-sqlite `pii-encryption.spec.ts` run the same 9 cases (~238 shared lines): delete the sqlite `query_stats` duplicate of a TCK case now; moving the rest into a TCK capability adds act-tck surface and needs an RFC (~−400 net, unprobed). (P2026-10-11c-5)
- PostgresStore `commit`'s single-event SQL fork (4 statement variants → 2) if a CI bench shows it doesn't pay; `commit` is the most-changed function in the most-changed adapter. (P2026-10-11a-5)
- Delete the renovate rule guarding a `pnpm.overrides` block that doesn't exist (`jq .pnpm package.json` → null; −6 lines). (P2026-10-11d-3)
- Move lane wiring out of act.ts into `internal/lanes.ts` (re-measured 2026-10-15: −171 code lines from act.ts, 841 → ~620; no repo shrink) and restore's `scan` to `internal/restore.ts` (~−153 from event-sourcing.ts); the settle loop stops calling the public `drain()` (drops a Zod re-parse per pass). Do after r-1. (P2026-10-15r-4)
- Drop `Subscription.floor` in correlate: it equals `priority` for every dynamic record and differs only for statics, which have their own map (~−4 lines, one concept). (P2026-10-15o-4)
- configuration.md § Circuit breaker restates error-handling.md and misses "Store failures only"; observability.md:29 says `error` fires only in the drain loop; act-tck README and tck-conformance.md hand-copy stale peer versions. Link instead. (P2026-10-15d-5)
- Leftovers: the `pre-push` hook (3 of 368 commits were direct pushes; CLAUDE.md:203 describes it wrongly), ~18 history comment lines in ci-cd.yml, two dead pointers in CONTRIBUTING.md. (P2026-10-15p-5)
- Four published exports tagged `@internal` (re-checked 2026-10-15, unchanged), plus act.ts:99-104 pointing operators at a deprecated constant. (P2026-10-15r-5)

## Self-changes

- 2026-10-15: specialists probe in their own file (`_probe-<lens>.spec.ts`). Two specialists used `_probe.spec.ts` at the same time and overwrote each other's probe once; one result was recorded before the file vanished.
- 2026-10-15: retired Core or decorator? (three runs, findings only) and Packages earn their place (four runs, no proposal); `metrics.sh` drops "published packages" (12 in every run, informed no decision). Two smells added from this run's probes: an idle test that counts successes, and a recovery promise resting on another mechanism's threshold.
- 2026-10-11: step 2 now asks, for a PR that changed a default or a timing, to grep docs, recipes and examples for the old behavior and run the recipes it touches; the Examples lens covers `recipes/**/examples/*.ts`; one smell added (a schedule entry removed before its work is done). #1872 changed retry timing and this run found three things it missed: the Prometheus recipe no longer blocks its poison stream (probed against the commit before), four doc and comment passages still describe lease-paced retries, and the defer timer drops due streams before its drain runs (probed).
Every change the retrospective made to `SKILL.md`, `lenses.md` or `metrics.sh`, with the evidence that prompted it.

- 2026-10-10 (same run, after probing): the Feature interactions lens now requires probing the interaction, the simulated fix and every cited number before ticketing. Probing turned o-3 from a refactor into a bug and showed its first fix was wrong (it broke the restart re-laning TCK case), showed o-4's fix wouldn't cover correlate, and corrected a count (9 → 7).
- 2026-10-10 (user request): the goal is now stated as the minimum set of orthogonal features that keeps every contract row. Added: two bar items (no feature reads another's config or cancels another layer's rule; every feature serves a contract row), an audit question, the Feature interactions lens, two smells, the interaction register above, and the `core files touching 5+ features` metric (9 today). The two ticket metrics merged into one row (both 0 for three runs). Prompted by the user after #1860 and #1862, both bugs where two features met.

- 2026-10-10: verified defects (a red test with a control, or a doc that contradicts the code) rank ahead of the cap; the 5–7 cap applies to simplifications. Seven undecided proposals filled the cap, and the pending rule would have pushed a reproduced bug to the backlog.
- 2026-10-10: `metrics.sh` counts files over 300 *code* lines beside the total. 21 files exceed 300 lines, but only 8 exceed 300 code lines; `types/ports.ts` is 190 code lines and 1,237 comment lines of public docs. Whether the bar should move to code lines is the user's call.
- 2026-10-10: the Examples lens now includes `@example` blocks in public doc comments; no check compiles them (the `Act.restore` example passes the wrong type).
- 2026-10-08 (full run): two smells added: a timer that only sets a flag (the #1804 pattern recurred in the defer timer), and a check that has never failed including its self-test (the snippet gate). The comment bar (25%) is left for the user to restate (P2026-10-08d-6); the skill says bars change only with the user.
- 2026-10-08 (fourth run): `metrics.sh` reports CLAUDE.md in KB, not lines. #1850 cut 3.3 KB and the line count stayed at 333, so the metric hid the change.
- 2026-10-08 (fourth run): the pass-through-layer smell now excludes the trace seams (`build_es`, `build_drain`). b-4 proposed deleting `DrainOps` under that smell; the user kept it (#1841).
- 2026-10-08 (fourth run): the Dead code lens lists knip's known false positives (bench scripts, recipe examples, the shared tsup config, release devDependencies, `pino-pretty`), so the next run doesn't re-verify 30 files.
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


### 2026-10-08 — weekly (one lens: Dead code)

| metric | morning run | now | why |
|---|---|---|---|
| core lines | 20339 | 20283 | #1841, #1852 |
| comments | 49% | 49% | |
| files over 300 lines | 21 | 21 | `act.ts` 2,098 → 1,993 (#1852) but still over |
| runtime exports / IAct / Act methods / Store methods | 54 / 8 / 20 / 18 | unchanged | |
| spec files / test lines | 235 / 60970 | 231 / 59968 | #1845, #1846 |
| CI workflows / lines | 7 / 986 | 6 / 919 | #1840, #1844 |
| docs lines | 9552 | 9402 | #1838, #1843, #1850 |
| CLAUDE.md | 333 lines, 46.6 KB | 333 lines, 41.6 KB | #1838, #1850 (lines hid the cut; the metric is now KB) |
| stability snapshot | 65,390 lines | 41,860 | #1839 |

Audit: 16 PRs since the morning run, 14 of them the run's tickets plus two flake fixes (#1847, #1848). One added a gate: #1853 checks behavior-contract citations in CI (the user's call on #1836; it found 54 broken citations, so it earned its place).

Decisions on the earlier 2026-10-08 proposals (all shipped):
- P2026-10-08-1 → #1845 (−424 lines net). P2026-10-08-2 → #1846 (−159). P2026-10-08-3 → #1850. P2026-10-08-4 → #1852 (act.ts −105; close path shared). P2026-10-08-5 → #1851, changed by the user from "trim" to "fix the docs" (−72).
- b-1 → #1838. b-2 → #1839, narrowed by the user: the walk follows re-exports only (one regex) instead of snapshotting names and types; 65,390 → 41,860 lines, not the promised names-only file. Don't re-propose the names-only snapshot. b-3 → #1840 (−229). b-4 → #1841, half rejected: the `DrainOps` / `build_drain` trace seam stays; only the 13 positional args and the second subscribe path went (−9 lines, not ~120). b-5 → #1842 (hello example added beside the calculator, +53). b-6 → #1843 (−94). b-7 → #1844 (−44). #1836 → #1853 (table kept, CI check added). #1837 → #1849 (−68).

Promises kept: tests and CI cuts matched or beat the estimates. Two missed: b-4 promised ~120 lines and removed 9 (the layer had a reason the proposal didn't name), and the CLAUDE.md "index" trim cut 9% of a 42 KB file.

Lens, Dead code (knip): almost nothing in core. Unused `export` keywords on ~13 internal names (five `DEFAULT_*` in `internal/config.ts`, three drain defaults re-exported from `internal/index.ts` that nothing imports through the barrel, `run_drain_cycle`, `DrainCycle`, `pii_gate`, `AUTOCLOSE_TARGET_PREFIX`, `BoundAction`, `ReactionOn`), act-tck's 2-line `fixtures/index.ts`, five act-diagram exports. Most of knip's 33 "unused files" are false positives (now listed in the lens).

Proposals (pending), ranked:
- P2026-10-08c-1. Make CLAUDE.md's "Safety-critical one-liners" one line each with a link (8.4 KB of 41.6 KB today; each is a paragraph repeating the linked doc). Target ~3 KB for the section.
- P2026-10-08c-2. Drop the unused `export` keywords and barrel re-exports above, and delete `libs/act-tck/src/fixtures/index.ts`. Internal only, ~15 names, 1 file.

Tickets (user: "open tickets for both"): #1855 (c-1), #1856 (c-2).

Self-changes: see the 2026-10-08 (fourth run) entries above.

### 2026-10-08 — full run (four specialists: hotspots + concepts, DRY + comment noise, tests, infra + newcomer + field)

Metrics: unchanged from the weekly run an hour earlier (master didn't move). No PRs to audit.

Decisions on P2026-10-08c-1..2: accepted, ticketed #1855, #1856.

Verified in the main loop before ranking: the defer wake bug (red probe: one deferred reaction on the default lane, one settle, 600 ms idle → 0 runs; control on a `cycleMs` lane → 1), against the promise in `close-policies.md` ("a per-worker timer … to wake the local worker promptly"); the snippet gate (`ts.createProgram([], { configFilePath })` → 0 root files, 0 diagnostics; parsing the same tsconfig → 229 files); InMemoryStore's two index maps (the only read feeds the other map, which nothing reads); act-pg `lease-loss.spec.ts` repeats 4 core test names. Corrected: `close-race.spec.ts` has one case with no core counterpart ("keeps a commit accepted after another app reseeded the stream"), so only its other case goes.

Newcomer test (first run): the README quickstart needs 22 concepts and 3 imports; `hello.ts` about 28 (it adds a reaction and settle).

Field: Marten compacts a stream with one explicit call (no policy or window); Kurrent trims with stream metadata and models closing the books in the domain; Axon and Kurrent park failed messages per sequence, as Act blocks streams; nobody has per-stream priority inside one processor (they use separate processors, i.e. Act's lanes). Act tracks progress per target stream where the others track it per processor or segment; that is the source of correlate and the subscription cap, a design choice and not a subtraction now.

Proposals (pending), ranked:
- P2026-10-08d-1. Make the defer/backoff timer run the drain instead of setting a flag (bug); reschedule in `drain`'s `finally` and delete the timer's self-re-arm branch; fix the `cycleMs` docs that promise latency without settle; add a contract row.
- P2026-10-08d-2. Fix the snippet gate (parse the tsconfig; self-test asserts the planted error) and run it inside the `ci` and `docs-build` jobs; delete `docs-snippets.yml` (−1 workflow, 54 lines).
- P2026-10-08d-3. Delete dead internal state: InMemoryStore's `_max_event_id_by_stream` / `_max_non_snap_event_id` (~36 lines), never-set `CorrelateCycleDeps.cold_start_back_scan` / `lease_millis`, `defaults.eventLimit`, test-only `DeferTimer.is_deferred`; fix their stale comments (~70 lines).
- P2026-10-08d-4. Tests: delete act-pg `lease-loss.spec.ts` and the duplicate close-race case (~330 lines), replace the 9 copies of `mark_all` with `subscribe(..., correlated_at)` (~250), drop the duplicate settle and notify cases and assert in the two empty tests (~50). Update rows 58, 59, 77, 237.
- P2026-10-08d-5. One filter helper per adapter: `query_streams` reuses `_filter_clause` / `_filter_predicate`, and `defer` / `reset` / `unblock` share one selection helper (~190 lines across 3 adapters; `InMemoryStore.query_streams` complexity 45 → ~12); move two misplaced doc blocks.
- P2026-10-08d-6. Comment pass on `internal/` and `adapters/` by category (keep public docs, shorten the why, cut restated code and essays; ~1,380 lines, 49% → ~46%), per file, non-comment lines byte-identical. With it, restate the bar: 25% for all of core is unreachable while `types/` (3,015 comment lines of public docs, kept by #1851) stays; propose `internal/` and `adapters/` under 30%.
- P2026-10-08d-7. Hotspot helpers: close-cycle's two hand-written page loops use `walk_streams` (~30 lines), and `event-sourcing.ts` gets `cache_put` / `cache_drop` for its four copies of "update the cache, warn on failure" (~20 lines, in `action()`, the top hotspot: complexity 60, 43 changes in 6 months).

### 2026-10-10 — full run (four specialists: file budget + reading path, core or decorator + public surface, source of truth + examples, process + packages)

| metric | 2026-10-08 | now | why |
|---|---|---|---|
| core lines | 20283 | 20280 | #1857 |
| CLAUDE.md | 41.6 KB | 36.8 KB | #1858 |
| everything else | | unchanged | |

Audit: two PRs since the last run, both its tickets. #1858 promised a ~3 KB section and delivered 3.4 KB; #1857 promised ~15 names and 1 file and delivered 11 names, 3 barrel re-exports and 1 file. Both kept their promises.

Decisions on P2026-10-08d-1..7: none yet; pending.

Verified in the main loop before ranking: the `onlyLanes` lost wakeup (red: two sharded workers sharing a broker, the worker without the lease drains before the lease holder marks, 0 runs, still 0 after the 5 s lease; controls: unsharded → 1, sharded with the lane's worker holding the lease → 1, lane set added to the lease key → 1); `writing-a-store.md` says a full truncate removes the subscription row (the code keeps it, and the same page says not to touch subscriptions); the act-http README maps `StreamClosedError` → `PRECONDITION_FAILED` (code: 410 → `NOT_FOUND`); the scaffold skill's `error.message === Errors.ValidationError` never matches (the code is on `name`); the `Act.restore` doc example passes an async generator where the parameter is an `EventSource`; `libs/act/README.md` lists `query_streams` and `query_stats` as `Act` methods (`Act` has neither); an act-tck release (1.38.21 → 1.38.22) with only a version bump in its own files and a snapshot change.

Not re-proposed: pointing the three public re-exports at leaf files to shrink the snapshot (decided in #1839: the lint rule requires the barrel).

Proposals (pending), ranked. Defects first; then the seven still-pending from 2026-10-08:
- P2026-10-10-1. Fix the `onlyLanes` lost wakeup: fold the sorted active lane set into the correlation lease key when `onlyLanes` narrows it (~3 lines), with the probe as a test and a contract row.
- P2026-10-10-2. Fix broken promises in docs and generated code, shrinking them where another page owns the topic: delete writing-a-store.md's "Splitting retirement" section and its four TCK sections that repeat tck-conformance and the act-tck README (~140 lines); shrink the act-http README's generated-API part to one example and a link (~140 net) and fix the `trpc/index.ts` doc comment; fix the scaffold skill's error check and replace its hand-rolled receiver dedup with `webhookMiddleware`, and cut its five sections that restate docs to one rule + link (~250); fix the `Act.restore` example and the README method list.
- P2026-10-08d-1..d-7 (still pending, unchanged): defer timer runs the drain; fix the snippet gate and fold its workflow; dead internal state; duplicate tests; one filter helper per adapter; comment pass by category; close-cycle and event-sourcing helpers (add: `close()`'s own correlate pass repeats the catch-up `_run_close` already does, −3 lines).

Tickets (user: "open tickets for all of them"): #1860 (10-10-1), #1861 (10-10-2), #1862 (d-1), #1863 (d-2), #1864 (d-3), #1865 (d-4), #1866 (d-5), #1867 (d-6, includes restating the comment bar), #1868 (d-7, includes the extra correlate in `close`).

### 2026-10-10 — weekly (one lens: Feature interactions, new)

Metrics unchanged from the full run earlier today, plus the new one: 9 core files touch 5+ features (`act.ts` 12, `types/ports.ts` 11, `in-memory-store.ts` 10, `drain-cycle.ts` 8, `audit.ts` 7, `types/reaction.ts`, `types/audit.ts`, `event-sourcing.ts` 6, `types/action.ts` 5).

Audit: #1870, #1871, #1872 (this morning's tickets, open). #1872 added coupling (P2026-10-10o-1, and `_last_options` under o-2).

Evidence: 143 fix commits in core and the SQL adapters over four months. By feature: close 16, defer 13, PII 13, lanes 12, notify 10. Of the 12 lane fixes, 7 were the lane-agreement machinery, not lanes (first count said 9; recounted when probing). Pairs: close × defer 3, notify × settle 3, breaker × settle 2, blocked × lease 2, correlate × lanes 2. The `Store` port carries the interactions: `subscribe` registers targets, raises marks, advances the checkpoint and takes the correlation lease; `claim` combines lane, priority, fairness, defer, blocked and the lease.

Probed before ticketing (user: "make sure you can probe all claims"). Each has a red test and a control; o-1 and o-3 also a simulated fix.

Proposals (pending), ranked, ticketed:
- P2026-10-10o-3 → #1876 (bug). A dynamic target changes lanes mid-run once correlate's LRU evicts it: with `maxSubscribedStreams: 1`, an equal-priority resolution naming another lane moved `t` from `a` to `b` with no log (control with 1000: stays `a`, logged). The store's `≥` rule is not removable: equal priority applying the lane is how a restart picks up an edited lane (TCK case). A strict `>` fixed the probe and broke that case. Options: read the row on a guard miss (internal), an explicit "set lane" on `subscribe` (port change), or stop priority moving lanes (design). The first proposal ("lane fixed once the row exists") was wrong as stated.
- P2026-10-10o-2 → #1875 (design question). Retry timing has two owners. On master, a no-backoff retry gap equals the claiming drain's lease (200 → ~200 ms, 800 → ~800 ms; control with backoff 100 ms: ~100 ms whatever the lease). On #1872 without `_last_options`, no-backoff retries stall after 2 attempts (a 10 s default lease), while a reaction-owned backoff keeps going.
- P2026-10-10o-1 → #1874. While the breaker is open, the wake's drain returns before `finally`, dropping the timer for streams still parked (red: timer gone, w2 never ran once the breaker closed without a drain; control and simulated fix: both fire). Not observable today: every breaker close is followed by a drain.
- P2026-10-10o-4 → #1877 (design question). A store whose correlate scan fails while `claim` works never opens the breaker when a `cycleMs` lane is claiming (red: `closed` after 8 failing passes; control without the lane: `open`). The proposed `DrainOps` feed would not have covered it: correlate reads outside `DrainOps`. Options: document it as a whole-store detector, a breaker per loop, or per-operation counts.

### 2026-10-11 — full run (four specialists: dead code + hotspots, concepts and options + DRY, tests by concept, infra + field)

| metric | 2026-10-10 | now | why |
|---|---|---|---|
| core lines | 20280 | 20293 | #1871 +18 (shard lease key, mostly doc comments), #1872 −5 |
| spec files / test lines | 231 / 59968 | 231 / 60166 | #1871, #1872 (default-backoff tests replaced lease-timing tests) |
| CI workflows / lines | 6 / 919 | 5 / 874 | #1870 folded `docs-snippets.yml` |
| docs lines / CLAUDE.md | 9402 / 36.8 KB | 9408 / 36 KB | |
| everything else | | unchanged | 54 exports, 8 / 20 methods, 18 Store methods, 14 ActOptions, 9 files touching 5+ features |

Open PRs not yet in these numbers: #1878, #1879 (~−600 test lines), #1880 (~−480 doc lines).

Audit: #1871, #1872, #1873 merged. #1872 (a fix on #1681's lease-timed retry) removed an interaction (`_last_options`) but this run found three things it missed, all ranked first below. #1878 (open) moves a dynamic target's lane to the store row; correlate's LRU only caches it.

Decisions on P2026-10-10o-1..4: o-1 accepted (#1874, shipped in #1872); o-2 accepted (#1875, shipped in #1872, default 10 s fixed); o-3 accepted (#1876, option 1, PR #1878); o-4 pending (#1877). Earlier tickets: #1860, #1862, #1863 shipped; #1861, #1865 in PRs #1880, #1879; #1864, #1866, #1867, #1868 accepted, deferred by the user ("leave refactors for later").

Promises kept: #1870 promised −1 workflow and ~54 lines, delivered −1 and −40. #1871 promised ~3 lines and added 18 (doc comments and threading the shard through; estimate the comments too). #1872 shrank source by 5 lines; tests grew 115.

Verified in the main loop before ranking: the Prometheus recipe reports `act_streams_blocked 0` on master and `1` on the commit before #1872 (a worktree at 2c2557190); the defer wake loses parked streams (red: a wake during an in-flight drain ran 1 of 2 streams, a wake with 15 due streams ran 10; controls with a fast handler and 5 streams ran all); `error-handling.md:297`, `concurrency-model.md:145` and the `next_attempt_at` comment still describe lease-paced retries; ci-cd's `on.paths` lists omit `behavior-contracts.md` and `scripts/check-contracts.mjs`, which its `changes` filter includes. Checked and downgraded: background drains claim with the lane's lease, not a per-call `leaseMillis` (`[60000, 10000]` on master), but the commit before #1872 never drained from the wake at all, so this is a doc gap, not a regression.

Field: none of Marten, Axon, Kurrent or Emmett orders claims across streams by priority; all use separate processors (Act's lanes). None has a store-level breaker; Axon, Marten and Emmett retry per processor or per operation. Act's 10 s default matches Kurrent's message timeout. Sources in the specialist notes (Marten async daemon and retries docs, AxonIQ 4.6 fault-tolerant processors, Kurrent persistent subscriptions).

Proposals (pending), ranked. Defects first:
- P2026-10-11a-1. Fix the defer wake (bug, #1872 incomplete): drop a due entry only after a pass that started after it came due claims nothing, and let the wake loop until a pass makes no progress (route it through `settle`, as the breaker's `on_retry` already does). The two probes become tests; the "fires at its due-time on an idle app" row gains them. The fix is reasoned, not yet probed.
- P2026-10-11b-1. Fix the Prometheus recipe (regression from #1872): give `fulfill` a short backoff, loop until the `blocked` event, drop `leaseMillis: 1` and its comment.
- P2026-10-11a-3. Fix prose that contradicts the code: `error-handling.md:297`, `concurrency-model.md:145`, the `next_attempt_at` and `DEFAULT_BACKOFF` comments; spell the fetch-failure delay through `compute_backoff_delay` (one spelling); the pg and in-memory `query_stats` comments describe filters the signature excludes. With it, b-2: say a per-call `leaseMillis` covers one call and a slow handler belongs on a named lane, and fix `budget_exhausted`'s advice. User call inside it: allow `withLane({ name: "default", leaseMillis })` (−2 lines).
- P2026-10-11d-1. Delete ci-cd's two `on.paths` lists (−22 lines) and let the `changes` job be the only filter: today a PR touching only `behavior-contracts.md` or `check-contracts.mjs` never runs `check:contracts`.
- P2026-10-11c-1. Delete adapter migration specs that `seed-upgrade.spec.ts` already pins (its header says so): act-pg and act-sqlite `lanes.spec.ts`, act-sqlite `priority.spec.ts`, the first describe of act-pg `priority.spec.ts` (~235 lines, 3 files; coverage probed at 100%; no row cites them).
- P2026-10-11b-3. Drop the 93 `leaseMillis: 1` literals in 19 test files, left over from lease-paced retries (they now read as if they matter, which misled the recipe); keep the lease-loss cases. After #1879.
- P2026-10-11a-4. Delete dead code outside core: `digit-board.ts` `main()` (104 lines), two unreferenced act-diagram data files (121), act-pg deps in `packages/client` and `packages/server`, act-tck dev dep in act-otel (~230 lines, 4 deps). With it, a-2: `AuditDeps.logger`/`states` and `DEFAULT_SHUTDOWN_GRACE_MS` (a second name for `DEFAULT_LEASE_MILLIS`), ~12 lines (could join #1864).
- P2026-10-11c-2/3. Merge `shutdown-grace` + `shutdown-settle` (one `park(kind)` helper, the four `< 50 ms` checks become gate-based; ~−80) and the four target-ownership specs (~−120, 3 files); test names kept, rows change only their file cell.
- P2026-10-11d-2. Move `node-compat` (Node 22 + 24) to the weekly conformance workflow: 3 failures in 100 runs, none `ci` missed; ~4 runner-minutes per run. Only 5 days of history.

Tickets (user: "open tickets for all of them, and take care of the regression in master"): #1889 (b-1, fixed in #1891), #1890 (a-1), #1882 (a-3 + b-2 + b-4), #1883 (d-1), #1884 (c-1), #1885 (b-3), #1886 (a-4 + a-2), #1887 (c-2 + c-3), #1888 (d-2).

### 2026-10-15 — full run (four specialists: feature interactions + concepts, reading path + file budget + public surface, source of truth + examples, process + packages + core or decorator + infra)

| metric | 2026-10-11 | now | why |
|---|---|---|---|
| core lines (libs/act/src) | 20293 | 18934 | #1909–#1911 comment trims (~−1,600 incl. act-pg), #1907, #1908, #1912; +84 #1913, +57 #1878, +18 #1892 (bug fixes) |
| comments | 49% | 46% (internal/ 33%, adapters/ 14%; bar 30%) | #1909–#1911; the user closed #1867 before internal/ reached the bar |
| spec files / test lines | 231 / 60166 | 225 / 59564 | #1896, #1897, #1879, #1907 |
| CI workflows / lines | 5 / 874 | 5 / 850 | #1893, #1894 |
| docs lines / CLAUDE.md | 9408 / 36 KB | 9278 / 36 KB | #1880, #1898 |
| everything else | | unchanged | 54 exports, 8 / 20 methods, 18 Store methods, 14 ActOptions, 9 files touching 5+ features |

Audit: 23 PRs since the last run, every code PR one of its tickets. Three added mechanism, each for a probed bug: #1878 (+57, correlate reads the row on an LRU miss), #1892 (+18, keep a due entry until a drain reaches it), #1913 (+84, app errors contained where they run). #1913 went through three designs in one PR (document it; tag app errors and add a pause breaker; contain them at the source); the third was smallest. It also copied `finalize`'s retry-or-block rule instead of calling it (o-2 below).

Decisions on P2026-10-11*: all accepted and shipped. a-1 → #1890/#1892; b-1 → #1889/#1891; a-3 + b-2 + b-4 → #1882/#1898; d-1 → #1883/#1893; c-1 → #1884/#1896; b-3 → #1885/#1899; a-4 + a-2 → #1886/#1895; c-2 + c-3 → #1887/#1897; d-2 → #1888/#1894. From 2026-10-08/10: d-3 → #1907, d-5 → #1908, d-6 → #1909–#1911 (user then closed #1867: rest of internal/ not trimmed), d-7 → #1912, o-3 → #1878, o-4 → #1913 (became a bug fix: app code errors had been counted as store failures).

Promises kept: d-1 −22 → −25; c-1 ~−235 → −229; a-4 ~−242 → −253; c-2/3 ~−200 → −333; d-3 ~−70 → −112; d-5 ~−190 → −162; d-6 ~−1,380 → ~−1,600 lines, 49% → 46% as estimated; d-7 ~−50 → −47. b-3 removed literals, not lines (net 0), as promised. All within or beyond the estimate.

Verified in the main loop before ranking (red + control each): a burst of 12 commits wired as the README shows (`app.on("committed", () => app.settle())`) whose handler defers once ran 5 of 12 reactions after 3.5 s idle (plain control 12/12; the "fails once" variant ran 12/12 here and 10/12 for the specialist: timing-dependent); one rejected `ack` while a reaction defers leaves it never re-firing on an idle app (control fires); a writer and an idle worker sharing a store without notify: the worker runs 0 reactions in 1 s (control with `start_correlations` runs 1), against README.md:70's "falls back to a polling debounce"; arrow-function handlers throw "must be a named function" at build (control: named function builds); the `correlate` and `query` `@example` blocks in act.ts name fields that don't exist (`leased`, `name`); `_reactive_events` is read only for `.size` (7 reads).

Field: Marten's daemon runs each shard to the high-water mark, so "idle" means no more events, never "nothing succeeded" (martendb.io async daemon docs). Marten pauses only the failing projection on a code error; Act can't without per-reaction checkpoints, so a throwing resolver stops discovery for every reaction (#1913, the user's choice).

Proposals (pending), ranked. Defects first (outside the cap):
- P2026-10-15o-1 + d-2. Pending work goes idle. (a) A pass counts as idle only when its claim returned nothing: the controller disarms only in the `!cycle` branch, settle's progress uses `drain.leased`, and the defer wake drains until a pass leases nothing (simulated: 6/6, 23/23, 12/12; one internal-flag test rewritten). (b) A failed finalize keeps a wake at the leased streams' lease expiry, so close-cycle.md:283 ("the breaker's paced retry probe re-drives settle()") becomes true; or, the user's call, correct the three passages that promise it. Two idle rules become one.
- P2026-10-15d-1. 31 doc, README and scaffold-skill examples pass arrow functions to `.do(...)`, which throws at build; rewrite as named functions and state the rule once in state-management.md.
- P2026-10-15d-4. README.md:70's polling fallback doesn't exist; with it, the backlog's quickstart cut (22 → 20 concepts, link `hello.ts`) and the ticket-cooldown recipe's broken Run line.
- P2026-10-15r-3. Fix the three `@example` blocks in act.ts that don't compile; then keep at most one example per public method where docs/docs has no checked equivalent, `@see` the rest (up to ~1,270 lines across 147 blocks; how many to keep is the user's call).
- P2026-10-15d-3. correlation-and-drain.md:102 says the store keeps a forgotten target's lane (stale since #1878); configuration.md § Re-laning at restart owns the rule, the other two pages link (~3 KB).
Simplifications:
- P2026-10-15o-2 (= r-2). One retry-or-block decision: `resolver_failed` and the fetch-failure branch call `finalize` (moved to internal/) instead of copying it (−35 lines, 2 names; #1913's copy).
- P2026-10-15p-1. Move `all-packages-stability.spec.ts` and its snapshot out of act-tck to a root `test/` (77 of 130 act-tck releases in 3 months published identical code; 5 of 7 since 10-11).
- P2026-10-15r-1. One "this app reacts" boolean instead of the `_reactive_events` Set and five call-site guards (−12 lines, one concept).
- P2026-10-15o-3. Replace the adaptive lag/lead ratio with a fixed split: −`drain-ratio.ts`, its spec, a field and a doc section (~−125 lines); serves no contract row, forcing 0.5 fails only its own unit tests. Needs a CI pg bench before merge.
- P2026-10-15p-2. Scenario benches weekly; drop the in-memory core perf gate (0 failures in ~887 runs, laptop baseline) and BENCH.md (~−500 lines, ~250 runner-minutes per two weeks off PRs); pg and sqlite gates stay.
- P2026-10-15p-4. Delete docs/versioned_docs/version-1.x (33 files, 7,256 lines; still describes pre-#1811 polling) and the version dropdown.
- P2026-10-15p-3. Delete .claude/README.md (209 lines) and point the three subagents at CLAUDE.md instead of restating it (act-code-reviewer checks public fields against the wrong casing rule).

Design findings, not proposed: one throwing resolver stops discovery for every reaction (documented, #1913); every runnable example needs `app.on("committed", () => app.settle())` (13 copies; making `do()` settle would change what apps observe); priority (required `prioritize`, 13 TCK cases) stays a question for a future major.
