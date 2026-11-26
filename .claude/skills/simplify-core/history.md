# Simplify-core history

The skill's memory. Read it first on every run; the retrospective (step 7) updates it. Newest run last.

## Lens rotation

Least recently run goes next. A lens with no accepted proposal in its last three runs is retired (it can be revived with a reason).

| lens | last run | runs | accepted | status |
|---|---|---|---|---|
| Public surface | 2026-11-19 | 13 | 3 | active (58 root exports; act-http 33 runtime values / 11 entries; 1 non-importable default (#2595); the RFC-2578 types the generators name aren't walked by the snapshot, the maintainer's call) |
| Dead code (tool) | 2026-11-19 | 14 | 12 | active (knip 46 files / 19 exports / 27 types, all known; act-http src clean) |
| Hotspots (tool) | 2026-10-20 | 5 | 1 | retired 2026-10-20: two runs with no proposal; every branch in the hot functions (correlate, action, drain) is a separate rule |
| File budget | 2026-11-19 | 14 | 2 | active (9 over 300 code lines: `types/builders.ts` 272 → 308 from #2583's type parameter, earned) |
| Comment noise | 2026-11-19 | 14 | 12 | active (trpc 40% comments, cut (#2595); `TActionStates` doc pasted 5×; 2 stale passages on publication (#2592)) |
| Concepts and options | 2026-11-26 | 15 | 5 | active (18 core bags, 7 satellite schemas, 3 plain checks; 2 accepted-but-unread fields (`heartbeatMs` on tRPC #2621, `Encryption.algorithm`, public); `streamLimit: 0` stalls a lane (#2624); `runSseSubscription`'s `maxPending` unchecked (#2627)) |
| Core or decorator? | 2026-10-15 | 3 | 0 | retired 2026-10-15: three runs, findings only (PII, audit, breaker, lanes stay; priority is a major-version question) |
| DRY across adapters and builders | 2026-11-19 | 14 | 20 | active (act-http: 3 subscription loops → 2, refusals 2 copies → 1 (#2593); no new copies across stores or builders) |
| Reading path | 2026-11-26 | 14 | 3 | active (do/settle 13 files, ~33 names; restore 8 files, ~18 names, unchanged) |
| Newcomer test (quarterly) | 2026-11-15 | 3 | 0 | retired 2026-11-15: three runs, no proposal (21 concepts, 3 imports, unchanged; the package.json crash is fixed; `SLEEP_MS` waits 100 ms per call (#2521)) |
| Tests by concept | 2026-11-26 | 14 | 24 | active (4451 tests, 15.2 s with Postgres; 0 near a framework default; 5 act-http sleeps, 2 lose under a stall (#2634); a cited heartbeat test asserts nothing (#2625)) |
| Mutation evidence (monthly, CI) | never | 0 | 0 | retired: setup removed (#1805), see baselines below |
| Packages earn their place | 2026-10-15 | 4 | 0 | retired 2026-10-15: four runs, no proposal (removal is ruled out; act-tck churn is the snapshot, now P2026-10-15p-1) |
| Infra | 2026-11-19 | 14 | 4 | active (142 runs, 4 red; one generated paths file (#2594); perf and stress jobs stop building (#2595)) |
| One source of truth | 2026-11-26 | 15 | 11 | active (SSE docs: 2 lossy hand-written loops, 4 publish listeners beside `publish: true`, 3 option lists (2 drifted), 7 stale per-transport claims (#2628)) |
| Examples | 2026-11-26 | 14 | 6 | active (recipes 6/6, recipes + packages 260 tests; no-check snippets 228 (+15); scaffold generates the hand-written auth actions (#2623); tRPC ping lost unless the generated router merges first (#2625)) |
| Process | 2026-11-19 | 13 | 10 | active (19 PRs, 4 red runs: an MDX brace, a fixture-named test, two perf reds from #2555's cause; `check:contracts` added to /release-check (#2601)) |
| Feature interactions | 2026-11-19 | 14 | 20 | active (6 probed: `$settled` misses non-settle drains (#2589), per-state subscriptions skip `streams` (#2590); per-state as a one-stream `$live` (#2596) and SSE refused for any sensitive state (#2599) are the maintainer's call) |

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
| app errors, correlation | one throwing resolver stops the scan before its event, so discovery stops for every reaction until it stops throwing | justified | #1913, the user's choice: nothing is lost; isolating one reaction needs per-reaction checkpoints. A bad dynamic lane runs on `default`, and since #2469 a bad dynamic priority runs at 0: two policies for bad resolver output |
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
| priority check, build / correlate / `app.prioritize` | one `TargetOptionsSchema` (int32) at three entry points | shared primitive | Postgres stores `int`; a static target is checked at build, a dynamic one only at correlate (#2459) |
| dynamic priority check, checkpoint / work mark | a bad priority runs at 0, like a bad lane on `default` | resolved | #2469 (contract row 160); `check("target")` in a try/catch since #2514, same behavior |
| restore causation `-1`, audit / inspector / reducers | a cause a close or prune deleted is `-1` after restore; it matches no event | harmless | probed retire, restart and prune: the same orphan-parent findings before and after; reducers' `-1` is `event.id`, another field |
| autoclose terminal close, close guard | the terminal close parks one short of the head for a day; the full close's guard skips `__autoclose__:` rows, the windowed close relies on `at` | justified | #2483: the retry needs the pending event; the windowed hold also caps the prune below the head |
| restore, other workers on the store | another process keeps the correlation lease and scans from its old checkpoint: 10 of 20 restored events run (control, one worker: 20 of 20) | justified, documented | the port doc and event-sourcing.md both say to restart other processes (checked 2026-11-15) |
| restore, drain in flight | the in-flight `ack` writes nothing into the restored store | harmless | InMemory probe 3 of 3; Postgres not probed |
| correlate outcome, lane arming / settle progress | Act arms on `marked > 0` and settle counts `read` | resolved | #2084 (P2026-10-22f-2); `subscribed` stays only in `app.correlate()`'s public return |
| explicit correlate filter, shared checkpoint | the scan reads only `limit` | resolved | #2106 (P2026-10-23-1) |
| `app.correlate` default, a query without `limit` | the default `{ limit: 10 }` sits on the parameter, so `{}` or a leftover `{ stream }` reads the whole log while the JSDoc says 10 | resolved (checked in the code 2026-11-11) | P2026-10-25-2 |
| `.given`/`.requires`/`on`, partial-state merge | `merge.ts` skips the duplicate-action check on schema identity, so two partials sharing one action schema merge silently: one partial's rules with the other's handler, by order | resolved (checked in the code 2026-11-11) | P2026-10-25-1 (probed in the main loop); goes when the check keys on the handler |
| `.requires`, per-action retry | the `ConcurrencyError` retry re-runs `load` and every rule | shared primitive | probed; no test pins it yet (P2026-10-25-5) |
| `.requires`, sensitive fields | one actor-gated snapshot feeds `given`, `requires` and `.emit` | shared primitive | probed: both see `[REDACTED]` for another actor |
| `.requires`, act-http errors | the class map gives 409 `INVARIANT`; only the message names the layer | shared primitive | `rule` is a constructor argument, not a field |
| empty block/ack skipped (#2117), breaker / lifecycle | a pass that only blocks makes no ack call and emits no `acked`; `breaker.passed()` still runs | harmless | probed |
| `start_correlations` limit, `Query.limit` | the poll stores `query.limit \|\| undefined`, so `0` ("no limit" everywhere else) becomes settle's default 100 | justified, documented | #2173: the user kept the code and documented that a poll's 0 uses the background default |
| `validateFoldedState`, commit | #2180 folds once before the commit and checks the state schema there; the option is ignored | resolved | #2180 (P2026-10-27-1) |
| state schema check, sensitive fields / forget | `action()` checks the actor's view, so `[REDACTED]` or `[SHREDDED]` fails a typed field (`z.email()`): another actor's action is refused, and after `forget` every action is | resolved (checked in the code 2026-11-11) | P2026-10-29-1 (probed in the main loop; passes on 10fa801c9) |
| reactions, optimistic concurrency | `reactingTo ? expectedVersion : expected` lets a reaction commit on a stale load; the docs say leases serialize these writes, but a lease is per reaction target, not per stream written (wolfdesk's three timers write one ticket under three targets), and never against user actions | resolved (checked in the code 2026-11-11) | P2026-10-29-2 (probed: a stored state breaks `max(2)`, then every action fails) |
| first commit, optimistic concurrency | `snapshot.version >= 0 ? … : undefined` leaves a new stream unguarded, so two racing creators both pass `.requires` | resolved (checked in the code 2026-11-11) | P2026-10-29-3 (probed) |
| state check, payload check | `check_invariants` re-implements `validate` with `safeParse` and drops its wrap of non-Zod throws | resolved (checked in the code 2026-11-11) | P2026-10-29-4 (probed: raw `Error`, HTTP 500, vs `ValidationError`, 422) |
| projection folds, `Act` constructor `patch_fn` | the constructor's patch step reaches `load`/`action`; projection folds always get `bare_patch` from the builder | harmless (one value in the repo since #2180) | P2026-10-29s-1 |
| action retry, reaction retry | a reaction's `do()` that loses a race retries in `action()` (its `maxRetries`), then fails the handler into the reaction's retry and backoff | justified | the two decide different things: the action re-decides on fresh state at once, the reaction treats the whole handler as failed (10 s fixed backoff by default); they multiply, (N+1)(M+1) attempts, only on a conflict that never clears (probed 2026-10-30) |
| `reactingTo`, version guard | resolved by #2201: `reactingTo` only builds correlation and causation | resolved | #2201; the ambient box clearing in `scoped.ts` stays for causation (simulated: one test fails without it) |
| empty action, `committed` / wake | `Act.do` read `s.event` on every snapshot, including the loaded one an action that emits nothing returns | resolved (checked in the code 2026-11-11) | P2026-10-30 r-1 → #2210 / #2213 (probed in the main loop) |
| `.loads`, optimistic concurrency | every written stream gets its version at load in one `commit`; a read-only load isn't guarded; a conflict drops only that stream's cache entry; a version the caller pins is never retried on its own stream, but is retried on a loaded one | shared primitive | the version guard (#2289); `loads.spec` pins every case |
| `.loads`, snapshots | each written stream runs its own state's `.snap` in the same per-append loop; the result's `version` is the snapshot head | shared primitive | probed: with snaps, the version the listener hears on the loaded stream, pinned on the owner's next action, commits; `taken` = 5 both ways (`probe-loads-snap.spec.ts`) |
| `.loads`, sensitive fields | a loaded stream loads with the caller's actor; `check_invariants` gets the loaded state's `pii_aware`; a sensitive state isn't cached and can't `.snap`, both through the same rules | shared primitive | `loads.spec` "loads with the caller's actor" |
| `.loads`, state-schema check | each written stream is checked once, on its own state's schema; a read-only load isn't checked | shared primitive | the decider rule; reads aren't writes |
| `.loads`, `committed` / state-scoped `committed` | `Act.do` groups by stream, its own first, and finds a loaded stream's state from the load that lists its first event | justified | `action()` already knows each append's state, but returning it changes `EsOps.action` (trace seam) and about 10 direct `action(...)` test calls, to save about 6 lines. Not worth it |
| `.loads`, reactions / lanes / priority / autoclose | events appended to a loaded stream wake by event name (`_wake` gets every name); the default target and autoclose resolve from `e.stream` | shared primitive | nothing in those features reads `.loads` |
| `.loads`, act-http APIs / SSE | `app.do` returns its own snapshots, so generated APIs stay typed as without loads; SSE broadcasts from `committed`, once per stream (real-time.md:105) | shared primitive | the per-stream `committed` listener |
| `.loads`, close | a load of a closed stream throws `StreamClosedError`; a close racing a commit loses on the version guard | shared primitive | `loads.spec` "a load of a closed stream refuses the whole commit" |
| `.loads`, act-otel | `act_events_committed_total` counts per event across the per-stream `committed` calls | shared primitive | correct with per-stream calls |
| source rule, a target reading itself | `is_literal_source(source, target)`: `source === target` is literal | justified, nearly unused since 03b4404ef | #2379 added `target` when every metacharacter made a pattern; 03b4404ef made only `^…`/`…$` patterns, so `target` now matters only for a stream name that starts with `^` or ends with `$`. It is published (`utils.ts`), so it stays (rule 2) |
| source rule, autoclose | the resolver skips a stream whose name would read as a pattern | justified, same reach | since 03b4404ef it skips only `^…`/`…$` names; `app.close` still closes them |
| snapshots, SSE versions | a `__snapshot__` takes a stream version the wiring never sends | resolved in code by #2405; three doc copies still teach the old wiring | #2428 |
| snapshots, version pins | a handler that pins `expectedVersion: event.version` is one behind after a snapshot | justified, documented | the recipe was fixed (#2436); probed 2026-11-15: with `.snap` the pin conflicts, without it commits. Root cause in the backlog (snapshots as stream events) |
| per-call correlator, app correlator | `{ correlator, ...options }` let an explicit `undefined` win | resolved (checked in the code 2026-11-11) | r-2 → #2211 / #2213 (probed in the main loop) |
| SSE broadcast, sensitive states | the cached state is the committer's view, served to every subscriber; another actor's commit overwrites it with markers | resolved (checked in the code 2026-11-11) | P2026-10-31 i-1 → #2232 (probed in the main loop) |
| marker-capable state fields: state check, sensitive-type warning, OpenAPI | one owner since #2233 | resolved (checked 2026-11-15) | i-2, i-3 → #2233 |
| state-scoped `committed`, generic `committed` | one call site in `Act.do`, after #2213's patch check | shared primitive | the empty-action check covers both (probed) |
| state-scoped `committed`, remote commits | neither fires for another process's commit; hosts use `notified` | justified | same as the generic listener |
| multi-stream commit, act-pg commit lock | a guard on a loaded stream that gets no events | resolved by design | only streams that get events reach `commit`; a read-only load is unguarded by contract (checked 2026-11-15) |
| restore, state projection fold caches | `app.reset` drops every fold cache before replaying; `app.restore` into its own store doesn't, so a `.of()` row keeps the old log's state, and a monotonic upsert refuses the renumbered row for good | accidental, a bug | #2517 (probed in the main loop: 3 vs 100; control `app.reset` after restore gives 100) |
| restore `batch_size`, sources that ignore paging (CsvFile) | the `at` skip in `scan` keeps each event once at any page size | harmless | probed with sizes 1, 2, 3 and 500 (2026-11-15) |
| `State.pii_aware`, cache / close / action / loads | set once by the builder, read by four features for one reason (a sensitive state's view depends on the reader) | shared primitive | an `@internal` field on a public type; hiding it is a reshape (2026-11-15) |
| `start_correlations` limit, settle passes | while the poll runs, its `limit` (`_poll_limit`) applies to every settle pass, not only the poll's ticks | justified, needs a doc sentence | the field keeps the poll's wakes from overwriting a caller's settle options; probed 2026-11-26: `limit: 1` reads 1 event per commit-driven pass (control 100), same result in more passes |
| SSE heartbeat, tRPC router composition | tRPC reads `sse.ping` from the root router; `mergeRouters` keeps the first router's config | justified, documented | tRPC's design (#2622); probed: generated alone or first pings, host first or nested doesn't (#2625) |

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

- Move `scan` from `internal/event-sourcing.ts` into `internal/restore.ts`; it took four guards in two weeks (#2459, #2482, #2484, #2487), each its own rule. Simulated 2026-11-15: 652 → 500 code lines there (still over 300: `action()` alone is 208), +5 net, suites green. Plainer, not smaller. (P2026-11-14d-4, P2026-11-15b-3)
- A `keep` stream that goes quiet stops pruning (#1619, close-policies.md:154). Since #2483 the terminal path parks a day; parking every `keep` stream the same way might drop #1619 and the `waiting` branch, at one `query_stats` per kept stream per day. Needs a probe. (P2026-11-14e-q)
- Design finding for a future major: a snapshot is an event in the stream, so it takes a version, and every reader of a version has to know about `.snap` (#2384 SSE, #2427 the timer recipe, the 2.0 "pin `version`, not `event.version`" note). Marten keeps snapshots as documents and counts only events; Axon keys them by the last event's sequence in a separate store; Kurrent recommends a separate stream; only Equinox's rolling snapshots on EventStore write into the stream as Act does. Moving them touches load, close seeds, the cache and every adapter. (2026-11-11, interactions)



- Design finding for a future major: priority (required `prioritize` port method, a column and two indexes per SQL adapter, a fairness reserve in 3 claims, the lane-rides-priority rule in 3 subscribes, 7 bugs) has no example user in this repo and no counterpart in other ES frameworks, which use separate processors (Act's lanes). Removing it is breaking; it is the user's question. 2026-10-11: Marten (per shard), Axon (per processor/segment), Kurrent (per group) and Emmett (per processor) all answer "a slow reaction must not block a fast one" with separate processors and none orders claims by priority; priority touches 13 source and 26 test files (2026-10-27: ~12 and 19), and dropping it also drops the lane/priority coupling behind #1599 and #1876.

- PostgresStore `commit`'s single-event SQL fork (4 statement variants → 2) if a CI bench shows it doesn't pay; `commit` is the most-changed function in the most-changed adapter. (P2026-10-11a-5)
- PostgresStore.commit returns the caller's pii instead of decrypting what it just wrote (one AES-GCM decrypt per pii event per commit, ~−7 lines). Apps see no change (the framework revives dates); direct `Store` callers would get the input value instead of an ISO string, as sqlite and InMemory already return. The user's call. (P2026-10-20b-5)
- One shared pii-encryption suite for act-pg and act-sqlite in an unpublished root `test/` file (~−390, a new cross-package test pattern; sqlite gains the declined-payload case). (P2026-10-20b-3, was P2026-10-11c-5)
- 53 core specs define their own `Counter` (~−140 with a shared fixture, but shared fixtures couple tests).
- Re-measured 2026-10-23 after #2072: moving restore's `scan` out alone takes event-sourcing.ts 467 → 338 code lines (still over 300) for +8 net; the lane half was +36 and act.ts is unchanged since. Still plainer, not smaller. Move lane wiring out of act.ts into `internal/lanes.ts` and restore's `scan` to `internal/restore.ts` (re-measured and simulated 2026-10-18: act.ts 811 → 647 code lines, event-sourcing.ts 467 → 338; +2 files, +36 code lines net, suite and coverage green). Plainer, not smaller. First close the test gap it found: removing the dry-run guard on restore's restart and arm keeps the suite green. The settle-drain half moved into P2026-10-18s-1. (P2026-10-15r-4, P2026-10-18b-2)
- configuration.md § Circuit breaker restates error-handling.md and misses "Store failures only"; act-tck README and tck-conformance.md hand-copy stale peer versions. Link instead. (P2026-10-15d-5; the observability.md half is in P2026-10-20r2-2)
- Design finding: the defer wake's "drain until a pass leases nothing" loop repeats settle's loop without correlate (the background-copies-foreground smell); routing it through settle adds `settled` events and a correlate per wake, so it doesn't subtract today.
- Resolved by #1959 (P2026-10-17d-2 → #1949): a local `do()` arms lanes but schedules nothing, while a remote commit (`_wire_notify`) already schedules settle; 22 copies of `app.on("committed", () => app.settle())` in 17 files exist only to close that gap, and no framework in the field asks for it (Marten, Emmett, Axon, Propulsion run processors on their own). Changing it changes what apps observe.

- The next major fixes once on its integration branch and merges into it without squashing: the 2.0 window fixed every audit round twice (#2337/#2336, #2357/#2359, #2379/#2380), merged master into `v2` four times (the duplicated test of #2386), and needed separate version PRs only because a squash flattens footers. Fewer words in CONTRIBUTING; 1.x waits for a backport. (P2026-11-10p-5)

## Self-changes
- 2026-11-26: the Concepts and options lens checks that every field of a bag several entry points take is read on each, and feeds each count its degenerate value (`heartbeatMs` read by Hono only, #2621; `streamLimit: 0` stalls while `eventLimit: 0` means all, #2624). The Tests by concept lens breaks the behavior a contract row cites and runs the test: #2622's Hono citation drove a timer and asserted nothing (#2625). learnings.md merges the two loop-class entries to make room for the shared-bag entry.

- 2026-11-15: the Public surface lens names how the stability snapshot walks files: a re-exported file is published whole, so a helper exported for a sibling ships though no app can import it, and a `types/` split that only imports the moved types drops them from the snapshot while they still ship (s-2, b-1). One smell added: a proposal that rewrites a rule to describe the code's current variety; the 11-14 run's o-1 and o-2 wrote the validators' four shapes into the rule, and #2514 replaced them with one pattern the next day. Retired the Newcomer test (three runs, no proposal).

- 2026-11-12: the Concepts and options lens now covers the satellites' public option bags and feeds each numeric option NaN. Core's bags hadn't changed since the last run, and the specialist found act-http's two bags unvalidated, one turning off replay protection (#2440).

- 2026-11-11: the DRY lens plants a restated copy of each moved rule, spelled differently, against `architecture.spec.ts`: #2408 moved the notification parser with no guard rule, and two rules matched only the exact old spelling, so their copies passed (#2429). The One source of truth lens counts copies of a behavior by grepping its code shape, not its wording: the 2026-11-10 run reported the SSE wiring as 6 agreeing copies; there were 9, and 3 disagreed (#2428).

- 2026-11-10: the Public surface lens checks every export tagged `@internal` against `docs/typedoc.json`'s `excludeInternal`: such an export is covered by the stability snapshot but has no reference page, and seven store helpers adapter authors are told to call were hidden that way. The Infra lens compares every version a test matrix pins with the packages' `engines` floor: Renovate raised the floor and node-compat kept testing below it.

- 2026-11-08: the Tests by concept lens reads test durations against the framework's defaults (the 10 s backoff and lease, 30 s timers): a test that takes almost exactly one isn't slow, it's stalled. Wolfdesk's 10 s tests hid two real stalls for weeks (`EscalateTicket` with no action retries, fixed 2026-11-07; one shared SQLite file, #2383). The Dead code lens lists the rules recipe's `tour.ts` with knip's known false positives.

- 2026-11-03: the Specialists section resizes the main pane to half the window right after spawning (the user: "the skill didnt remember to set the panel width to half the screen"; the rule lived only in memory). Specialists write their final report into their notes file: three of four reports arrived cut off in the idle notification, and two specialists stopped on the usage limit and were resumed from their notes. `metrics.sh` counts an RFC only if `rfcs/` has it: "RFC 4180" (the CSV standard) in an inspector test name read as a ticket ref.

- 2026-10-31: step 6 now tickets every verified finding when the report is done and closes each specialist as it reports; the specialists run as named teammates. The user gave the same instruction two runs in a row ("create tickets and close teammates as they finish") and asked not to repeat it. The Comment noise awk now checks the open before the close (it missed a one-line `/** */` above another) and uses `[ \t]` (macOS awk ignores `\s`); `metrics.sh` counts `RFC nnnn` refs. Evidence: act-diagram's `list_by_kind` doc and "RFC 1274" in a test name, both missed.

- 2026-10-30: step 2 now names the doc comments in the files a behavior-changing PR edited: #2201 updated every doc page and left `action()`'s own doc comment saying reactions skip the guard, two runs after learnings.md recorded the same miss (#1864). The Specialists section says `act-doc-writer` has no shell, so the Examples lens, which runs recipes, goes to a general-purpose agent: this run's docs specialist couldn't run them and the main loop found the broken close-the-books recipe.

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

Runs before the last three are one line each (with their tickets where the entry listed them); the full entries are in git history and each run's PR.

- 2026-10-07 — baseline (no lenses). Tickets: #1795.
- 2026-10-07 — first full run (four specialists).
- 2026-10-08 — weekly (one lens: Core or decorator?).
- 2026-10-08 — full run (four specialists: reading path + file budget, examples, process, source of truth + packages).
- 2026-10-08 — weekly (one lens: Dead code).
- 2026-10-08 — full run (four specialists: hotspots + concepts, DRY + comment noise, tests, infra + newcomer + field).
- 2026-10-10 — full run (four specialists: file budget + reading path, core or decorator + public surface, source of truth + examples, process + packages).
- 2026-10-10 — weekly (one lens: Feature interactions, new).
- 2026-10-11 — full run (four specialists: dead code + hotspots, concepts and options + DRY, tests by concept, infra + field).
- 2026-10-15 — full run (four specialists: feature interactions + concepts, reading path + file budget + public surface, source of truth + examples, process + packages + core or decorator + infra).
- 2026-10-17 — full run (four specialists: dead code + hotspots, DRY + comment noise + feature interactions, tests by concept, newcomer + field).
- 2026-10-18 — full run (four specialists: concepts and options + public surface on #1959, file budget + reading path + comment noise, source of truth + examples, process + infra + field).
- 2026-10-20 — full run (four specialists: dead code + hotspots, DRY across adapters and builders, tests by concept, feature interactions).
- 2026-10-20 (second) — full run (four specialists: file budget + reading path + comment noise, concepts and options + public surface on the #1973 → #2001 → #2025 chain, source of truth + examples, process + infra + field).
- 2026-10-22 — full run (four specialists: dead code + comment noise, DRY across adapters and builders, tests by concept, feature interactions + field).
- 2026-10-23 — full run (four specialists: file budget + reading path + public surface, concepts and options + field, source of truth + examples, process + infra).
- 2026-10-25 — full run (four specialists: dead code + comment noise, DRY across adapters and builders, tests by concept, feature interactions).
- 2026-10-27 — full run (four specialists: file budget + reading path + public surface, concepts and options + field, source of truth + examples, process + infra).
- 2026-10-29 — full run (four specialists: feature interactions + field, tests by concept, DRY across adapters and builders, dead code + comment noise).
- 2026-10-30 — full run (four specialists: file budget + reading path + public surface, concepts and options + field, source of truth + examples, process + infra). Tickets: #2206–#2212, #2214–#2217. Shipped during the run: #2213 (P2026-10-30-1, -2).
- 2026-10-31 — full run (four specialists: dead code + comment noise, DRY across adapters and builders, tests by concept, feature interactions + field). Tickets: #2231–#2242.
- 2026-11-03 — full run (four specialists: public surface + file budget + reading path, concepts and options + field, source of truth + examples, process + infra). Tickets: #2284–#2293.
- 2026-11-08 — full run (four specialists: dead code + comment noise, DRY across adapters and builders, tests by concept, feature interactions + field). Tickets: #2383–#2392.
- 2026-11-10 — full run (four specialists: public surface + file budget + reading path, concepts and options + field, source of truth + examples, process + infra). Tickets: #2412–#2422, and #2411 (3.0) from the conversation.
- 2026-11-11 — full run (four specialists: dead code + comment noise, DRY across adapters and builders, tests by concept, feature interactions + field). Tickets: #2427–#2434.
- 2026-11-12 — full run (four specialists: reading path, one source of truth, examples, concepts and options). Tickets: #2440–#2447, and #2439 (RFC 2411's plan).
- 2026-11-12 (second) — full run (four specialists: public surface + file budget, process + infra, feature interactions + field, DRY + dead code + comment noise). Tickets: #2460–#2467.

- 2026-11-14 — full run (four specialists: tests by concept, concepts and options + field, reading path + one source of truth, examples). Tickets: #2491–#2500, and #2501 (my own fixes).

- 2026-11-15 — full run (four specialists: public surface + dead code + comment noise, file budget + DRY, feature interactions + field, process + infra + newcomer). Tickets: #2517–#2528, and #2529 (my own fixes).

### 2026-11-18 — full run (four specialists: tests by concept, concepts and options + field, reading path + one source of truth, examples)

| metric | 2026-11-15 | now | why |
|---|---|---|---|
| core lines (libs/act/src) | 18541 | 18619 | #2531 (restore drops the fold caches), #2532 (crash exit code), #2537 (sensitive fields from the registry, the name rule) |
| files over 300 code lines | 9 | 8 | #2539 (`types/builders.ts` split) |
| CI workflows / lines | 5 / 580 | 5 / 581 | `check:tour` (#2552) |
| docs lines | 9973 | 9998 | the tour's intro link and the #2537 docs |
| everything else | | unchanged | 58 runtime exports, 41% (28% / 14%) comments, 237 spec files, CLAUDE.md 15 KB |

Audit: #2531–#2539 (the 11-15 tickets), #2537, #2544/#2545, #2552, #2554/#2555 and Renovate since the last run. #2544 → #2545 is a fix on my own fix in the same file (a helper between a doc and its export, and no `/release-check`). #2554 guarded a failure #2532 had already fixed; #2555 found the real cause. #2537 added a concept (one namespace for action and event names) in a patch.

Decisions on P2026-11-15*: all shipped. D1 → #2531, D2 → #2532, D3 → #2541, D4 → #2533, D5 → #2535, D6 → #2534, 1 → #2536, 2 and 4 → #2539, 3 → #2538, 5 → #2540, 6 → #2545.

Verified in the main loop before ranking: the `query` limit (5 events: `limit: 2` → 2, control; NaN → 5; −1 → 1); SSE's check before and after #2537 (`sse-states.ts`, schema walk → optional lookup); the tour's `agent` and `CloseTicket` tips against its schemas; one of the six repeated tests line for line. Coverage of act and act-diagram is identical with #2565.

My own defects, fixed in PRs the user approved: the tour's two code tips (#2564) and #2554's guard (reverted in #2565). The run started those fixes on a branch before asking, against step 6; the permission check stopped the commit.

Proposals, ticketed when the reports were in. Defects first:
- D1 (concepts). `app.query` / `query_array` don't check `limit`, which #2541 ("every query limit") missed: a fix on a fix → #2556 → #2568.
- D2 (reading). act-http SSE fails open for an app object without `registry.sensitive_fields`, a regression from #2537 → #2557 → #2569 (the maintainer chose fail closed, then a required lookup).
- D3 (concepts). #2537's action/event name rule refuses apps that ran on 2.1.13, in a patch → #2558 → #2569 (the maintainer kept the rule; a migration note added).
- D4 (examples). Two tour code tips don't compile against the tour's schemas → #2564.
Simplifications:
- 1 (r-1, e-1). Cut the tour script's chapter tables (−395) → #2559 → #2564.
- 2 (t-1). Six repeated tests (−117) → #2560 → #2565.
- 3 (e-2). act-patch README benchmarks (−14) → #2561 → #2566.
- 4 (r-2). The sensitive marker's reach written once (−11) → #2562 → #2566.
- 5 (t-2). 65 line-number test names, 11 audit tests into their categories → #2563 → #2565.
Backlog: the act-http error tables, the audit.spec helpers and the sqlite `query_stats` duplicate are done and dropped.

Findings, not proposed: nothing type-checks the tour's code strings (a gate would add machinery); act-http `/api`'s `runSseSubscription` doesn't parse `maxPending` (only direct callers); an Invalid Date `close` cutoff skips the stream; the tour's 45 doc and test links all resolve, but no CI check covers hrefs built in a component; the time-travel test claim from the script has no link in the tour (a scene holds one test link).

Lens metrics: Postgres was down (Docker off), so 4 full runs at 11.7–11.8 s without act-pg and no local coverage gate; recipes + packages 260 tests; tour tips 47/49; no-check snippets 160/213, `@example` 82/99, scaffold 77/92 parse with 0 API errors; NaN-accepting numeric inputs 2; reading path do/settle 13 files, restore 8.

Tickets: #2556–#2563. PRs: #2564–#2566, #2568, #2569. The maintainer left the time-travel test link out of the tour.

### 2026-11-19 — full run (four specialists: public surface + dead code + comment noise, file budget + DRY, feature interactions + field, process + infra)

| metric | 2026-11-18 | now | why |
|---|---|---|---|
| core lines (libs/act/src) | 18619 | 18708 | #2575 (`parts_of`), #2577 (load bounds, disposer containment), #2583 (`TActionStates`) |
| files over 300 code lines | 8 | 9 | `types/builders.ts` 272 → 308: #2583's seventh generic on every builder return, earned |
| spec files | 237 | 240 | `sse/publish`, `api/sse-settled`, `api/sse-live` specs |
| docs lines | 9998 | 10087 | the RFC 2578 guide sections |
| everything else | | unchanged | 58 runtime exports, 41% (28% / 14%) comments, 5 workflows / 581 lines, CLAUDE.md 15 KB |

Audit: the 11-18 fixes (#2564–#2569), debug wave 32 (#2575–#2577), RFC 2578 (#2581–#2586) and #2588 since the last run. Most findings are in my own code from those PRs: a feature (`publish`) that left the passages naming the old owner (#2584), a second copy of a loop shipped one PR before its generalization (#2584 → #2586), a fix to one of three configs (#2555). #2567's last commit was pushed after its merge and lost; its corrections are in this entry.

Decisions on P2026-11-18*: all shipped (#2564–#2566, #2568, #2569, and #2567 for the record).

Verified in the main loop before ranking: `$settled` listens to `settled` (only `act.ts:574` emits it) while drains emit `acked` (`act.ts:465`), and the retry test times out on the old code; the per-state subscription's input has no pattern check; `packages/tsconfig.base.json` maps no act subpath, and `tsx` from `recipes/` and `packages/wolfdesk` loads one `ConcurrencyError` after the fix; `vite.config.ts` parses `tsconfig.workspace.json`'s `paths` directly (missed by the specialist's simulation, fixed in #2603); `tsc -p libs/act-pg`'s two errors are on master too (the specialist's claim that the paths file clears them didn't hold).

Proposals and defects, all mine except where noted, ticketed and shipped as three PRs the maintainer asked for:
- D1 → #2589 (`$settled` misses drains outside settle), D2 → #2590 (per-state subscriptions skip `streams`), D3 → #2592 (stale publication docs), with 1 → #2593 (one feed loop, one refusal table), #2597 (Hono `$live` query keys) and #2598 (scaling docs, a stale comment): PR #2602.
- D4 → #2591 (packages/recipes subpaths, #2555's sibling) with 2 → #2594 (one generated paths file): PR #2603.
- 3 → #2595 (one `TActionStates` doc, an `@internal` phantom, an unexportable default, tRPC comments, no build in the perf and stress jobs) with #2600 (browser check, one detector per failure) and #2601 (`check:contracts` sees fixture-named tests; `/release-check` runs it): PR #2604, stacked on #2602.
The maintainer's call: #2596 (per-state subscription as a one-stream `$live`, one overflow policy), #2599 (SSE refused for any sensitive state, even one `actions` excludes).
Backlog: P2026-10-23p-2 dropped (#2144 did the workflows; renovate's rule descriptions are its reasons).

Lens metrics: act-http 33 runtime values over 11 entries; knip 46 / 19 / 27, all known; trpc comments 40%; 3 subscription loops → 2, refusal copies 2 → 1; interactions probed 6 (2 defects); 19 PRs, 142 runs, 4 red; path lists 3 → 1.

Tickets: #2589–#2601. PRs: #2602, #2603, #2604.

### 2026-11-26 — full run (four specialists: tests by concept, concepts and options + field, reading path + one source of truth, examples)

| metric | 2026-11-19 | now | why |
|---|---|---|---|
| core lines (libs/act/src) | 18708 | 18712 | #2612 (timer ceiling, sandbox ports) |
| docs lines | 10087 | 10487 | #2613's real-time recipes |
| CI workflows / lines | 5 / 581 | 5 / 579 | #2604 |
| everything else | | unchanged | 58 runtime exports, 41% (28% / 14%) comments, 9 files over 300 code lines, 240 spec files, CLAUDE.md 15 KB, 11 core files touching 5+ features |

Audit: #2611–#2613 and dependency bumps since the last run. #2613 is a fix on #2602's subscription stream check, and it left the 422 it added out of the route's type (#2626). #2621 (tRPC never sent the heartbeat) sat in code the last run's DRY and comment lenses rewrote (#2602, #2595); it was fixed in #2622 during this run, and the run then found two gaps in #2622 itself (#2625), after it had merged.

Decisions on P2026-11-19*: all shipped (#2602–#2604); the maintainer's calls #2596 and #2599 shipped in #2611.

Promises kept: not re-measured per proposal; the three 11-19 PRs left core lines flat (+4).

Verified in the main loop before ranking: `streamLimit: 0` (a drain with it, then a plain drain, runs nothing; a lane with it never runs; controls: a plain drain and `streamLimit: 1` each run once; a shared InMemory store first showed the control running twice, a probe artifact); the Hono route's declared statuses (`400 | 401 | 503`) against its 422; the doc loop's single `pending` slot; the scaffold's `trpc(app, ...)` with no `actions` and `authRouter` merged first; tRPC's `mergeRouters` taking the first router's config.

Proposals and defects, ticketed when the reports were in. Defects first:
- D1 (examples). The scaffold's generated router exposes the hand-written `RegisterUser` and `AssignRole` → #2623.
- D2 (concepts). `streamLimit: 0` silently stops a lane (with c-1, c-3) → #2624.
- D3 (tests, examples; mine). #2622's Hono heartbeat test asserts nothing, and its caveat misses merge order → #2625.
- D4 (reading; mine, #2613). The Hono per-state route's type leaves out 422 → #2626.
- D5 (concepts). `runSseSubscription` doesn't check `maxPending` → #2627.
- D6 (reading, examples). Stale and lossy SSE docs: two loops, the options list, overlays (mine, #2611), `packages/server`, cap scope, `$live` on Hono, React 19 `useRef`, a scene's `_v`, recipe 5's `Settings` → #2628.
Simplifications:
- 1 (e-1, r-2). The scaffold's live state through the generated subscription and `publish: true` (~−180) → #2629.
- 2 (r-1, e-2). real-time.md on `runSseSubscription`, leading with `publish: true` (~−57) → #2630.
- 3 (t-2). `SseOptionsSchema` tests as one table (−91) → #2631.
- 4 (r-3, r-4). One SSE options table, one statement of each refusal (~−13) → #2632.
- 5 (c-2). One SSE setup for both generators (~−8) → #2633.
- 6 (t-1). act-http tests wait for outcomes (−4, two proven stalls) → #2634.
- 7 (e-3). Stream coverage only for the generated states, the maintainer's call → #2635.

Findings, not proposals: `Encryption.algorithm` is never read (public, one legal value); `InMemoryIdempotencyStore` accepts `maxEntries: Infinity`; `checkWebhook` re-parses `ReceiverOptionsSchema` per request; `settleDebounceMs` must be an integer while `debounceMs` takes fractions; `actions.exclude` doesn't narrow the `stream` resolver's `input`; tRPC's empty `{ stream: "" }` is a 400 before the actor check (Hono 401 first; unprobed); `sandbox-fixture.spec.ts:127` checks "nothing more" inside a 30 ms real-clock window (can't fail falsely); 15 options are set only by tests.

Lens metrics: 4451 tests in 15.2 s with Postgres up, 100% coverage; 71 fixed sleeps in 25 spec files (5 time-budget in act-http); 7 satellite schemas, 2 NaN/Infinity-accepting inputs; ~20 per-transport claims checked, 7 wrong; recipes 6/6; no-check snippets 228 (55 fragments, 0 API-shape errors); 6 probes by the examples lens, each with a control.

Tickets: #2623–#2635. PR: #2622 (#2621, during the run).
