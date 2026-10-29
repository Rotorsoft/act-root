# Simplify-core history

The skill's memory. Read it first on every run; the retrospective (step 7) updates it. Newest run last.

## Lens rotation

Least recently run goes next. A lens with no accepted proposal in its last three runs is retired (it can be revived with a reason).

| lens | last run | runs | accepted | status |
|---|---|---|---|---|
| Public surface | 2026-10-27 | 7 | 2 | active (no new surface; published doc comments still describe an action as needing an event and invariants as holding after it) |
| Dead code (tool) | 2026-10-29 | 8 | 5 | active (the `patch_fn` plumbing #2180 left with one value; four doc blocks stacked above the wrong declaration) |
| Hotspots (tool) | 2026-10-20 | 5 | 1 | retired 2026-10-20: two runs with no proposal; every branch in the hot functions (correlate, action, drain) is a separate rule |
| File budget | 2026-10-27 | 8 | 1 | active (9 over 300 code lines; act.ts still seven concepts) |
| Comment noise | 2026-10-29 | 8 | 6 | active (act-http 50% comments, 51 ticket refs; 85 ticket refs outside core) |
| Concepts and options | 2026-10-27 | 8 | 3 | active (`validateFoldedState` refuses after the commit; `start_correlations({ limit: 0 })` reads 100) |
| Core or decorator? | 2026-10-15 | 3 | 0 | retired 2026-10-15: three runs, findings only (PII, audit, breaker, lanes stay; priority is a major-version question) |
| DRY across adapters and builders | 2026-10-29 | 8 | 9 | active (`check_invariants` copies `validate` and drifted; the SQL recovery writes wrap driver errors one of five ways) |
| Reading path | 2026-10-27 | 7 | 3 | active (13 runtime files, ~33 names; `Query` still travels the internal correlate path for one field) |
| Newcomer test (quarterly) | 2026-10-17 | 2 | 0 | active (21 concepts, 3 imports; a package.json without name/version crashes) |
| Tests by concept | 2026-10-29 | 8 | 10 | active (an awaited void `settle()` before a "no reaction ran" check; five tests #2180 left pinning nothing new) |
| Mutation evidence (monthly, CI) | never | 0 | 0 | retired: setup removed (#1805), see baselines below |
| Packages earn their place | 2026-10-15 | 4 | 0 | retired 2026-10-15: four runs, no proposal (removal is ruled out; act-tck churn is the snapshot, now P2026-10-15p-1) |
| Infra | 2026-10-27 | 8 | 2 | active (three report-only conformance steps) |
| One source of truth | 2026-10-27 | 8 | 8 | active (the scaffold skill's rules section twice, one copy teaching a `throw`) |
| Examples | 2026-10-27 | 7 | 3 | active (the scaffold seed's fixed three correlate/drain rounds) |
| Process | 2026-10-27 | 7 | 9 | active (PR template in 0 of 300 PR bodies; 17 shipped RFCs still `draft`) |
| Feature interactions | 2026-10-29 | 8 | 11 | active (#2180's schema check refuses redacted state; reaction commits skip the guard the docs say leases replace) |

## Interaction register

Where two features meet, and why. The Feature interactions lens reads this first: a justified entry is not re-proposed unless its reason stops holding; an accidental one stays here until a proposal removes it.

| features | where they meet | kind | reason |
|---|---|---|---|
| defer, backoff, autoclose | the persisted `deferred_at` schedule and the per-worker wake | shared primitive | one schedule serves all three |
| retry budget, breaker | `claim` raises `retry`; the drain skips the block while `store_failing` | justified | counting at claim makes a handler that crashes the worker spend its budget; a store outage must not |
| close, drain | a reaction's close request runs after the drain's `ack` | justified | the close guard must see the requesting reaction caught up |
| correlation lease, lanes / explicit correlate / shutdown / checkpoint | lease key includes the `onlyLanes` shard; `app.correlate()` skips the lease; shutdown hands it back last; the key selects the checkpoint row | justified | N workers otherwise read and mark every event N times (#1532) |
| defer, retry count | ack, reset, unblock and defer store `retry: -1` | justified | -1 is the stored "no attempt yet" value in all three adapters, pinned by the TCK and documented in `ports.ts`; not a one-off sentinel (re-checked 2026-10-17) |
| retry timing, lease | removed by #1872: every retry is paced by the reaction's backoff (default fixed 10 s); the lease only keeps workers apart | resolved | P2026-10-10o-2, #1875 |
| lanes, priority | `subscribe` re-lanes on priority ≥ stored (how a restart applies an edited declared lane); correlate reads the row when it has no record, so the row owns a dynamic target's lane and the LRU only caches it | justified once #1878 merges | P2026-10-10o-3, #1876; the coupling itself goes only if priority does (major-version question) |
| breaker, drain / settle | five places feed one consecutive-failure count of **store** failures; a success in one loop resets failures in another | justified | #1877: app code never leaves the loop that ran it (correlate stops before a throwing resolver's event and logs once, drain fails the stream, a reaction close logs non-store failures), so only store and framework errors reach the breaker; a real outage fails every loop; a store failing one kind of call can keep it closed, still visible as `error` events |
| defer wake, breaker | fixed by #1872: the breaker check sits inside the drain's `try`, so `finally` re-aims the wake | resolved | P2026-10-10o-1, #1874 |
| defer wake, drain lock / streamLimit | resolved by #1928: only an empty claim is idle; the wake drains until a pass leases nothing | resolved | P2026-10-15o-1 |
| drain failure, wake | a failed drain pass retries at `max(leaseMillis, cooldownMs)` (#1928) and a failed settle pass through the breaker's `on_retry` (#1950) | resolved | #1928, #1950 |
| app errors, correlation | one throwing resolver stops the scan before its event, so discovery stops for every reaction until it stops throwing | justified | #1913, the user's choice: nothing is lost; isolating one reaction needs per-reaction checkpoints |
| lease, lanes | background drains claim with the lane's `leaseMillis`; a per-call `leaseMillis` covers only that call | resolved | documented by #1898 (`error-handling.md`, `configuration.md`) |
| drain `RETRY` wake, breaker cooldown | the drain reads `breaker.cooldown_ms` and retries at `max(leaseMillis, cooldownMs)` | justified | the breaker doesn't know the failed pass's leases (dropping the lease floor fails a defer-outcome case), and a lease-only retry spins with a 1 ms lease (two `store-failure-budget` cases) |
| defer wake loop, shutdown | the wake drains in a loop that never checks `_stopped`; shutdown waits for one pass | resolved | #1950 |
| `_reactive`, lane arming | `_reactive` is `event_to_lanes.size > 0` | shared primitive | #1937 |
| settle loop, shutdown | a stopped drain claims nothing and a released lease stays released (#2001); a late renewal reply is dropped (#2025) | resolved | #2001, #2025 |
| notify disposal, shutdown order | shutdown stops every scheduler before awaiting the disposer | resolved | #2001 |
| armed flags, in-flight scan or claim | an empty result lowers only the raises it saw (`_raised`/`_lowered`) | resolved | #2025 |
| restore (`restart()`), in-flight correlate scan | the restore waits for the passes in flight (`_passes`) and a pass that starts during it returns idle (`_restoring`) | resolved | #2072 (P2026-10-22-1) |
| restore pause, shutdown epoch | restore waits for passes in flight; shutdown's lease release bumps `_epoch` instead | justified | shutdown has a grace ceiling and restore doesn't: making the release wait too and dropping `_epoch` hangs 16 shutdown tests (simulated 2026-10-23) |
| `start_correlations` tick, lane arming | the tick arms every lane (#1973): one empty claim per active lane per tick on an idle app (12 per 205 ms at 10 ms, 0 for `drain: false`, only owned lanes under `onlyLanes`) | justified | the cost of reclaiming a dead worker's expired lease |
| `autoSettle`, `cycleMs` | with `autoSettle` on, a lane's `cycleMs` tick finds nothing settle hasn't drained (52 vs 53 ms, 0 extra claims) | justified only with `autoSettle: false` | P2026-10-18s-2 (docs); the option is published and stays |
| `autoSettle`, `maxPasses` | each reaction commit schedules a new pass with no options, so `maxPasses` doesn't cap a chain that keeps committing | resolved (documented) | #1973 |
| writer-only app, notify | `_wake` arms lanes on a `drain: false` instance too; nothing there reads the armed flag | shared primitive | #1978; harmless (probed) |
| restore, other workers on the store | another process keeps the correlation lease and scans from its old checkpoint: 10 of 20 restored events run (control, one worker: 20 of 20) | justified, documented | the `Store.restore` port doc says to restart other processes; the user docs don't yet (P2026-10-22-2) |
| restore, drain in flight | the in-flight `ack` writes nothing into the restored store | harmless | InMemory probe 3 of 3; Postgres not probed |
| correlate outcome, lane arming / settle progress | Act arms on `marked > 0` and settle counts `read` | resolved | #2084 (P2026-10-22f-2); `subscribed` stays only in `app.correlate()`'s public return |
| explicit correlate filter, shared checkpoint | the scan reads only `limit` | resolved | #2106 (P2026-10-23-1) |
| `app.correlate` default, a query without `limit` | the default `{ limit: 10 }` sits on the parameter, so `{}` or a leftover `{ stream }` reads the whole log while the JSDoc says 10 | accidental | P2026-10-25-2 |
| `.given`/`.requires`/`on`, partial-state merge | `merge.ts` skips the duplicate-action check on schema identity, so two partials sharing one action schema merge silently: one partial's rules with the other's handler, by order | accidental, and a bug | P2026-10-25-1 (probed in the main loop); goes when the check keys on the handler |
| `.requires`, per-action retry | the `ConcurrencyError` retry re-runs `load` and every rule | shared primitive | probed; no test pins it yet (P2026-10-25-5) |
| `.requires`, sensitive fields | one actor-gated snapshot feeds `given`, `requires` and `.emit` | shared primitive | probed: both see `[REDACTED]` for another actor |
| `.requires`, act-http errors | the class map gives 409 `INVARIANT`; only the message names the layer | shared primitive | `rule` is a constructor argument, not a field |
| empty block/ack skipped (#2117), breaker / lifecycle | a pass that only blocks makes no ack call and emits no `acked`; `breaker.passed()` still runs | harmless | probed |
| `start_correlations` limit, `Query.limit` | the poll stores `query.limit \|\| undefined`, so `0` ("no limit" everywhere else) becomes settle's default 100 | justified, documented | #2173: the user kept the code and documented that a poll's 0 uses the background default |
| `validateFoldedState`, commit | #2180 folds once before the commit and checks the state schema there; the option is ignored | resolved | #2180 (P2026-10-27-1) |
| state schema check, sensitive fields / forget | `action()` checks the actor's view, so `[REDACTED]` or `[SHREDDED]` fails a typed field (`z.email()`): another actor's action is refused, and after `forget` every action is | accidental, a regression from #2180 | P2026-10-29-1 (probed in the main loop; passes on 10fa801c9) |
| reactions, optimistic concurrency | `reactingTo ? expectedVersion : expected` lets a reaction commit on a stale load; the docs say leases serialize these writes, but a lease is per reaction target, not per stream written (wolfdesk's three timers write one ticket under three targets), and never against user actions | accidental; the documented reason no longer holds | P2026-10-29-2 (probed: a stored state breaks `max(2)`, then every action fails) |
| first commit, optimistic concurrency | `snapshot.version >= 0 ? … : undefined` leaves a new stream unguarded, so two racing creators both pass `.requires` | accidental | P2026-10-29-3 (probed) |
| state check, payload check | `check_invariants` re-implements `validate` with `safeParse` and drops its wrap of non-Zod throws | accidental | P2026-10-29-4 (probed: raw `Error`, HTTP 500, vs `ValidationError`, 422) |
| projection folds, `Act` constructor `patch_fn` | the constructor's patch step reaches `load`/`action`; projection folds always get `bare_patch` from the builder | harmless (one value in the repo since #2180) | P2026-10-29s-1 |

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

- history.md has no budget (119 KB; run entries before 2026-10-22 are 69 KB, read by every run and specialist): keep the tables, the backlog, the self-changes and the last three runs, and fold each older run into one line with its tickets and rejections (~−64 KB). A change to the skill's memory: the user's call. (P2026-10-27p-3)
- The root `format` script is a subset of `lint:fix` and nothing references it (−1). (P2026-10-27p-5)

- `export *` over `ports.ts`, `utils.ts`, `config.ts` publishes anything added there without an RFC. (The `@internal` tags half is P2026-10-23-3.)
- Design finding for a future major: priority (required `prioritize` port method, a column and two indexes per SQL adapter, a fairness reserve in 3 claims, the lane-rides-priority rule in 3 subscribes, 7 bugs) has no example user in this repo and no counterpart in other ES frameworks, which use separate processors (Act's lanes). Removing it is breaking; it is the user's question. 2026-10-11: Marten (per shard), Axon (per processor/segment), Kurrent (per group) and Emmett (per processor) all answer "a slow reaction must not block a fast one" with separate processors and none orders claims by priority; priority touches 13 source and 26 test files (2026-10-27: ~12 and 19), and dropping it also drops the lane/priority coupling behind #1599 and #1876.
- act-http tests: drop the tRPC and Hono error tables that repeat the parity table and `api/errors.spec.ts` (~170 lines); `audit.spec.ts` collector helper and shared `meta` (~140 lines).

- act-pg / act-sqlite `pii-encryption.spec.ts` run the same 9 cases (~238 shared lines): delete the sqlite `query_stats` duplicate of a TCK case now; moving the rest into a TCK capability adds act-tck surface and needs an RFC (~−400 net, unprobed). (P2026-10-11c-5)
- PostgresStore `commit`'s single-event SQL fork (4 statement variants → 2) if a CI bench shows it doesn't pay; `commit` is the most-changed function in the most-changed adapter. (P2026-10-11a-5)
- PostgresStore.commit returns the caller's pii instead of decrypting what it just wrote (one AES-GCM decrypt per pii event per commit, ~−7 lines). Apps see no change (the framework revives dates); direct `Store` callers would get the input value instead of an ISO string, as sqlite and InMemory already return. The user's call. (P2026-10-20b-5)
- One shared pii-encryption suite for act-pg and act-sqlite in an unpublished root `test/` file (~−390, a new cross-package test pattern; sqlite gains the declined-payload case). (P2026-10-20b-3, was P2026-10-11c-5)
- 53 core specs define their own `Counter` (~−140 with a shared fixture, but shared fixtures couple tests).
- Re-measured 2026-10-23 after #2072: moving restore's `scan` out alone takes event-sourcing.ts 467 → 338 code lines (still over 300) for +8 net; the lane half was +36 and act.ts is unchanged since. Still plainer, not smaller. Move lane wiring out of act.ts into `internal/lanes.ts` and restore's `scan` to `internal/restore.ts` (re-measured and simulated 2026-10-18: act.ts 811 → 647 code lines, event-sourcing.ts 467 → 338; +2 files, +36 code lines net, suite and coverage green). Plainer, not smaller. First close the test gap it found: removing the dry-run guard on restore's restart and arm keeps the suite green. The settle-drain half moved into P2026-10-18s-1. (P2026-10-15r-4, P2026-10-18b-2)
- configuration.md § Circuit breaker restates error-handling.md and misses "Store failures only"; act-tck README and tck-conformance.md hand-copy stale peer versions. Link instead. (P2026-10-15d-5; the observability.md half is in P2026-10-20r2-2)
- Design finding: the defer wake's "drain until a pass leases nothing" loop repeats settle's loop without correlate (the background-copies-foreground smell); routing it through settle adds `settled` events and a correlate per wake, so it doesn't subtract today.
- Resolved by #1959 (P2026-10-17d-2 → #1949): a local `do()` arms lanes but schedules nothing, while a remote commit (`_wire_notify`) already schedules settle; 22 copies of `app.on("committed", () => app.settle())` in 17 files exist only to close that gap, and no framework in the field asks for it (Marten, Emmett, Axon, Propulsion run processors on their own). Changing it changes what apps observe.

- Workflow and Renovate comments cut to their why: workflow comment lines 164 → 43, `renovate.json` 5.1 → 2.8 KB (ticket-history rule descriptions). Same kind as #2075, outside core. (P2026-10-23p-2)

## Self-changes

- 2026-10-29: one smell added: a check added to the write path without a pass over every feature that changes what it reads (#2180's schema check read the actor-gated view, so redaction and erasure turned into refusals, and a guardless reaction commit let it pass on a stale load). The Comment noise lens names the stacked-doc check (a JSDoc block closed and another opened right after it: four found, one shipping a published class with no doc). `metrics.sh` counts ticket refs case-insensitively (`act-1103` was missed). The Dead code lens lists `libs/act-pg/scripts/drain-contention.ts`.

- 2026-10-27: two smells added. A server-only import in an entry point browser code imports, dynamic ones included: a bundler builds a literal `import()` into its own chunk, and the browser build fails there (#2154 shipped the variable-path workaround first, then removed the import; the gate's header said dynamic imports were safe). A fake clock jump in a test that stands in for a lease or schedule but not for the real-time timer behind it (#2119's fix flaked again; #2153 re-arms the lane). The Examples lens names a downstream build: the Risk upgrade found the browser build failure, an act-pg major that no longer fits `Store`, and an act-sse patch release that dropped four methods, none visible in this repo's CI.

- 2026-10-25: the Tests by concept lens names time-budget tests (a fixed sleep or pass count before an assertion; a "not yet" check inside a real-clock window) and how to prove one (an injected stall and a control). Three such tests flaked in two days and the sweep found six more. Two smells added: a test that waits a time budget instead of an outcome, and a feature added beside an existing one by copying its shape in every layer (#2115). learnings.md merges the debounce-racing entry into a general time-budget rule and gains the copied-layer and shared-value-dedup lessons.

- 2026-10-23: the Examples lens names the diagram sources #2092 added (`docs/src/scenes/*.ts`, the Mermaid blocks) and the flow specs (`docs/flows/*.flow.json`): they describe timing and outcomes, nothing compiles them against the code, and the settle scene shipped with the debounce backwards and went stale again a day later (#2084). Two smells added: a timing word explained from its usual meaning instead of the scheduling code (the scene), and a per-call option that narrows a read on a path that advances shared state (P2026-10-23-1). learnings.md gains those two and the debounce-racing test (P2026-10-23-2).

- 2026-10-22: three smells added to `lenses.md` from how the user reshaped the previous run's proposals: removing a check as a duplicate (s7: `check:readmes` and the snippet self-test kept), stripping accessors that make state read-only (s3: encapsulation kept), and a cleanup step that moves a responsibility between features (s2: #2046 grew to +44 before review trimmed it). learnings.md gains the interleaving lesson from P2026-10-22-1 and the cleanup-growth and duplicate-check lessons.

- 2026-10-20 (second run): the proposal template's "Removes" numbers are measured after `biome check --write`. P2026-10-20s-5 promised −11 from an unformatted simulation and shipped +15.
- 2026-10-20: retired Hotspots (two runs with no proposal). The Dead code lens lists knip's newer false positives (the evidence scripts, the k6 script, the webhook-receiver demo, the act-pg stress worker, skill scripts, docs and recipes dependencies). A smell added: a "does nothing" claim checked by reading the call site. #1976 judged tests by their body and dropped `autoSettle: false` from 17 tests whose helper walks the pipeline; making the public `drain()` throw under auto settle found all 28 such tests in one run.
- 2026-10-18: `metrics.sh` reads `ActOptions` from `types/act.ts`; #1959 moved it there and the guard row read 0. The Examples lens now names doc snippets marked `no-check`: the production rebuild flow in projections-to-database.md calls `app.once`, which `Act` doesn't have, and nothing compiles it.
- 2026-10-17: specialists simulate source edits only in their own `git clone --shared` under the scratchpad. One specialist edited `circuit-breaker.ts` in the shared tree while another was running the quickstart against it.
- 2026-10-17: the bar's "every feature serves a contract row" now exempts performance mechanisms, which a real-adapter bench judges. P2026-10-15o-3 (drop the adaptive lag/lead ratio, "serves no row") was rejected because removing it could break a performance feature.
- 2026-10-17: two smells added from this run's probes on #1928: a loop in a background path that doesn't check the stop flag each turn, and a fix for one failure path that leaves its sibling loops. The Dead code lens drops the deleted `BENCH.md` and lists three more knip false positives. `metrics.sh` merges IAct / Act / Store / ActOptions into one guard row: unchanged in all seven runs.
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

Correction (while fixing #1890): the second defer-wake probe (15 due streams, 10 run) was wrong, and the main loop's check repeated its setup instead of questioning it. One `app.correlate()` reads 10 events by default, so 5 of the 15 targets were never subscribed. With all 15 correlated, every stream runs with or without the fix. Only the in-flight-drain case was a bug.

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

Tickets (user: "all"): #1915 (o-1 + d-2), #1916 (d-1), #1917 (d-4), #1918 (r-3), #1919 (d-3), #1920 (o-2), #1921 (p-1), #1922 (r-1), #1923 (o-3), #1924 (p-2), #1925 (p-4), #1926 (p-3).

### 2026-10-17 — full run (four specialists: dead code + hotspots, DRY + comment noise + feature interactions, tests by concept, newcomer + field)

| metric | 2026-10-15 | now | why |
|---|---|---|---|
| core lines (libs/act/src) | 18934 | 18224 | #1930 (−1,597 `@example` lines), #1936 (−31), #1937 (−5); +14 #1928 |
| comments | 46% (internal/ 33%, adapters/ 14%) | 44% (33% / 12%) | #1930 |
| spec files / test lines | 225 / 59564 | 225 / 59638 | #1928 tests (+81) |
| CI workflows / lines | 5 / 850 | 5 / 829 | #1935 |
| docs lines / CLAUDE.md | 9278 / 36 KB | 9275 / 36 KB | #1932; #1933 removed 7,389 lines of versioned docs (not counted by the metric) |
| everything else | | unchanged | 54 exports, 8 / 20 / 18 / 14, 9 files touching 5+ features, 21 / 8 files over 300 |

Audit: 10 PRs since the last run, all its tickets. Only #1928 added mechanism (+14 source lines: a `RETRY` wake, a `cooldown_ms` getter, a wake loop), and it is a fix on #1892 in the same file. This run found two bugs it left: the new wake loop ignores shutdown, and it fixed the "failure leaves no wake" bug only in the drain, not in settle, which feeds the same breaker.

Decisions on P2026-10-15*: o-1 + d-2 → #1915/#1928; d-1 → #1916/#1927; d-4 → #1917/#1929; r-3 → #1918/#1930 (one example per doc comment); d-3 → #1919/#1932; o-2 → #1920/#1936; p-1 → #1921/#1931; r-1 → #1922/#1937; p-2 → #1924/#1935; p-4 → #1925/#1933; p-3 → #1926/#1934. o-3 rejected (#1923 closed): "your proposal can actually break a feature"; the adaptive ratio is a performance mechanism, and "serves no contract row" doesn't apply to those (now in the bar).

Promises kept: o-2 promised −35 source lines, delivered −31; r-1 promised −12, delivered −5 (source; −9 with tests); r-3 promised up to ~1,270, delivered −1,597; p-2 ~−500 → −511; p-4 7,256 → −7,389; p-3 209 → −206; d-3 ~3 KB → 13 lines; p-1 moved files (+3), as promised. o-1 + d-2 promised "two idle rules become one" and kept it, but shipped two new defects (P2026-10-17-1, -2): probe the shutdown and every sibling loop when a fix adds a loop or a retry.

Verified in the main loop before ranking (red + control each, my own probe file): one rejected `store.query` during settle's correlate with `cooldownMs: 100` → 0 runs in 800 ms (control 1); three streams deferred to one due-time on a `streamLimit: 1` lane with an 80 ms handler, `shutdown()` during the woken pass → 2 handlers ran after shutdown resolved (control with `streamLimit: 10` → 0); both one-line fixes together turn both green and `libs/act` passes 1,533/1,533. The README quickstart in a project whose package.json is `{"type":"module"}` throws `ERR_VALIDATION … name` (with name and version: runs). `correlation-and-drain.md:40,168` and `close-cycle.md:92` still describe `reactiveEvents`; `backoff.ts:6` names `reactions._finalize`; `ports.ts:959` says `retry_count = 0` (adapters write -1); `libs/act/README.md` and `docs/docs/intro.md` keep the old lambda `.emit` quickstart and "dead-lettering"; wolfdesk wires `committed` to a bare `drain()`; act-pg's `scopedTypes` JSONB parser equals pg's default since #1570. Corrected: InMemoryStore has 18 simulated-latency sleeps, not 4.

Newcomer test: the root README quickstart needs 21 concepts and 3 imports (was 22); two are hidden (installing the `zod` peer, package.json `name`/`version`). `hello.ts` about 27 and prints its result twice.

Field: every framework checked owns its infrastructure retry in one place with one timer (Emmett fixed 100 ms resubscribe; Propulsion a fixed read-failure sleep; Axon 1 s doubling to 60 s, or a 5 s claim interval; Marten Polly per operation); none pairs a breaker with a second retry timer. None asks the app to trigger processors after a commit: Marten and Emmett run inline projections in the append transaction and async ones in a daemon; Axon starts processors with the app. Sources in the specialist notes.

Proposals (pending), ranked. Defects first (outside the cap):
- P2026-10-17-1. After any store failure the breaker re-drives settle at `cooldownMs`, not only once open: drop `if (circuit === "open")` in `CircuitBreaker.failed` (one condition); one rule in `error-handling.md`, `configuration.md` and the `on_retry` doc; the probe becomes a test and a row. Keep the drain's `RETRY` (justified, register).
- P2026-10-17-2. The defer wake loop stops at shutdown: `while (!this._stopped && …)`; the probe becomes a test under the shutdown row.
- P2026-10-17-3. A package.json without `name`/`version` must not crash the first `log()`: `get_package` falls back field by field (`{ ...FALLBACK_PACKAGE, ...parsed }`), as it does for a missing file.
- P2026-10-17-4. Prose that contradicts the code: the three `reactiveEvents` passages, `backoff.ts:6`, `ports.ts:959`, settle's termination comment (a zero backoff keeps a stream claimable); the two stale quickstart copies and "dead-lettering"; an install line in the root README; wolfdesk's `committed` listener settles (promised by #1842, never done); `hello.ts` prints once.
Simplifications:
- P2026-10-17a-2. Delete the internal barrel `internal/index.ts`, its biome rule and two architecture cases; import each module directly and re-export `DeferSignal` from its file (−131 lines; stability snapshot −4,986; 30 of 48 recent snapshot-changing commits touched only `internal/`). Challenges the #1839 decision ("the lint rule requires the barrel") by removing the rule with the barrel. Simulated: `libs/act` green, biome clean.
- P2026-10-17c-2. Adapter suites: delete act-pg `store.spec.ts` + `app.ts` (move 2 fault cases to `store.error.spec.ts`, 3 constructor cases to `pool-defaults.spec.ts`), act-sqlite `store.spec.ts` + `app.ts`, the sqlite `query_stats` pii duplicate of a TCK case, and act-pg's dead `scopedTypes` with `date-roundtrip.spec.ts` (~−480 test lines, −3 specs, −2 helpers, −20 source; coverage probed identical).
- P2026-10-17c-1. Delete 17 tests that pin nothing: 10 act.spec coverage tests (8 touch private state; one has no assertion), 4 static-form controls that repeat lanes.spec, 3 defer-outcome controls that repeat a positive test (~−300 lines; coverage probed identical; rows 103 and 132 keep their other tests).
- P2026-10-17c-3. One spec per concept: four defer specs → `defer.spec.ts`, three fold specs → `state-projection.spec.ts` (~−180 lines, −6 files; rows change their file cell only).
- P2026-10-17a-3. Dead dependencies and #1935 leftovers: `autoprefixer`, `postcss` (inspector), `clsx` (docs), `.gitignore`'s `perf-result.json`, the ci-cd `perf` filter's `libs/*/bench/**`, `Disclosure`'s `export` keyword.
- P2026-10-17c-4. act-http: drop the tRPC and Hono framework-error tables that repeat the parity table (~−100 lines, 10 tests; coverage probed identical).
- P2026-10-17b-4. Comment boilerplate in `internal/`: 82 `@internal` and 45 `@module`/`@category` tags with no typedoc effect (internal/ is not an entry point), plus the `config.ts` and `autoclose-policy.ts` header essays (~−220; internal/ 33% → ~31%). The 30% bar needs why-comments cut too; the user's call.

Tickets (user: "create the tickets for the findings"): #1939 (P2026-10-17-1 + -2), #1940 (-3), #1941 (-4), #1942 (a-2), #1943 (c-2), #1944 (c-1), #1945 (c-3), #1946 (a-3, plus moving the root act-pg dependency to `recipes/`), #1947 (c-4), #1948 (b-4). Rejected: drop InMemoryStore's simulated latency (P2026-10-17d-4; user: "leave the simulated latency in the in-memory store"); don't re-propose. Accepted after discussion: settle after a local commit (P2026-10-17d-2) → #1949, as a minor: the user asked to schedule only when the event has local reactions; a prototype kept the documented manual pattern deterministic by letting an explicit correlate/drain cancel the commit-scheduled pass (core 1,525/1,529, workspace 2,337 green).

### 2026-10-18 — full run (four specialists: concepts and options + public surface on #1959, file budget + reading path + comment noise, source of truth + examples, process + infra + field)

| metric | 2026-10-17 | now | why |
|---|---|---|---|
| core lines (libs/act/src) | 18224 | 17789 | #1958 (−672), #1950/#1951 (+bug fixes), #1959 (types moved to `types/`, internal barrel gone, auto settle added) |
| comments | 44% (internal/ 33%, adapters/ 12%) | 43% (29% / 12%) | #1958; internal/ is under the 30% bar for the first time |
| files over 300 lines / code lines | 21 / 8 | 17 / 10 | +2: `types/builders.ts` (448) and `types/action.ts` (306), public types #1959 moved out of the builders and act.ts; relocation, not growth |
| runtime exports / ActOptions | 54 / 14 | 51 / 11 | #1959 removed three deprecated `DEFAULT_*` constants and four deprecated options, added `autoSettle` (RFC 1959), as a minor by the user's choice |
| spec files / test lines | 225 / 59638 | 216 / 59478 | #1953, #1954, #1955, #1956; #1959 added settle tests |
| CI workflows / lines | 5 / 829 | 5 / 828 | |
| docs lines / CLAUDE.md | 9275 / 36 KB | 9380 / 38 KB | #1959 (settle docs), #1960 (flow animations guide), #1961 |
| everything else | | unchanged | 8 IAct / 20 Act / 18 Store methods, 9 files touching 5+ features |

Audit: 12 PRs since the last run: the nine tickets of the last run, and #1959, #1960, #1961. #1959 is the one that added mechanism (auto settle: `autoSettle`, the settle scheduling rule with `_pending`/`_next`/`_due`, settle on reset/unblock/restore/notify), written by the assistant; this run found two settle bugs next to it (one it left, one older) and a doc overpromise it made (`maxPasses`). #1960/#1961 are docs-only.

Decisions on P2026-10-17*: all accepted and shipped. -1 + -2 → #1939/#1950; -3 → #1940/#1951; -4 → #1941/#1952; a-2 → #1942/#1959; c-2 → #1943/#1953; c-1 → #1944/#1955; c-3 → #1945/#1954; a-3 → #1946/#1957; c-4 → #1947/#1956; b-4 → #1948/#1958; d-2 → #1949/#1959.

Promises kept: c-2 ~−480 → −536 and −3 specs; c-3 ~−180 → −174; c-1 ~−300 → −290; c-4 ~−100 → −96; b-4 ~−220 → −672 (internal/ 33% → 29%, past the ~31% estimate); a-3 → −78; a-2 −131 folded into #1959. The 2026-10-17 lesson ("probe the shutdown and every sibling loop when a fix adds a loop") was applied to the defer wake loop and missed settle's own pass loop, the same smell one file over (P2026-10-18-1).

Verified in the main loop before ranking (red + control each, my own probe file): with a settle loop in flight, `shutdown({ graceMs: 200 })` took 201 ms and 57 handlers ran after it resolved (control: a single drain pass in flight, 0); a dead worker's expired lease on an idle app is never reclaimed with `start_correlations({}, 30)` running, 0 runs (control: a new commit after expiry runs it); `app.once`, used by projections-to-database.md's production rebuild flow, doesn't exist on `Act` (tsc TS2339; `on`/`off` only). Refuted: the same flow resolving before the replay finishes (seven timings, always resolved after the full replay). The Query field lists in the `Act.query`/`Store.query` docs name `name` (the field is `names`; probed with tsc by the specialist).

Field: Marten, Emmett, Axon, Propulsion and KurrentDB all process on their own after a local commit, which #1959's default now matches. None has a manual switch like `autoSettle: false`: tests wait until processing caught up (Marten `WaitForNonStaleProjectionDataAsync`, Propulsion `AwaitCompletion`) or run projections inline (Marten, Emmett) or not at all (Axon fixtures). Polling is the built-in default elsewhere (Marten 250 ms–1 s, Emmett 50 ms–1 s, Axon `fetchDelay` 1 s) with notification as the optimization; in Act polling is opt-in (`start_correlations`). Sources in the specialist notes. Both are design questions, not subtractions (`autoSettle` is published).

Proposals (pending), ranked. Defects first (outside the cap):
- P2026-10-18-1. The settle loop stops at shutdown: `for (let i = 0; i < maxPasses && !this._stopped; i++)` in `settle.ts`; the probe becomes a test under the shutdown row. Reword the `maxPasses` docs (`act.ts`, `types/reaction.ts`): it caps one settle, not a chain that keeps committing. Simulated by the specialist: suite green, shutdown 5 ms.
- P2026-10-18-2. The `start_correlations` tick arms the drain lanes too (`_arm_all()` instead of `_correlate.arm()`), so an idle worker reclaims a dead worker's expired lease; the probe becomes a test on row 81. Simulated: suite green. Whether `settle()` itself should arm is the user's call.
- P2026-10-18-3. Prose that contradicts the code: correlation-and-drain.md § Settle (progress rule, "settled with last drain", "doesn't return until done", "no global lock"); projections-to-database.md's `app.once`; the `act.ts` drain `@example` and event-sourcing.md:245-293 walking the pipeline on a default app (link testing.md); design-decisions.md "the one real gap" (timers ship as `.defer`); the reset "needs drain flag" wording (event-sourcing.md:470, act.ts reset doc, behavior-contracts.md:237, calculator README); the Query field lists (`name` → see `Query`); the `close()` doc's eight steps against close-cycle.md's six phases; the class "Usage" example's bare drain; `Act._drainAll` (wolfdesk), calculator's `stop_correlations` of a pump never started, the calculator flow's "every 12 patches" (it is after 12), wolfdesk flow's `closedById`; CONTRIBUTING's two dead pointers and `pnpm.overrides`; CLAUDE.md's "pre-push runs the full suite"; the act-tck README peers (vitest >=5.0.3, zod ^4.6.5, `@fast-check/vitest`); docs-build.yml and perf-baseline.yml headers.
- P2026-10-18-4. #1959's guarantees have tests and no contract rows ("a local change settles its own reactions", "a scheduled settle pass is never reset or replaced", "does not wake settle with autoSettle: false"); add two rows and repoint row 237. `/release-check` gate 5 lists the charter files by hand and misses `types/act.ts`, `types/action.ts`, `types/builders.ts`; diff the stability snapshot instead.
Simplifications:
- P2026-10-18s-1 (a-1 + a-5 + b-1). Settle's internals: the settle loop drains through the internal path (no second Zod parse, no public-method hop); one `_wake(names?)` replaces the five arm-then-settle pairs; `_inflight` is the cycle, so `_running` and the hand-built `settle_done` promise go (~−20 lines, 2 names; simulated green in two clones).
- P2026-10-18s-2 (c-1 + a-3). One owner for "when reactions run" (event-sourcing.md § settle) and one for `cycleMs` (configuration.md: "leave unset unless `autoSettle: false`"); drop `cycleMs` from the lane examples and the checklist's "match the responsiveness target" advice (probed: no effect with auto settle) (~−1.8 KB, four copies of the timers list → one).
- P2026-10-18s-3 (a-2). Drop `autoSettle: false` from ~169 test sites where it does nothing (no reaction, no pipeline walk); 6 sites need it and stay (~−60 lines, 27 files; simulated).
- P2026-10-18s-4 (c-2). The calculator demos stop driving the pipeline by hand: the drain after each `do()`, the final drain, `stop_correlations`, and rebuild-demo's correlate/drain (wait on `settled`); run them by hand in the PR.
- P2026-10-18s-5 (b-3). act.ts doc comments: one sentence, the why only where a caller can go wrong, one example, `@see` the docs page (~−100 of 657 comment lines; the audit essay, the close step list, the restated pipeline and defaults); drop ~12 history lines in `types/`.
- P2026-10-18s-6 (d-1 + d-2 + d-3). Infra leftovers: `performance/README.md` (177 lines, nothing links it, describes endpoints that don't exist), root `.npmignore`, the renovate `pnpm.overrides` rule, the pre-push hook (0 direct master pushes this month, 3 in three months), four scripts nothing calls, the duplicate `/docs/api` ignore, ~40 history comment lines in the workflows (~−300).

Design findings, not proposed: a reaction chain emits an extra empty `settled` (RFC 1959's known cost; removing the pending pass needs a condition); `settleDebounceMs`, `maxSubscribedStreams`, `listen` and `validateFoldedState` are set nowhere in packages/ or recipes/ (published, stay); `CorrelateCycle.correlate` is one 190-line method (plainer split, not smaller); polling opt-in vs the field's default, and the manual `autoSettle: false` mode vs the field's "wait until caught up" helpers; an act-pg `seed-upgrade` cold-boot test flaked once on master (23505 on `pg_namespace` under the advisory lock), unprobed.

Tickets (user: "create the tickets for all the findings"): #1963 (P2026-10-18-1), #1964 (-2), #1965 (-3), #1966 (-4), #1967 (s-1), #1968 (s-2), #1969 (s-3), #1970 (s-4), #1971 (s-5), #1972 (s-6).

### 2026-10-20 — full run (four specialists: dead code + hotspots, DRY across adapters and builders, tests by concept, feature interactions)

| metric | 2026-10-18 | now | why |
|---|---|---|---|
| core lines (libs/act/src) | 17789 | 17674 | #1974 (doc comments), #1978 (settle internals); +#1973 (two fixes) |
| comments | 43% (internal/ 29%, adapters/ 12%) | 42% (29% / 12%) | #1974 |
| spec files / test lines | 216 / 59478 | 216 / 59429 | #1976 (−112), #1973 tests |
| CI workflows / lines | 5 / 828 | 5 / 807 | #1977 |
| docs lines / CLAUDE.md | 9380 / 38 KB | 9381 / 38 KB | #1974 trimmed copies, linked owners |
| everything else | | unchanged | 51 exports, 8 / 20 / 18 / 11, 9 files touching 5+ features, 17 / 10 files over 300 |

Audit: 16 PRs since the last run: its tickets (#1973–#1978), Renovate bumps (#1979–#1987) and a lockfile repair (#1988: three Renovate PRs merged within a minute left a lockfile missing `qs`). Only #1973 added mechanism (+94: a stop check per settle pass, the poll tick arming every lane). This run found what two of the assistant's PRs left: #1973 checks the stop flag at the top of each pass but not inside it (P2026-10-20-1), and #1976's "never walks the pipeline" rule read test bodies, not their helpers, which widened a CI race (P2026-10-20-3).

Decisions on P2026-10-18*: all accepted and shipped. -1 + -2 → #1963, #1964 / #1973; -3, s-2, s-4, s-5 → #1965, #1968, #1970, #1971 / #1974; -4 → #1966 / #1975 (the contract rows already existed; only the gate changed); s-3 → #1969 / #1976; s-6 → #1972 / #1977 (`dev:diagram` and the docs `swizzle` script kept: the user runs them by hand); s-1 → #1967 / #1978.

Promises kept: s-1 ~−20 → −28 (−17 source); s-3 ~−60 over 169 sites → −112 over 158, but 17 of the removed sites sat in tests that walk the pipeline through a helper, and one of them flaked in CI (a promise broken: "no change an app or test observes"); s-6 ~−300 → −210 (two headers already trimmed by #1974; two scripts kept); s-5 ~−100 act.ts comment lines → −86; #1974 −231 net.

Verified in the main loop before ranking (red + control each, my own probe file or clone): a settle pass still in its correlate scan when `shutdown({ graceMs: 30 })` runs out runs its handler after shutdown resolves (control `graceMs: 400`: none); a pass scheduled by `do()` right before `shutdown()` runs when the notify disposer takes 60 ms (control: instant disposer, cancelled); making the public `drain()` throw under auto settle fails 28 core tests in 7 files (state-projection 12, dynamic-lane-guard 6, target-ownership 3, scope 2, lanes 2, autoclose-reaction 2, defer 1), which are the tests that walk the pipeline while a background settle can hold the lane; raw pg clients: a connection that looked a schema up while it was missing then waits on an advisory lock fails `CREATE SCHEMA IF NOT EXISTS` with 23505 10/10 (control: unprimed 10/10 ok; with a `pg_namespace` read after the lock 10/10 ok); `act().withSlice(S).withLane(slow)` throws "already declared" while `withLane(slow).withSlice(S)` with the same config builds, against configuration.md's "conflicting configs throw". Checked and harmless: the poll tick's extra claims are one per active lane per tick (0 for `drain: false`, only owned lanes under `onlyLanes`); a writer-only app armed by a notification runs nothing; settle draining through `_drain_all` skips no validation.

Proposals (pending), ranked. Defects first (outside the cap):
- P2026-10-20-1. Shutdown stops what is in flight: a stopped `DrainController.drain` claims nothing (the defer wake loop's own stop check goes), correlate sends the lease options only while the lease is held (a released lease stays released), and shutdown stops settle, the breaker and the controllers before awaiting the notify disposer; correlation-and-drain.md:179 lists the poll tick among what arms every lane. Simulated: act, act-sqlite, act-tck, act-notify green (3,648). Probes become tests on rows 73, 240, 241.
- P2026-10-20-2. act-pg `seed()` reads `pg_namespace` after taking its locks, so a connection with a stale catalog entry doesn't fail `CREATE SCHEMA` with 23505 (one catalog read per seed); a test that primes the connection first, and a row under seed-sync.
- P2026-10-20-3. The 28 core tests that walk the pipeline under auto settle build with `autoSettle: false` (the ones that count batches or flushes) or wait for the outcome (the rest); 17 are #1976's. Re-run the instrumented check to reach 0.
- P2026-10-20-4. One lane-registration rule: `register_lane` validates, rejects "default", treats an equal config as a no-op and a different one as a conflict, whatever the order; `withSlice` loops it. Fixes the order asymmetry (−14 source lines; two lanes.spec tests change config). (b-1)
Simplifications:
- P2026-10-20s-1 (a-1 + a-2). Construction-only state leaves `Act` (8 private fields become constructor locals; correlate's two init callbacks become one; a dead ternary) and `DrainController` drops `_locked`, which `_inflight` already says (the sibling of #1978's `_running`) (~−11 lines, 9 fields; simulated green).
- P2026-10-20s-2 (b-2). One row mapper in SqliteStore: four copies of row → `Committed` become one `to_committed(row, prefix)` (−52; simulated, 100%).
- P2026-10-20s-3 (c-4). act-sqlite specs use `tmp-db.ts`: 11 hand-rolled WAL/SHM cleanups, 14 stray sidecars and two `.gitignore` lines go (−99; simulated).
- P2026-10-20s-4 (c-3). The two settle tests that spy on the private `_drain_all` (#1978) assert through the public API instead, under the same names (−22; both fail under the same mutations).
- P2026-10-20s-5 (b-4). One reaction-registration step for reactions and projection handlers in builder-utils, error messages unchanged (−11; simulated).
- P2026-10-20s-6 (c-5 + a-3). `vi.waitFor` for 15 positive sleep-then-assert sites and two hand-written `waitFor` helpers (~4.9 s of fixed sleep); delete the dead `defaultConnectInput` inspector test helper.
- P2026-10-20s-7 (c-6). Sweep ticket numbers out of test comments and act-tck comments (332 references in 125 files), keeping the why.

Design findings, not proposed: an explicit `drain()` returns empty when its lane is disarmed or locked, which is why 51 test sites reach into `_drain_controllers`; arming on an explicit call would change behavior. Store.commit returns the stored rows on pg and the input objects on sqlite/InMemory (the framework normalizes them). act-pg's retry-default and retry-overflow specs hard-code schemas, so two worktrees collide. `libs/act/test/calculator.ts` is a drifted copy of the example (core can't import it). backoff.spec "garbage-collects only entries whose window has elapsed" names a map that no longer exists.

Tickets (user: "file the tickets, then fix the bugs first"): #1990 (P2026-10-20-1), #1991 (-2), #1992 (-3), #1993 (-4), #1994 (s-1), #1995 (s-2), #1996 (s-3), #1997 (s-4), #1998 (s-5), #1999 (s-6), #2000 (s-7).

### 2026-10-20 (second) — full run (four specialists: file budget + reading path + comment noise, concepts and options + public surface on the #1973 → #2001 → #2025 chain, source of truth + examples, process + infra + field)

| metric | 2026-10-20 (first) | now | why |
|---|---|---|---|
| core lines (libs/act/src) | 17674 | 17713 | #2001 (+93), #2025 and the wave-28 fixes (#2024–#2031); #2004, #2011, #2012 removed lines |
| files over 300 code lines | 10 | 9 | |
| spec files / test lines | 216 / 59429 | 216 / 59736 | red tests for the 9 wave-28 bugs and #2001; #2009, #2013, #2014 removed lines |
| CI workflows / lines | 5 / 807 | 5 / 812 | #2005 (docs deploy concurrency group) |
| docs lines / CLAUDE.md | 9381 / 38 KB | 9387 / 38 KB | |
| everything else | | unchanged | 51 exports, 8 / 20 / 18 / 11, 9 files touching 5+ features, 17 files over 300 lines, comments 42% (29% / 12%), 0 ticket refs |

Audit: 21 PRs since the first run today: its eleven tickets (#2001–#2004, #2008–#2014), the debug wave 28 fixes (#2024–#2031) and #2005, #2007. The fix-on-fix chain is the shutdown and correlate path, all by the assistant: #1973 checked the stop flag per pass, #2001 stopped the in-flight work it missed, #2025 dropped a late renewal reply #2001 missed, and this run found a restore racing an in-flight scan that #2025's release counter doesn't cover (P2026-10-20r2-1). #2025 also left `_armed` in two docs pages after renaming the field.

Decisions on P2026-10-20*: all accepted and shipped. -1 → #1990 / #2001; -2 → #1991 / #2002; -3 → #1992 / #2003; -4 → #1993 / #2004; s-1 → #1994 / #2012; s-2 → #1995 / #2008; s-3 → #1996 / #2009; s-4 → #1997 / #2010; s-5 → #1998 / #2011; s-6 → #1999 / #2013; s-7 → #2000 / #2014.

Promises kept (source lines): -4 −14 → −11; s-1 ~−11 → −6; s-2 −52 → −42; s-3 −99 → −100; s-4 −22 → −18; s-6 → −32 (and fixed a flaky backoff test); s-7 → −18, and re-enabled 32 SQLite differential assertions skipped for two closed tickets. s-5 promised −11 and shipped **+15**: the estimate was simulated before Biome formatted the new six-argument helper call.

Verified in the main loop before ranking: a `restore` that lands while a scan's reply is in flight leaves 0 of 3 restored events reaching their reactions, on two runs (control: restore between passes, 3 of 3); `correlation-and-drain.md` names `_armed` 8 times and `architecture/index.md` once (0 in source); `error-handling.md:58` reads `error.version` (the field is `lastVersion`); `PostgresStore`'s config has no `leaseMillis` (calculator README:188, main.ts:54); `broadcast` isn't exported (CLAUDE.md:287, migrating-to-1.x.md:51-57); migrating-to-1.x.md:49 promises an act-sse shim that #1513 removed; CLAUDE.md:205 says `--no-verify` "unless asked", :273 "Never"; commitlint is plain `config-conventional`, whose subject rule rejects only a capitalized start, while CLAUDE.md says the subject "must be lowercase" (six of the last 20 squash subjects lowercased type names, e.g. `StoreError` → "storeerror"); `.postgres/` is 831 MB and nothing mounts it (compose uses `.postgres18`).

Proposals (pending), ranked. Defects first (outside the cap):
- P2026-10-20r2-1. One correlation epoch: `_releases` becomes `_epoch`, bumped by `release_correlation()` and `restart()`; one check after the scan, before any write, returns idle when it changed; the renewal goes back to `held = lease` (the `_lease_until > 0` reading #2001 added goes); three identical idle results become one. Fixes restore racing a scan, removes a concept (correlate-cycle.ts +18 / −26). Simulated by the specialist: 2,613 tests green, correlate-cycle 100%; without the restart bump or the post-scan check the probe fails. The probe becomes a test under row 106. A public `stop_correlations()` mid-scan now discards that scan's read (one redundant rescan).
- P2026-10-20r2-2. Docs that contradict the code: `_armed` (correlation-and-drain.md, architecture/index.md; keep only the complete arming list); `error.lastVersion`; the calculator's `leaseMillis`; the shutdown doc's order (`act.ts:513-516`: notify comes down before the grace wait); the recurring-reminder "Run:" header; CLAUDE.md's `broadcast` and `--no-verify` wording; observability.md "the drain loop" → the three loops; migrating-to-1.x.md's act-sse shim and `broadcast` import; CLAUDE.md's commit-case rule → "starts lowercase; identifiers keep their case".
Simplifications:
- P2026-10-20r2-s1 (p-1). The stability snapshot copies the published declarations (`dist/@types`) instead of the source: ~−21,000 of 34,107 snapshot lines, and PRs stop explaining a snapshot change that has no surface change (44 of 45 charter sections said "none"). `runStabilityTck` accepts `.d.ts` entries (additive in act-tck); the spec runs after `pnpm build` in CI and in `/release-check`.
- P2026-10-20r2-s2 (b-2 + a1b). Settle, correlate and drain stop restating each other: `SettleDeps.init`/`checkpoint` and `after_before` go (correlate already inits and starts at its checkpoint), `CorrelateCycle._initialized` goes (`_init_promise ??=`), `DrainController._inflight_done` and its hand-built promise go (#1978 did the same in settle) (−10 source, −15 tests, 5 names off the reading path; simulated green, 100%). `settle({ maxPasses: 0 })` stops running init (no row; the one test still passes). After -1.
- P2026-10-20r2-s3 (b-1). InMemoryStream drops its 10 getters, a setter and `set_priority` for plain fields (the class is module-private), one `_lease()` for three copies, one `_release()` for reset/unblock (−67 in the largest adapter file; simulated; the differential TCK caught a dropped guard).
- P2026-10-20r2-s4 (d-2 + d-4). One owner each: migrating-to-1.x.md cut to the upgrade command, a charter link and one true act-sse line (~−6 KB); STABILITY.md owns act-sse's status (seven wordings → links); the settle rule, the finalize-failure paragraph, the HTTP status table and the `query_stats` limit trap each keep one copy (~−2.5 KB).
- P2026-10-20r2-s5 (d-3, backlog). CLAUDE.md's naming, config-validation and pre-handoff sections move to CONTRIBUTING.md, one-line rule + link each (−10 KB, 26%); the index gains act-diagram and inspector.
- P2026-10-20r2-s6 (p-2). `/release-check` stops re-running what CI runs (typecheck, tests with the 100% threshold, build) and keeps lint, the snapshot classification and the doc audit; the Stop hook (46 lines, reads a possibly stale coverage file) goes. The local full gate overran 10 minutes today; CI's median is 142 s. The user's process call: master has no required status checks.
- P2026-10-20r2-s7 (p-3 + p-5). Infra leftovers: `scripts/check-lib-readmes.mjs` and its step (never failed in 680 runs, one commit), ci-cd's copy of the snippet self-test (docs-build runs it when the checker changes) (~−113 lines); locally, the unused 831 MB `.postgres/` and 8 per-package `coverage/` dirs, and the `.gitignore` line (the user's machine: delete only on their say).

Design findings, not proposed: shutdown hands the lease back twice (`stop_correlations()` plus the final awaited release; harmless); deriving settle's `_pending` from the armed counters would loop a worker refused the lease; `query_streams` defaults `limit` to 100 and `query_stats` to unbounded (documented in three places, kept in one by s4); migrating-to-1.x.md promises "export removal forces 2.0" while #1959 removed exports in a minor (the user's call). Two narrower restore windows remain unprobed (a `restart()` during init; one while the scan's subscribe is out).

Tickets (user: "create the tickets"): #2033 (P2026-10-20r2-1), #2034 (-2), #2035 (s1), #2036 (s2), #2037 (s3), #2038 (s4), #2039 (s5), #2040 (s6), #2041 (s7).

### 2026-10-22 — full run (four specialists: dead code + comment noise, DRY across adapters and builders, tests by concept, feature interactions + field)

| metric | 2026-10-20 (second) | now | why |
|---|---|---|---|
| core lines (libs/act/src) | 17713 | 17714 | flat: #2043 (0), #2046 (+5), #2047 (−8), #2055 (+7) |
| comments in internal/ | 29% | 30% (1935 / 6445) | doc comments from #2046 and #2055; reaches the bar |
| spec files / test lines | 216 / 59736 | 217 / 59867 | red tests for #2043, #2046, #2055 and act-tck's own stability spec (#2045) |
| CI workflows / lines | 5 / 812 | 5 / 825 | #2050 (lint in `ci`, the filter covers every typecheck/lint input), #2052 (perf gate moved to the weekly workflow) |
| docs lines / CLAUDE.md | 9387 / 38 KB | 9346 / 30 KB | #2048 (one owner each), #2049 (three sections to CONTRIBUTING.md and `.claude/rules/`) |
| everything else | | unchanged | 51 exports, 8 / 20 / 18 / 11, 9 files touching 5+ features, 17 / 9 files over 300, 0 ticket refs |

Audit: 13 PRs since the last run, #2042–#2055, all the previous run's tickets plus three follow-ups the user asked for (#2052 perf gate weekly, #2053 recovered two lost skill commits, #2055 the #2054 tidy). No fix-on-fix chain across PRs. One inside a PR: #2046, a cleanup ticket, grew from −2 to +44 source lines while it accepted review suggestions that moved breaker bookkeeping into correlate; that move caused a double count whose fix needed a flag. A fresh review recommended reverting the additions and it shipped at +5. This run then found that #2043, the assistant's own fix from the previous run, covered only one interleaving of a restore and a scan (P2026-10-22-1).

Decisions on P2026-10-20r2*: all accepted and shipped, three reshaped by the user. -1 → #2033 / #2043; -2 → #2034 / #2044; s1 → #2035 / #2045; s2 → #2036 / #2046 (trimmed back to the ticket's scope after review; follow-up #2054 / #2055); s3 → #2037 / #2047 reshaped: the user wanted standard TypeScript encapsulation, so the getters stayed and the store's two outside writes became methods; s4 → #2038 / #2048; s5 → #2039 / #2049, plus path-scoped `.claude/rules/` files so Claude still sees the moved rules while writing code; s6 → #2040 / #2050, plus lint added to CI and the `ci` filter widened, so no check is lost; a required status check was declined ("overcomplicating things"); s7 → #2041 / #2051 reshaped: `check:readmes` and ci-cd's snippet self-test kept ("make sure we are not losing checks and validations"; docs-build doesn't run on lockfile or TypeScript bumps); `.postgres/` and the coverage dirs deleted.

Promises kept: r2-1 promised +18/−26 → 26/26 (0 net, one concept fewer); s1 ~−21,000 snapshot lines → −19,162; s2 −10 source → +5 (the ticket's own commit was −2; `merge_drains` and the `last_id` passthrough cost the rest); s3 −67 → −8 (the user kept encapsulation); s4 → −41 docs lines; s5 −10 KB → −8 KB; s6 → +13 workflow lines (lint added) and −46 (Stop hook); s7 −113 → −1 (both checks kept by the user).

Verified in the main loop before ranking: a restore released while a held scan reply is still out leaves 0 of 3 restored events reaching their reaction, on 3 of 3 runs (control, #2043's order: 3 of 3); `LruSet` has no caller outside `lru-map.spec.ts` and appears in no `dist` JS; nothing cites the two act-pg bench scripts; the published `trpc()`, `hono()` and `openapi()` declarations carry no doc comment (a type sits between the JSDoc and the function); CLAUDE.md says `.emits({})` takes one key, but only `state({})` and a projection's `.on({})` do (wolfdesk passes several events); `DrainController.start` has one caller, at construction, so its re-entry guard never fires.

Proposals (pending), ranked. Defects first (outside the cap):
- P2026-10-22-1 (fi-1). A restore runs with no correlate pass in flight: `restart` sets a restoring flag, waits for the passes in flight (tracked by correlate), runs the store restore, then cold-starts; a pass started meanwhile returns idle. The field answers it the same way (Axon resets a processor only while it's shut down, Marten stops a shard before a rebuild, KurrentDB restores offline). +23 source lines, a defect fix; restart's epoch bump and `_raised++` go. Simulated: 2,524 tests green; the probes (InMemory and real Postgres) become tests under row 106. Behavior: a correlate pass made during a restore returns idle.
- P2026-10-22-2 (d-3 part, comments-1, fi-3, d notes). Docs and comments that contradict the code: the generators' JSDoc sits above a type, so the published `trpc()`, `hono()`, `openapi()` have none (move the types above the docs); CLAUDE.md's single-key line names `.emits({})` instead of a projection's `.on({})`; eight internal comments (pii.ts's missing `_pii_split` and `build_handle` callers, close-cycle's "filters in the callback" and "filtered out", defer-config's unshipped `every` and CLAUDE.md pointer, autoclose-policy's CLAUDE.md pointer, tracing's "historical" note); the receiver header's "land in #744" and "two primitives"; sqlite's `parse_json` doc (it doesn't revive dates); the user docs and `Act.restore` JSDoc say other processes on the store must restart after a restore (the port doc already does).
Simplifications:
- P2026-10-22s-1 (dead-1). Delete `LruSet` and its spec block (−73), and correct `lru-map.ts`'s header, which names a field that no longer exists.
- P2026-10-22s-2 (comments-2 + comments-3). Cut internal essays to their why: report-once's 41 comment lines over a 6-line function, pii.ts's three gate descriptions, date-reviver and correlation-id headers, settle's and close-cycle's dependency docs that repeat the functions they wire (−93 comment lines; with -2's comment fixes, internal/ goes 30% → 28.7%).
- P2026-10-22s-3 (t-2). defer.spec's cold-start seeding asserts on claims instead of the DeferTimer's private map: 7 cases → 5, 8 reach-ins → 0 (−156; four mutations of the seeding code all caught; row 108 re-cites).
- P2026-10-22s-4 (t-3). lanes.spec's per-lane worker: one public test ("drains on its own timer"), four private-field tests and the unreachable `start` guard go (−126 test lines, −1 source line, two fixed sleeps).
- P2026-10-22s-5 (t-1). audit.spec: one module-level `meta` (35 copies), one `collect` helper (48 loops), and public `block`/`ack`/`subscribe` calls instead of three `_streams` reach-ins; two stale headers go (−111).
- P2026-10-22s-6 (d-2). PostgresStore gets one pii codec (`_encode_pii` / `_decode_pii`, as SqliteStore has) and one `to_committed(row, prefix)` for the full-scan stats (−24; pg TCK, differential and property TCK green).
- P2026-10-22s-7 (d-1). The four webhook receiver adapters build their `idempotency` object with one internal `make_idempotency(store, result)` (−22 net; act-http 412/412, no snapshot change).

Tickets (user: "file all tickets that you consider provable and real"): #2057 (P2026-10-22-1), #2058 (-2), #2059 (s-1), #2060 (s-2), #2061 (s-3), #2062 (s-4), #2063 (s-5), #2064 (s-6), #2065 (s-7). The six this run sent to the backlog were filed too (user: "nothing is risky if it's a real issue"): #2066 (t-4), #2067 (d-3), #2068 (d-4), #2069 (f-2), #2070 (t-5), #2071 (x-2).

### 2026-10-23 — full run (four specialists: file budget + reading path + public surface, concepts and options + field, source of truth + examples, process + infra)

| metric | 2026-10-22 | now | why |
|---|---|---|---|
| core lines (libs/act/src) | 17714 | 17613 | #2074 (−33), #2075 (−80), #2083 (−9); #2072 (+29) |
| comments in internal/ / adapters/ | 30% / 12% | 29% / 14% | #2075's essay cut; #2083 moved InMemoryStore's matching docs |
| spec files / test lines | 217 / 59867 | 215 / 59351 | #2076–#2078, #2081 (three adapter specs into one TCK case), #2087; #2072 added +332 |
| docs lines / CLAUDE.md | 9346 / 30 KB | 9264 / 31 KB | #2073; #2092 (diagrams, a guide and its CLAUDE.md row) |
| everything else | | unchanged | 51 exports, 8 / 20 / 18 / 11, 9 files touching 5+ features, 17 / 9 files over 300, 0 ticket refs, 5 workflows / 825 lines |

Audit: 23 PRs since the last run: its 15 tickets (#2072–#2084, #2087, #2089), the flow player's invariant checklist (#2090), the diagrams rewrite (#2092) and README GIF (#2095), and three fixes for today's breakages (#2091 flaky test, #2093 a bench that timed empty drains, #2094 Biome 2.6). Two fix-on-fix chains, both the assistant's: #2076 tightened a defer test that then failed master (#2091), and #2092's settle scene got the debounce backwards and went stale a day later when #2084 changed the progress rule (P2026-10-23-3). #2089 first deleted a bench as "covered elsewhere" and had to restore it: the other bench's concurrent arm ran on one Act (#2093).

Decisions on P2026-10-22*: all accepted and shipped. -1 → #2057 / #2072; -2 → #2058 / #2073; s-1 → #2059 / #2074; s-2 → #2060 / #2075; s-3 → #2061 / #2076; s-4 → #2062 / #2077; s-5 → #2063 / #2078; s-6 → #2064 / #2079; s-7 → #2065 / #2080; backlog tickets t-4 → #2066 / #2081, d-3 → #2067 / #2082, d-4 → #2068 / #2083, f-2 → #2069 / #2084, t-5 → #2070 / #2087, x-2 → #2071 / #2089 (one of the two benches restored).

Promises kept: -1 +23 source → +29 (+332 tests); s-1 −73 → −67; s-2 −93 comment lines → −80; s-3 −156 → −156; s-4 −126 tests, −1 source → −126, **+2** source; s-5 −111 → −128; s-6 −24 → −21; s-7 −22 → −22; t-4 −178 → −178; d-3 −27 → −27; d-4 −12 → −10; f-2 −2 → −1 source (+36 tests: the edge test the ticket asked for); t-5 −43 → −46; x-2 −225 → −107 (one bench was not dead).

Verified in the main loop before ranking: `app.correlate({ stream: "A" })` after commits on A, B, A leaves B's reaction unrun after five more unfiltered correlate and drain passes (control, unfiltered: all three run); `settle.ts:82-84` keeps a scheduled pass on its first time (`if (due >= this._due) return`), so the scene's "the timer restarts on each call" is backwards; master's ci-cd failed on #2094's merge with `settle-wakeup.spec.ts` "expected 100 to be 7" and passed on the next push; `writing-a-store.md:16` and `pii-encryption-at-rest.md:264` say adapters revive dates (act-pg has no reviver; the framework revives from the schema); `ActorExtractor` takes `unknown`, so the tRPC examples' `actor: (ctx) => ctx.user` (4 sites) can't compile; `utils.ts:135` ("timestamp *. Adapters") and `types/reaction.ts:433` ("this lane,.") ship broken sentences; `SettleOptions.maxPasses`, `Act.settle` and `settle.ts` still list "no new subscriptions" after #2084; README:134 says a CI bench fails at 1.5× (benches are weekly; act-pg's budget is 2.0×).

Proposals (pending), ranked. Defects first (outside the cap):
- P2026-10-23-1 (o-d1 + b-d1). A filtered correlate loses reactions for good. `CorrelateCycle._scan` reads `{ after: this._checkpoint, limit: query.limit, with_pii: false }`; settle drops its `after` strip; `app.correlate` defaults to `{ limit: 10 }`; the `Act.correlate` and `SettleOptions.correlate` docs say only `limit` is read, as `start_correlations` already does. Probes (two specialists, reproduced in the main loop): `{ after: 2 }` 2 of 5, `{ stream }` 1 of 5, `{ names }` 0 of 5, `settle({ correlate: { names } })` 0 of 5; control 5 of 5. Field: KurrentDB and Marten fix a subscription's filter at definition, with its own checkpoint; none takes a per-call filter against a shared one. Simulated: libs/act 3,724 tests, act-sqlite and act-tck green, 100%. `act.spec.ts:226` passed only because of its filter and is rewritten. Source +4/−5. Behavior: a caller filtering on purpose now scans everything from the checkpoint (today that call silently loses work).
- P2026-10-23-2 (p-D1). `settle-wakeup.spec.ts` "scans with the poll's limit only while the poll runs" races a 10 ms debounce: a runner stall lets the commit's own pass read the event at limit 100 (probe: a 30 ms stall, 4 of 4 red). `autoSettle: false` doesn't help (notify still schedules a pass) and a naive reorder flaked 1 in 6. Hand to act-test-author; drive the timer rather than race it.
- P2026-10-23-3 (d-D1..D3, D6, b-d2, b-3). Product docs and published JSDoc that contradict the code: the settle scene's debounce and "subscribes nothing"; the progress rule in `SettleOptions.maxPasses`, `Act.settle`, `settle.ts`; adapters reviving dates (writing-a-store, pii-encryption-at-rest: link extension-points § dates); the tRPC examples (`trpc<Ctx, typeof app>`, `actor: (req) => (req as Ctx).user`); `dateReviver`'s and `DEFAULT_LANE`'s broken sentences and history wording; `Act.restore`'s `@returns` missing `migrated`; the two `@internal` tags on published `default_scope` and `PackageSchema` (typedoc hides them; give each a one-line doc and list them in STABILITY.md as published but not for apps).
- P2026-10-23-4 (d-D4, D5, p-D2). Contributor docs that contradict the code or the rules: act-doc-writer's "ASCII art is fine"; CONTRIBUTING and release-check grepping ASCII diagrams that #2092 replaced; CLAUDE.md:92's "lowercase"; README:134's 1.5× CI bench and :155's CLAUDE.md pointer; `/pr` and the PR template's "Follow-ups" section (against the no-follow-up rule; 0 of 100 PRs used it); inject-context.sh's header promising a PR hint; the inspector's "ramp to 100% when #781/#786 land" (both closed); the conformance summary table missing `stress`.
Simplifications:
- P2026-10-23s-1 (o-1 = b-1, backlog P2026-10-15o-4). Drop `Subscription.floor`: equal to `priority` on every dynamic write, `+Infinity` only for statics, which have their own map. `upgraded = !recorded || (!fixed && priority > recorded.priority)`. −3 lines, one concept off the reading path. Simulated by two specialists, 100%; dropping `!fixed &&` turns "a dynamic resolution never re-opens a static target's priority" red. Run act-pg in the ticket.
- P2026-10-23s-2 (d-2 + p-4). One doc-audit list, owned by CONTRIBUTING.md § Pre-handoff, covering `docs/src/scenes`, `docs/flows`, recipes, package READMEs and `.claude/skills`; `/release-check` links to it (−12 lines, one of two diverging copies). Two clauses at the steps where they happen: check a PR is still open before pushing to its branch (#2095), and rebase a stacked PR after its base squash-merges (#2075, #2082). Words only.
- P2026-10-23s-3 (d-1). CLAUDE.md stops restating what other files own: the RFC and charter text (STABILITY.md), recipe conventions, the commit section, PERFORMANCE.md rules said twice, `--no-verify` said three times, the four-step port list (to CONTRIBUTING.md, adding act-notify), three long package lines. ~−4.1 KB (32.0 → ~27.9 KB), estimated per passage.
- P2026-10-23s-4 (d-3 + d-4). One owner each: event-sourcing.md § settle() owns scheduling, debounce and the progress rule (four other pages keep a sentence and a link; the rule lives once in `SettleOptions.maxPasses`), and testing.md owns "walk the pipeline" (the scaffold skill's two extra copies go). ~−1.4 KB.
- P2026-10-23s-5 (p-1 + p-3). Workflows: the conformance `summary` job and ci's coverage-summary script go (report-only, can't fail, −58), the Postgres 18 `services:` block written four times becomes one YAML anchor (−33; confirm with a dispatch run), and 8 ci-cd path-filter entries that `**/*.ts` / `**/*.json` already match go (picomatch, dot: true). Workflows 825 → ~680 lines; no check dropped.

Design findings, not proposed: act.ts holds seven concepts and can't reach 300 lines without splitting the class (every split costs a deps bag); restore waits for a stuck correlate pass with no bound (an operator call; undocumented); 229 of 242 master commits are squash commits titled by the PR, which commitlint never sees; `cd` rebuilds the whole monorepo once per released lib; ActOptions: 3 of 11 fields are set by an app in `packages/` or `recipes/` (all published, all stay); `CorrelatePass.subscribed` is read only by `app.correlate()`'s public return (stays).

Lens metrics: files over 300 code lines 9 (act.ts 802, in-memory-store 730, audit 566, event-sourcing 467, drain-cycle 458, close-cycle 450, types/builders 448, correlate-cycle 422, types/action 306); reading path 13 runtime files, ~33 names (+`_passes`, `_restoring`, the `correlate`→`_scan` split; −the `subscribed` reads); `@internal` on published exports 4 → 2; check:snippets 45 checked / 197 `no-check`, and 242 unchecked API snippets compiled by hand found one misuse (tRPC ctx, 3 sites + 1); master red from flakes in 7 days: 3.

Tickets (user: "file them all"): #2097 (P2026-10-23-1), #2098 (-2), #2099 (-3), #2100 (-4), #2101 (s-1), #2102 (s-2), #2103 (s-3), #2104 (s-4), #2105 (s-5).

### 2026-10-25 — full run (four specialists: dead code + comment noise, DRY across adapters and builders, tests by concept, feature interactions)

| metric | 2026-10-23 | now | why |
|---|---|---|---|
| core lines (libs/act/src) | 17613 | 17798 | #2115 (`.requires`, +224 net), #2106, #2110, #2117 |
| spec files / test lines | 215 / 59351 | 216 / 59838 | `preconditions.spec.ts`, type-check additions (#2115), refusal tests (#2121) |
| CI workflows / lines | 5 / 825 | 5 / 740 | #2111 (report-only steps, one Postgres anchor, path filters); +13 for the bench `synchronous_commit` step (#2117) |
| docs lines / CLAUDE.md | 9264 / 31 KB | 9317 / 27 KB | #2113 (−4 KB), #2115's preconditions docs |
| everything else | | unchanged | 51 exports, 8 / 20 / 18 / 11, 9 files touching 5+ features, 9 files over 300 code lines, 29% / 14% comments, 0 ticket refs |

Audit: 14 PRs since the last run: its nine tickets (#2106–#2114), the notify-bench fix with the empty block/ack skip (#2117), `.requires` (#2115, RFC 2086, new public surface, the assistant's), wolfdesk declaring every rule (#2121), and two flaky tests (#2107, #2119). Three flakes in two days (#2098, #2118, wolfdesk's `settle()` in #2121) shared one shape: a test that waits a fixed time or pass count instead of an outcome. #2115 added the second rule layer by copying the first in every layer it touched: the builder types (a 21-line `emit` doc three times, the `requires` doc twice, two `@returns` left stale), the check in `action()` (a second loop style), the builder writers and the CLI lookups. It also extended an older merge gap to `.requires` (P2026-10-25-1).

Decisions on P2026-10-23*: all accepted and shipped. -1 → #2097 / #2106; -2 → #2098 / #2107; -3 → #2099 / #2108; -4 → #2100 / #2109; s-1 → #2101 / #2110; s-2 → #2102 / #2112; s-3 → #2103 / #2113; s-4 → #2104 / #2114; s-5 → #2105 / #2111.

Promises kept: -1 +4/−5 source → +13/−9 (+63 tests); s-1 −3 → −3; s-2 net 0 → net 0 (one copy fewer); s-3 −4.1 KB → −4.0 KB; s-4 −1.4 KB → −7 lines; s-5 825 → ~680 → 727 at merge (later 740 with a bench step).

Verified in the main loop before ranking: two partials declaring `bump` with one shared `ZodEmpty` schema build without error and run A's precondition with B's handler (control, distinct schemas: `Duplicate action`); `Act.correlate` defaults `{ limit: 10 }` on the parameter (act.ts), so `{}` reads with no limit while its JSDoc says 10; `types/builders.ts:472` and `:494` `@returns` omit `.requires`; feeding `holds` the raw payload instead of the validated one leaves `preconditions.spec` and wolfdesk green (29 tests); `backoff.spec.ts:481` sleeps 20 ms inside a 50 ms backoff window and then asserts no retry (a >30 ms stall fails it; the specialist probed six such tests with a stall and a control).

Proposals (pending), ranked. Defects first (outside the cap):
- P2026-10-25-1 (f-D1). Partial states that share one action schema merge silently. `merge.ts` skips the duplicate-action check when the schemas are identical ("the same partial re-registered via another slice"), but distinct partials sharing an exported schema or `ZodEmpty` match too; the spreads then pair one partial's `given`/`requires` with the other's handler, depending on order. Key the skip on the handler (`existing.on[name] === state.on[name]`): a re-registered partial carries the same handler, two partials never do. Simulated: the probe throws `Duplicate action "bump"`, libs/act and packages 3,913 green. Behavior: an app declaring one action in two partials with a shared schema now fails at build, as intended.
- P2026-10-25-2 (f-D2). `app.correlate`'s default limit applies only when the argument is omitted; the assistant's #2106 JSDoc says "default 10" for every call. Code: default `{}` and `query.limit ?? 10`, so `{}` or a leftover filter reads 10, not the whole log (`correlate.spec.ts:228` pins `{}` as unbounded today and changes); or docs only. Recommended: the code fix.
- P2026-10-25-3 (x-D1 + notes). Docs that contradict the code after #2115: `ActionBuilder.on`'s `@returns` ("`.given()` and `.emit()`"), `.given`'s ("`.emit()`"), the bare `.emit` doc ("Same two overloads as the post-`.given()` form"); wolfdesk.flow.json's state description says only "invariants". Fixed by s-1 where they overlap.
- P2026-10-25-4 (t-D1). Six time-budget tests that go red after one short stall: `backoff.spec.ts:481/494` (20 ms sleep in a 50 ms window), `:432` (two windows 30 ms apart; its name describes a backoff map #1872 removed), `:170`, `defer.spec.ts:414` and `:488`, `scope.spec.ts:332` (a fixed 60 ms wait for a lane worker); `act.spec.ts:369` by reading. "Not yet" checks move a faked `Date` by hand, as backoff.spec's own no-backoff block does; result checks use `vi.waitFor`; the breaker test widens its cooldown.
- P2026-10-25-5 (t-D2 + f findings). Tests that don't pin their names: `preconditions.spec` "passes the validated payload…" (the assistant's, #2115; row 87) checks only a description, so `holds(payload)` instead of `holds(validated)` passes; `correlate.spec.ts:1418` "stops a second worker … from scanning" asserts only `scans > 0`, so a worker refused the lease can scan (row 105's lanes test has the same gap). Add a schema-default payload assertion, scan-count assertions, and the retry × `.requires` probe as a test; drop TEST 31's redundant inline case in type-check.ts.
Simplifications:
- P2026-10-25s-1 (f-1 + d-1 + x-1). One module-local `ActionRules` type for what follows `.on()` and `.given()`, so `.requires` and `.emit` and their docs are declared once; fixes P2026-10-25-3's `@returns`. `types/builders.ts` 1,154 → 1,096 (−58 after Biome, simulated); the published d.ts changes shape only, no surface change. Keep the type above the `ActionBuilder` doc (the detachment learning) and check hover docs.
- P2026-10-25s-2 (f-2 + x-3 + d-2). `action()` checks both layers with one loop style (`for … of me.given?.[action] ?? []`, the same for `requires`), and the builder writes both maps the same way (−18: event-sourcing.ts −9, state-builder.ts −9; simulated, 100%).
- P2026-10-25s-3 (x-2). Delete 48 dead `eslint-disable` comments (ESLint left in May; 13 in `libs/*/src`) and the 3 unused imports Biome only warns about (`event-sourcing.ts` `Patch`, `ports.ts` `ExitCodes`, `test/sandbox.ts` `Cache`/`Store`) (−49).
- P2026-10-25s-4 (d-3). One private `_tx(op, work)` per SQL adapter for the five claim/subscribe/ack/block/truncate scaffolds (−30; pg −21, sqlite −9); `commit`, `restore` and sqlite's `_update` keep their own error mapping. One owner for the rollback-and-wrap policy.
- P2026-10-25s-5 (d-4). act-diagram's CLI `format.ts` and `markdown.ts` find an action with the same loop and inline type; one `find_action` (−16).
- P2026-10-25s-6 (x-4, backlog P2026-10-23p-2). Workflow and Renovate comments cut to their why (~130 of 180 workflow comment lines; renovate.json's 17 ticket-history descriptions).

Findings, not proposed: `InvariantError` keeps `rule` only in the message (a field would be new surface); knip lists unpublished `export` keywords on types `types/index.ts` doesn't re-export (`ReactionDo`, `BuilderBase`, `FoldFlush`, …) and act-diagram helpers outside its entry points (0 lines either way); 78 ticket references in non-core `libs/*/src` comments (act-http 49) for a future comment lens; the act-diagram printers label the two layers differently (CLI "requires", layout "guards", player "Preconditions"); the PG `ack`/`block` BEGIN/COMMIT around one UPDATE is a perf question for a real-adapter bench.

Lens metrics: SQL transaction scaffolds 10 (→ 2 with s-4); #2115 twin copies across layers 5 sites (→ 0 if s-1, s-2, s-5 ship); time-budget tests red after a ≤100 ms stall: 6 probed, 1 by reading; contract-cited tests whose body doesn't pin their name: 1 (row 87), plus 1 uncited; interactions classified 12 (2 accidental, both defects; 8 shared primitive; 1 harmless; 1 none).

Tickets (user: "do it"): #2123 (P2026-10-25-1), #2124 (-2), #2125 (-3), #2126 (-4), #2127 (-5), #2128 (s-1), #2129 (s-2), #2130 (s-3), #2131 (s-4), #2132 (s-5), #2133 (s-6).

### 2026-10-27 — full run (four specialists: file budget + reading path + public surface, concepts and options + field, source of truth + examples, process + infra)

| metric | 2026-10-25 | now | why |
|---|---|---|---|
| core lines (libs/act/src) | 17798 | 17699 | #2137 (−74), #2140 (−17), #2141 (−15); #2135, #2136 (+4) |
| spec files / test lines | 216 / 59838 | 216 / 59958 | #2138, #2139 (+78), #2135, #2136 (+51); #2141 (−21) |
| CI workflows / lines | 5 / 740 | 5 / 629 | #2144 (comments cut to their why) |
| docs lines / CLAUDE.md | 9317 / 27 KB | 9344 / 27 KB | #2134 (`.requires` across the docs), #2155 |
| everything else | | unchanged | 51 exports, 8 / 20 / 18 / 11, 9 files touching 5+ features, 9 files over 300 code lines, 29% / 14% comments, 0 ticket refs |

Audit: 17 PRs since the last run: its eleven tickets (#2135–#2144 and #2134, which taught `.requires` across the docs), and three found while upgrading the Risk app to act 1.34 (#2153, #2154, #2155). Two fix-on-fix chains, both the assistant's: #2153 fixed the recurring-reminder test #2119 had fixed (its fake clock jump covered the lease but not the failed pass's real-time retry wake), and #2154 first hid the framework import behind a variable path, then removed it once the user asked why a browser component imports the backend at all. #2136 fixed `app.correlate`'s default but missed the poll's `query.limit || undefined` (P2026-10-27-2).

Decisions on P2026-10-25*: all accepted and shipped. -1 → #2123 / #2135; -2 → #2124 / #2136; -3 + s-1 → #2125, #2128 / #2137; -4 → #2126 / #2138; -5 → #2127 / #2139; s-2 → #2129 / #2140; s-3 → #2130 / #2141; s-4 → #2131 / #2142; s-5 → #2132 / #2143; s-6 → #2133 / #2144.

Promises kept: -1 source +3 (+21 tests); -2 +1 (+30 tests); s-1 −58 → −74; s-2 −18 → −17; s-3 −49 → −49 (−15 source, −21 tests, the rest benches and act-diagram); s-4 −30 → −30; s-5 −16 → −20; s-6 ~−130 comment lines → workflows −111 lines.

Verified in the main loop before ranking: with `validateFoldedState`, `do("divide")` rejects with `ValidationError` while the store holds `[added, dividedByZero]`, and the next `do("add")` on the stream rejects too (control: a `.given` refusal commits nothing); `act.ts:1052` stores `query.limit || undefined` and settle reads `q.limit ?? this._poll_limit ?? 100`; `GivenHandlers` says invariants "must hold after the action" (types/action.ts:500) and four builder docs say an action must emit an event, while `action()` checks invariants before the handler and returns `[snapshot]` for `undefined` or `[]` (event-sourcing.ts:445, :466-470).

Proposals (pending), ranked. Defects first (outside the cap):
- P2026-10-27-1 (o-1 + d-D4). `validateFoldedState` refuses the caller after the commit. Its docs (configuration.md:176, `ActOptions` JSDoc, RFC 2086:203, contract row 269) read as a refusal that stores nothing. Docs say plainly that the event is stored, reactions run on it, and the stream then fails every `load` until the reducer is fixed or the flag is off; the JSDoc's hot-path essay becomes a link (−16); a test pins it. A code fix (fold before commit, as Emmett and Axon do) needs a provisional row for reducers that read `id`/`version`/`created`: not proposed, the user's call.
- P2026-10-27-2 (c-1). `start_correlations({ limit: 0 })` scans 100, because the poll stores `query.limit || undefined`. Store `query.limit` as given and say in the doc that 0 reads everything, or document that 0 means the default here. The user decides which; 0 means "no limit" everywhere else.
- P2026-10-27-3 (c-2 + d-D2, D3). Published doc comments that contradict the code: `GivenHandlers` "after the action" (before the handler), four "must emit one or more / at least one event" (types/builders.ts:461, :478, :502, :527; types/action.ts:469), `Act.do` and `action()` "checks invariants" without preconditions. Words only.
- P2026-10-27-4 (d-D1, D5). The scaffold skill teaches a `throw` in `.emit` for a rule that combines state and payload (act-api.md:364-373, "cannot" be declared), and SKILL.md:91 calls `.given` "preconditions". Fixed by s-4.
- P2026-10-27-5 (p-D1). rfcs/README.md says the snapshot runs in every package (it is the root `test/`), points at a PR-template checkbox 0 of 300 PRs carry, and says the pre-handoff steps live in CLAUDE.md with a required learnings entry. Fixed by s-5.
Simplifications:
- P2026-10-27s-1 (c-s-1). The internal correlate path passes `limit`, not a `Query`: `_correlate_pass`, `CorrelateCycle.correlate`, `_scan` and settle's `{ ...q, limit }` carry filters nothing reads since #2106 (−5, one type and one comment off the reading path; public `Act.correlate(query)` stays). Simulated, 100%.
- P2026-10-27s-2 (c-s-2, backlog P2026-10-23b-2 lane half). Lane wiring derives each fact once: the no-`onlyLanes` check written three times (one redundant), `validate_only_lanes` rebuilding `_declared_lanes`, `options.drain !== false` where `this._drain` holds it (−4). Simulated, 100%.
- P2026-10-27s-3 (c-s-3). `action()`: one early return for `undefined` or `[]`, and the event array stops sharing the name `valid` with the invariant predicate (−3). Simulated, 100%.
- P2026-10-27s-4 (d-1 + d-2). The scaffold skill keeps business rules in domain.md only: act-api.md §8 keeps the two type signatures and a link (−30 lines, ~2.2 KB; fixes -4), and server.md's seed drops its three fixed correlate/drain rounds (each `do` settles; −6).
- P2026-10-27s-5 (p-1 + p-2). Delete the PR template (0 of 300 PR bodies; `/pr` writes the body) and the RFC `Status:` lines (17 of 17 shipped RFCs say `draft`; nothing reads them; mark 0002 rejected in its title); rfcs/README.md points at `/pr` and CONTRIBUTING.md (−1 file, −57 lines; fixes -5).
- P2026-10-27s-6 (p-4). conformance.yml's two summary-append steps and the stress artifact upload re-print logs and can't fail (−45, 629 → ~584); every gate (`bench:check`, scenario bounds, stress) stays.
- P2026-10-27s-7 (d-3 + d-4 + o-2). Docs that repeat another page: CLAUDE.md's CLI section and benchmark paragraph (−1.6 KB), real-time.md's copy of the act-sse rename list (link STABILITY.md; "four `getX`" → "four renamed methods", `publishOverlay` isn't one), configuration.md § Circuit breaker's paragraph from error-handling.md (−0.8 KB).

Findings, not proposed: `InvariantError.rule` lives only in the message, so code needing the layer parses text (a field is new surface); ActOptions has 12 fields and apps set 3 (`autoSettle`, `scoped`, `correlator`); `settleDebounceMs` and `SettleOptions.debounceMs` spell one idea twice (both published); 13 of 19 snapshot changes since #2045 were not public surface and four PRs needed a regenerate-only commit, but the snapshot keeps doc comments on purpose (detached docs, #2058) and `runStabilityTck` is published; the `Act.restore` closure-variable item re-measured at −1 and leaves the backlog; perf baselines date from 2026-08-22; the player and the commit-race scene still say "invariant" where they mean either layer.

Lens metrics: files over 300 code lines 9 (act.ts 802, in-memory-store 730, audit 566, event-sourcing 473, types/builders 464, drain-cycle 457, close-cycle 450, correlate-cycle 419, types/action 325); reading path 13 runtime files, ~33 names (~32 with s-1 and s-3); master red from flakes since 2026-10-20: 3 runs (2 tests, both fixed), plus 2 PR flakes hidden by re-runs; PR template use 0 of 300; RFCs still `draft` after shipping 17 of 17.


Tickets (user: "file them all"): #2157 (P2026-10-27-1), #2158 (-2), #2159 (-3), #2160 (-4), #2161 (-5), #2162 (s-1), #2163 (s-2), #2164 (s-3), #2165 (s-4), #2166 (s-5), #2167 (s-6), #2168 (s-7).

### 2026-10-29 — full run (four specialists: feature interactions + field, tests by concept, DRY across adapters and builders, dead code + comment noise)

| metric | 2026-10-27 | now | why |
|---|---|---|---|
| core lines (libs/act/src) | 17699 | 17744 | #2180 (+246/−201: the fold before the commit, preconditions, `PreconditionError`), #2174–#2176 (−12) |
| comments | 42% | 42% (29% / 14%) | |
| ticket refs in source | 0 | 1 | the regex now ignores case and finds `Symbol("act-1103/all-lanes")` in `classify.ts` (it was always there) |
| runtime exports | 51 | 52 | `PreconditionError` (#2180, planned with #2182/#2183; earned) |
| spec files / test lines | 216 / 59958 | 218 / 60320 | #2180 (`invariants.spec`, `action-fold.spec`), #2185 |
| CI workflows / lines | 5 / 629 | 5 / 575 | #2177 |
| docs lines | 9344 | 9385 | #2180 (preconditions across the docs), #2188 |
| everything else | | unchanged | 8 / 20 / 18 / 11, 9 files touching 5+ features, 9 files over 300 code lines, CLAUDE.md 27 KB |

Audit: 19 PRs since the last run: its twelve tickets (#2170–#2178), #2180 (the assistant's: one fold before the commit, preconditions replace `.given`, the state schema checked before every commit, five deprecations until 2.0), #2185 (two specs wait for outcomes), #2186 (act-diagram popups show schemas, +356), #2188 and #2189 (docs). #2180 is the new hotspot: every defect this run found, but one, sits where its new check or the rule layers meet another feature. Its schema check reads the actor-gated view, a regression for sensitive streams that no spec covers because none combines the two features.

Decisions on P2026-10-27*: all accepted and shipped. -1 → #2157, shipped as the code fix (#2180) rather than the docs the proposal recommended; -2 → #2158 / #2173, the user kept the code and documented 0 as the background default; -3 → #2159 / #2170; -4 + s-4 → #2160, #2165 / #2171; -5 + s-5 → #2161, #2166 / #2172; s-1 → #2162 / #2174; s-2 → #2163 / #2175; s-3 → #2164 / #2176; s-6 → #2167 / #2177; s-7 → #2168 / #2178.

Promises kept: s-1 −5 → −5; s-2 −4 → −4; s-3 −3 → −3; s-4 −36 → −33; s-5 −57 → −55; s-6 −45 → −54; s-7 ~−2.4 KB → −9 lines (5 files).

Verified in the main loop before ranking: the specialist's probe file, re-run from the repo (13 of 13: every red reproduces and every control passes): another actor's action on a stream with a `z.email()` state field fed by a `sensitive` event field is refused with `ValidationError`, the owner passes, a `z.string()` field passes, and after `forget` the owner is refused too; a reaction commit lands on a stale load and stores `n=3` under `max(2)`, after which every action fails, while the same race as a user action gets `ConcurrencyError`; two concurrent `open`s of a new stream both pass "cannot open twice"; a state `.refine` that throws rejects with a raw `Error` while the same throw in a payload schema gives `ValidationError`. Also read: concurrency-model.md's "stream leasing already serializes concurrent reactions on the same stream" against wolfdesk's three timer targets; `errors.ts` ("adapters wrap their driver errors in `StoreError`") against act-sqlite's `store.error.spec.ts:303-320`, which pins the raw driver message; `invariants.spec.ts:52-53` awaiting the void `settle()`; act-test-author.md's `f()` and synchronous `sandbox` against `test/sandbox.ts`.

Proposals (pending), ranked. Defects first (outside the cap):
- P2026-10-29-1 (i-P1). The state schema check refuses actions on sensitive streams (regression from #2180). `action()` loads through `me.view(raw, actor)` and checks that view, so `[REDACTED]` fails any typed state field another actor's action folds, and after `app.forget` `[SHREDDED]` locks the stream for everyone. (a) Skip the check when `me.pii_aware`, as the cache and `.snap` already do (one line; restores 1.34; those states lose the check). (b) Docs only: a state field fed by a sensitive field must accept any string (leaves the forget lock-out). A contract row and a test either way. The user's call; (a) recommended, since (b) leaves a stream that can't take any action after an erasure.
- P2026-10-29-2 (i-P3). Reaction commits skip the inferred version guard, so preconditions and the schema check can pass on a stale load and a reaction can store a state the schema rejects. The documented reason (leases serialize them) doesn't hold: a lease is per target, not per stream written. Guard reactions like any action (−15 in `action()`: the branch, the gapped-fold cache handling; −15 doc lines). Simulated: 4 tests fail, 3 pin the guardless path, and wolfdesk's timers now conflict and need `maxRetries` (or reaction dispatch retries on conflict). Emmett guards always, with an optional retry on conflict. Changes what apps observe: the user's call. Docs-only alternative: row 271 and concurrency-model.md say plainly that reaction commits are unguarded.
- P2026-10-29-3 (i-P2). The first commit to a new stream is unguarded (`snapshot.version >= 0 ? … : undefined`, since the original `event?.version`), so two racing creators both pass `.requires` (wolfdesk's `OpenTicket`). Always pass the loaded version (−2) and add a TCK case for `expectedVersion: -1` on a non-empty stream (+~12); the port doc says what −1 means. Simulated: act, sqlite, http and packages green; act-pg not run.
- P2026-10-29-4 (dry-D2). `check_invariants` is a copy of `validate` that lost its wrap of non-Zod throws: a throwing state `.refine` surfaces as a raw `Error` (HTTP 500) instead of `ValidationError` (422). Call `validate` and discard the result (−17). Simulated, coverage identical.
- P2026-10-29-5 (dry-D1). The SQL adapters' recovery writes (`reset`, `unblock`, `prioritize`, `defer`) break the `StoreError` promise: act-sqlite wraps only `defer`, with its own try/catch, and its `_update` hand-rolls a sixth transaction scaffold; act-pg wraps none. One `_update(operation, …)` per adapter through `_tx` (sqlite −6, pg +9, net +3; 3 sqlite assertions move to `StoreError`, one PG fault-injection test). Only operator calls reach these; the breaker is not involved.
- P2026-10-29-6 (t-D1 + t-D2 + dc-D1). Tests and docs that can't fail or don't match the code: `invariants.spec.ts:52` asserts "no reaction ran" after a void `settle()` (use `autoSettle: false` + `correlate()`/`drain()`); act-test-author.md teaches a `fixture`/`sandbox` API that doesn't exist (copy `sandbox.ts`'s `@example`s); four doc blocks sit above the wrong declaration (act-http `BroadcastChannel` ships with no doc, `projection()`'s overview and example sit on `_projection`, `compile_autoclose_policy`, classify's result doc above `ALL_LANES`, whose symbol carries `act-1103`); `tracing.ts:175` and `tracing.spec.ts:58` describe a validating patch step #2180 deleted. Words and one test (~+3).
Simplifications:
- P2026-10-29s-1 (dry-S1 + dc-P1 + i-P4). Drop the internal `patch_fn` plumbing that has had one value since #2180: `make_fold_handler`'s parameter, the builder's import and argument (−9 source, −5 test, after Biome; making every non-`bare_patch` value throw failed 0 of 1,986 tests). The public `Act` constructor's `patch_fn?` and `PatchFn` stay.
- P2026-10-29s-2 (t-1 + t-2). Tests #2180 left pinning nothing another test pins: `preconditions.spec` "stops at the first … in declaration order" (three loop mutations: every red it shows, "refuses at the first …" shows), `invariants.spec` "leaves a well-behaved app unchanged", three `event-sourcing.spec` cases (empty-events duplicate, empty `requires`, empty `.given`); `action-fold.spec` (one test, row 273) merges into `invariants.spec` (−88 lines, −5 tests, −1 file; coverage identical; row 87 drops one citation).
- P2026-10-29s-3 (dc-P2). act-http comments cut to their why: 50% comments and 51 ticket refs; `sse/broadcast.ts` alone 441 → 343 lines with no code line changed (fixes its detached class doc), ~−250 comment lines for the package. One PR per package; the other 34 refs outside core (act-diagram 17, act-ops 7) follow the same way.

Findings, not proposed: projection-fold.ts:102 (`fields.length ?` on the PII head load) is covered only by timing elsewhere in the suite: one modified run read 99.94% branches and the rerun 100%, and the narrow specs reach 95% on master too — a coverage-gate flake waiting to happen, worth one direct test; the snapshot and cache keep the `-1` placeholder id a reducer copies into state while a cold replay holds the real id (documented by the decider rule; reducers should read `data` and `version`); the schema-check `ValidationError` says "payload" when it is the state; act-pg's `scripts/drain-contention.ts` has no reference (kept on purpose by #2089/#2093, now on the knip list); act-diagram's printers fall back `preconditions ?? invariants` in four places (deprecated surface, goes in 2.0); openapi hand-lists the error statuses ERROR_MAP holds; 28 sleep-then-absence checks in 14 files are weak (a stall makes them pass), not flaky.

Lens metrics: interactions classified 6 (4 accidental, all defects; 1 resolved; 1 harmless); defects from #2180 4 of 6; ticket refs outside core 85 (78 last run); knip unused files 40 (39 known false positives, 1 now listed); stacked doc blocks 4; tests that pin nothing new 5; awaited void `settle()` before an absence check 1 of 16.

Tickets (user: "file the tickets"; decisions on -1 (a or b) and -2 (guard or docs) left in the tickets): #2190 (P2026-10-29-1), #2191 (-2), #2192 (-3), #2193 (-4), #2194 (-5), #2195 (-6), #2196 (s-1), #2197 (s-2, with the projection-fold.ts:102 coverage test), #2198 (s-3).
