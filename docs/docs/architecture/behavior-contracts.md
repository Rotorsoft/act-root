---
id: behavior-contracts
title: Behavior-contract checklist
---

# Behavior-contract checklist

A documented runtime guarantee is a lie until a test fails when it stops
holding. The `with_snaps` regression (#1024) shipped a doc/intent that had
quietly diverged from the code because nothing executable pinned the claim.
This page is the antidote: every load-bearing behavioral claim Act makes in
its docs and port doc-comments, mapped to the test that enforces it.

The rule that follows from it lives in the pre-handoff workflow: **a doc claim
about runtime behavior ships with its test.** When you add or change a claim
here, add or update the row.

Scope is deliberately narrow — load-bearing guarantees a caller or adapter
author would rely on, not every sentence in the docs. Adapter-level claims are
backed in the TCK (`libs/act-tck/src/store-tck.ts`) so they run against
InMemory, Postgres, and SQLite at once; orchestrator and builder claims are
backed by unit/integration specs under `libs/act/test/`.

## Cache and snapshots

| Claim | Source | Backing test |
|---|---|---|
| `seed()` is the schema maintenance story: additive, idempotent, lossless on any prior released shape, and safe to run on every boot from every worker (advisory-locked on Postgres for concurrent cold boots) | `writing-a-store.md` § The store schema is the framework's job; `extension-points.md` | act-pg + act-sqlite `seed-upgrade.spec.ts` → "upgrades the oldest supported shape losslessly and idempotently", "serializes concurrent cold boots on an empty schema" **(#1140)** |
| On Postgres, `streams.retry` is `int` (widened from `smallint` via the seed ladder), so a persistently-failing `blockOnError: false` stream whose retry counter climbs unbounded never overflows `claim()`'s `retry + 1` update — matching the unbounded SQLite/InMemory adapters | `writing-a-store.md` § The store schema is the framework's job | act-pg `retry-overflow.spec.ts` → "claims a stream whose retry sits at the old smallint ceiling"; `seed-upgrade.spec.ts` → "upgrades the oldest supported shape…" (asserts `retry` migrated to `integer`) **(#1190)** |
| `with_snaps: true` resumes from the latest snapshot per stream; an explicit `after` overrides the floor; a stream with no snapshot returns full history | `cache-and-snapshots.md`, `Store.query` doc | `store-tck.ts` → "with_snaps resumes from the latest snapshot per stream" |
| Cold start absorbs the snapshot event into state and resets `patches` to 0 (`snaps` increments) | `cache-and-snapshots.md` "How the two interact on cold start" | `event-sourcing.spec.ts` → "should load from a snapshot event on cold start" |
| Snapshot writes are fire-and-forget; a snap failure does not propagate | `cache-and-snapshots.md` "Snapshot creation" | `event-sourcing.spec.ts` → "should not throw on snap error and warn with stream, reason, and hint" |
| A snapshot write failure never fails the action and is surfaced at warn level with the stream, reason, and full-replay hint | `cache-and-snapshots.md` "Snapshot creation" | `event-sourcing.spec.ts` → "should complete the action and warn when the snapshot write fails" |
| A successful snap predicate commits a `__snapshot__` event | `cache-and-snapshots.md` | `event-sourcing.spec.ts` → "should persist snapshot event on snap success" |
| Cache miss populates the cache; a warm hit replays nothing older | `cache-and-snapshots.md` "Read path" | `cache.spec.ts` → "cache miss populates cache on load" |
| The cache is invalidated **only** on `ConcurrencyError` | `cache-and-snapshots.md` "Cache invalidation — narrow contract" | `cache.spec.ts` → "cache invalidated on ConcurrencyError" |
| Invariant / validation failures (no commit) leave the warm cache **untouched** | `cache-and-snapshots.md` "Anything else … leaves the cache untouched" | `cache.spec.ts` → "invariant failure leaves the warm cache untouched", "validation failure leaves the warm cache untouched" **(gap filled — #1029)** |
| A `cache.set` rejection is logged, not fatal to the action | `cache-and-snapshots.md` | `cache.spec.ts` → "cache.set rejection is logged but does not fail the action" |
| Time-travel (`asOf`) bypasses cache read and write, and ignores snapshots after the cutoff | `cache-and-snapshots.md` "Time-travel reads" | `time-travel.spec.ts` → "should not read from cache…", "should not write to cache…", "should not use snapshots…" |

## Reactions, drain, and errors

| Claim | Source | Backing test |
|---|---|---|
| On Postgres, event ids become visible in id order — the append path (`commit`, `truncate`) holds a transaction-scoped advisory lock so a concurrent cross-stream commit can never surface below an id a watermark consumer already acked past | `concurrency-model.md` § Commit visibility ordering | act-pg `commit-visibility.spec.ts` → "a commit waits for an in-flight append transaction to finish", "truncate seeds take the same visibility lock" **(#1178)** |
| `reactingTo` is auto-injected when a reaction handler omits it; an explicit value is respected | CLAUDE.md safety one-liner; `state-management.md` | `reacting-to.spec.ts` → "should auto-inject reactingTo when handler omits it", "should respect explicit reactingTo when provided" |
| `NonRetryableError` forces a block on the first attempt when `blockOnError` is true (default) | `error-handling.md` "Non-retryable errors" | `non-retryable.spec.ts` → "blocks on first attempt when blockOnError is true (default)" |
| `NonRetryableError` does **not** override `blockOnError: false` | `error-handling.md`; CLAUDE.md safety one-liner | `non-retryable.spec.ts` → "ignores NonRetryableError when blockOnError is false" |
| Per-reaction backoff defers retry until the window elapses (per-worker) | `error-handling.md` "Backoff" | `backoff.spec.ts` → "defers retry until backoff window elapses (per-worker)" |
| Backoff entry clears on a successful ack | `error-handling.md` | `backoff.spec.ts` → "clears backoff entry on successful ack" |
| Backoff still blocks when retries are exhausted | `error-handling.md` | `backoff.spec.ts` → "preserves blocking behavior when retries are exhausted" |
| `compute_backoff_delay` strategy/clamp/jitter semantics | `error-handling.md` | `backoff.spec.ts` → `compute_backoff_delay` unit block |
| Backoff's effective floor is `max(configured, leaseMillis)` — when the lease outlasts the backoff window, the held lease (not the timer) gates the next attempt | `error-handling.md` "Backoff"; CLAUDE.md "Reaction backoff is per-worker" | `backoff.spec.ts` → "effective floor is max(configured, leaseMillis) — the held lease dominates a short backoff" **(gap filled — #1065)** |
| `app.unblock` resumes a blocked stream from its watermark **without replaying history**; `app.reset` rewinds to -1 and replays everything (the resume-vs-rebuild distinction) | CLAUDE.md "Blocked-stream recovery"; `error-handling.md` | `non-retryable.spec.ts` → "recovers via app.unblock without replaying history"; `rebuild.spec.ts` → "should enable replay of projection after reset" **(gap filled — #1065)** |
| `correlate()` arms the lane controllers when it subscribes new streams — the same contract `reset`/`unblock` honor — so a freshly-discovered dynamic target cannot starve on a lane whose worker disarmed before the subscription landed | `correlation-and-drain.md` | `correlate-arm.spec.ts` → "revives a lane that disarmed before the subscription landed" |
| A state projection's flush precedes its watermark ack — a failed flush holds the watermark and the retry re-folds to the same rows (idempotent at-least-once) | `projections-to-database.md` | `state-projection.spec.ts` → "holds the watermark when flush fails and converges on retry" |
| A state projection evicting under `maxCachedStates` pressure flushes the evictee first — eviction never loses folded work | `projections-to-database.md` | `state-projection.spec.ts` → "flushes the evictee before dropping it under maxCachedStates pressure" |
| A state projection rebuild writes one row per stream per flush round, not one per event | `event-sourcing.md` § Projection Rebuild | `state-projection.spec.ts` → "rebuilds in O(streams) upserts, not O(events)" |
| A state projection'''s first-sight load resumes from the latest snapshot floor and folds only the tail | `projections-to-database.md` § State projections | `state-projection.spec.ts` → "resumes the first-sight load from the latest snapshot" |
| A cache entry's `state` equals the fold of events at or below its `event_id` — a guardless commit that lands past the loaded frontier invalidates instead of caching a gapped fold | `cache-and-snapshots.md` | `cache-frontier.spec.ts` → "never leaves a stale-at-head cache entry after guardless commits" |
| The optimistic guard holds on warm cache hits — a concurrent plain action surfaces `ConcurrencyError`, never a silent append past unfolded events | `concurrency-model.md` | `cache-frontier.spec.ts` → "keeps the optimistic guard on warm cache hits" |
| A cold load during the close guard window (tombstone committed, truncate pending) does **not** cache — leaving the entry cold keeps `action()`'s cold-path tombstone check live, so a subsequent action throws `StreamClosedError` instead of committing past the tombstone | `concurrency-model.md`; `close-cycle.md` | `event-sourcing.spec.ts` → "a cold load during the guard window keeps the tombstone check live" **(#1188)** |
| A snapshot event is only persisted from a contiguous fold, and the action awaits it and caches the snap frontier before returning — sequential callers never see a conflict caused by the framework's own bookkeeping | `cache-and-snapshots.md` | `optimizations.spec.ts` cadence + `calculator.spec.ts` lifecycle (fail on regression) |
| Lanes drain in **parallel** — `_drain_all` runs every controller's `drain()` via `Promise.all`, so a stalled slow-lane handler does not block the fast lane | CLAUDE.md "Lanes give intra-process responsiveness"; `configuration.md` § Lanes | `lanes.spec.ts` → "drains lanes in parallel — a stalled slow handler does not block the fast lane" **(gap filled — #1065)** |
| A `defer` outcome holds the triggering event pending — the drain does **not** advance the watermark and does **not** bump `retry` — then re-delivers once the persisted due-time passes | `close-cycle.md` § Defer, not poll; `extension-points.md` § `defer` | `defer-outcome.spec.ts` → "holds pending until the due-time, then redelivers and acks" **(#1090)** |
| The registry is complete and **frozen** at `act().build()`: autoclose reactions are synthesized by the builder (not the orchestrator), and post-build mutation of the registry containers throws | `close-cycle.md` § Online close-the-books | `registry-freeze.spec.ts` → "freezes the registry containers at build", "synthesizes the autoclose reaction at build, not construction" **(#1121)** |
| `.autocloses` closes a stream when its policy matches the live head, re-evaluates the live head so a reopened stream is **not** closed, parks on the cooldown while `after` has not elapsed, closes on a `reaches` threshold, and defers (not closes) outside the `autocloseWindow` | `close-policies.md`; `close-cycle.md` § Online close-the-books | `autoclose-reaction.spec.ts` → "closes immediately on the terminal event for an `is` policy", "evaluates the live head — a reopened stream is not closed", "parks on the cooldown instead of closing while `after` has not elapsed", "closes on the threshold event for a `reaches` policy", "respects the off-hours window — outside it, defers instead of closing" **(#1090)** |
| The declarative `.defer(when)` builder step holds the reaction until its schedule is due, then runs the handler once (available on both `act()` and `slice()`) | `state-management.md` § Deferred reactions | `declarative-defer.spec.ts` → "literal `{ after }` holds the reaction (handler not run, not acked)", "runs immediately once the schedule is already due", "is available on the slice() builder too" **(#1091)** |
| The `.defer` function form reads the triggering event's payload to choose the schedule | `state-management.md` § Deferred reactions | `declarative-defer.spec.ts` → "function form reads the payload to choose the schedule, then runs" **(#1091)** |
| Drain finalization is atomic: defer schedules ride the same `Store.ack` call as the acks (due-marked leases), so a failed finalize lands nothing — close requests are never lost, no watermark moves without its cycle's schedules | `close-cycle.md` § Defer, not poll; `extension-points.md` § Store; `recipes/temporal/recurring-timers` § Failure modes | `defer-durability.spec.ts` → "a failed finalize lands nothing — close requests are never lost", "persists the defer schedule in the same store call as the acks"; TCK `store-tck.ts` → describe("ack finalize (due-marked leases)") **(#1124)** |
| A failed finalize never stalls a deferred stream: the controller stays armed and the next drain redelivers, so the handler re-throws its `DeferSignal` and the retried finalize persists the schedule | `close-cycle.md` § Defer, not poll | `defer-durability.spec.ts` → "keeps the drain armed while finalization is unhealed" **(#1124)** |
| A malformed literal `.defer(...)` schedule (neither/both of `after`/`at`, or an empty duration) is rejected at build time with a `ZodError` | `state-management.md` § Deferred reactions | `declarative-defer.spec.ts` → "rejects a bad literal schedule at build time" **(#1091)** |
| Imperative `throw new DeferSignal(when)` resolves the schedule against the triggering event and holds the stream until the due-time, then re-delivers and acks | `state-management.md` § The `DeferSignal` escape hatch | `public-defer.spec.ts` → "`{ at: Date }` holds until the due-time, then acts", "`{ after }` is measured from the event's created time (parks, not acked)" **(#1091)** |

## Store contract (runs on all three adapters via the TCK)

| Claim | Source | Backing test |
|---|---|---|
| `subscribe` is idempotent on repeat | `Store.subscribe` doc | `store-tck.ts` → "subscribes new streams and is idempotent on repeat" |
| `subscribe` keeps the **maximum** priority when a stream is re-subscribed with a different priority | `Store.subscribe` `priority` doc-comment | `store-tck.ts` → "keeps the maximum priority when a stream is re-subscribed" **(gap filled — #1029)** |
| `prioritize` sets priority **directly**, overriding `subscribe`'s max() rule | `Store.prioritize` doc | `store-tck.ts` → "sets priority directly, overriding subscribe's max() rule" |
| `unblock` returns 0 when the stream is not blocked; `reset`/`unblock` return 0 for unknown/empty input | `Store.unblock` / `Store.reset` docs | `store-tck.ts` → "returns 0 when the stream is not blocked", "returns 0 for unknown streams and empty input" |
| `unblock` clears the blocked flag and **preserves** the watermark; `reset` rewinds it to -1 (resume-vs-rebuild at the port level) | `Store.unblock` / `Store.reset` docs | `store-tck.ts` → "clears blocked flag and preserves the watermark", "rewinds a stream watermark to -1", "clears blocked status when resetting" **(gap filled — #1065)** |
| `truncate` (full target) deletes events, removes the stream entry, and seeds a snapshot or tombstone | `Store.truncate` doc | `store-tck.ts` → `truncate` describe block |
| A windowed `truncate` target (`before`) deletes only the prefix below the closest safe snapshot (latest `__snapshot__` with `created < before`), keeps the snapshot + tail, seeds nothing, and leaves subscriptions untouched — the stream stays writable and readable | `Store.truncate` doc; `extension-points.md` § Store contract; `writing-a-store.md` § Truncating streams | `store-tck.ts` → describe("windowed (before boundary)"): "deletes the prefix below the closest safe snapshot and keeps the snapshot + tail", "leaves subscriptions untouched, unlike a full truncate", "keeps the stream writable and readable after a prune", "mixes full and windowed targets in one call" **(#1011)** |
| The `max_id` cap on a windowed target is honored — the boundary never rises past a lagging consumer's watermark, so a lagging reaction degrades the prune, never loses data | `Store.truncate` doc; `close-cycle.md` § Windowed close | `store-tck.ts` → "honors the max_id cap — boundary never rises past a lagging consumer"; `close-windowed.spec.ts` → "caps the boundary at a lagging consumer's watermark" **(#1011)** |
| A windowed target with no qualifying snapshot is a no-op: events untouched, stream absent from the truncate result, reported in `CloseResult.skipped` by the orchestrator | `Store.truncate` doc; `close-cycle.md` § Skipped semantics | `store-tck.ts` → "no-ops when no snapshot qualifies — stream absent from the result, events untouched"; `close-windowed.spec.ts` → "skips streams with no qualifying snapshot" **(#1011)** |
| `forget_pii` wipes PII for every event and is idempotent (second call returns 0; no-PII stream returns 0) | `Store.forget_pii` doc | `store-tck.ts` → "wipes pii for every event on the stream via forget_pii", "is idempotent — second forget_pii returns 0, no error", "forget_pii on a stream with no pii events returns 0" |
| `query_streams` reports `maxEventId` tracking the highest committed id | `Store.query_streams` doc | `store-tck.ts` → "maxEventId tracks the highest committed id" |
| `claim` **skips** a stream until its `deferred_at` passes, then makes it claimable again; a defer never bumps `retry`; `reset` clears a pending defer; a filter-form `defer` counts the streams it matched | `Store.defer` doc; `extension-points.md` § `defer` | `store-tck.ts` → `defer` describe block: "hides a stream from claim until its deferred_at passes", "makes a stream claimable once the deferred_at is in the past", "does not bump retry while a stream is deferred", "reset clears a pending defer", "defers streams matching a filter and counts matches" **(#1090)** |
| Stream filters guarantee a portable grammar — `^` / `$` anchors, `.`, `.*`, literal characters (including literal `_` / `%`) — matching identically on every adapter; a richer pattern either matches with full regex semantics or throws `ValidationError`, never a silent approximation | `QueryStreams.stream` / `StreamFilter` / `Query.stream` docs; `extension-points.md` § Stream filters | `store-tck.ts` → "stream filter grammar" describe block: "portable subset: anchors, `.`, and `.*` match identically", "literal `_` and `%` in patterns are not wildcards", "portable subset applies to stream-position filters", "non-portable patterns match with full regex semantics or throw", "bulk stream ops reject non-portable filters instead of mis-matching" **(#1114)** |
| `claim` matches a **literal** subscription `source` (no regex metacharacter) by string equality — a source `s1` never matches a sibling stream `s12`, and it receives exactly its stream's events (drain fetch uses `stream_exact` for literals) | `Store.claim` / `Store.subscribe` docs; `Resolved.source` doc | `store-tck.ts` → describe("claim source matching"): "treats source as an exact stream name — no substring or pattern overmatch", "receives exactly its source stream's events", "fetches only the exact source stream's events, never a sibling prefix" **(#1182 exact fix; #1220 fetch consistency — the overmatch case failed red on InMemory's unanchored-RegExp and SQLite's contains-LIKE probes before #1182's fix)** |
| `claim` matches a **pattern** `source` (one carrying regex metacharacters, e.g. `^(A|B)$`) as a compiled regex against candidate streams, so a static regex-source reaction (the shipped calculator Board projection) is claimed for every stream it anchors; adapters that cannot run an arbitrary regex reject a non-portable claim source at `subscribe` time | `Store.claim` / `Store.subscribe` docs; `Resolved.source` doc | `store-tck.ts` → describe("claim pattern source matching") (InMemory/PG): "claims a pattern-source target when any matched stream has work (^(A\|B)$)", "does not claim … when no matched stream has work"; describe("claim source registration") (SQLite): "throws at subscribe for a non-portable (alternation) claim source", "accepts a portable-subset pattern claim source"; `packages/calculator/test/board-projection.spec.ts` end-to-end **(#1220 — restores documented regex-source behavior an exact-only decision in #1215/#1182 broke; the calculator Board projection failed red before the fix)** |
| A lease timeout counts against the retry budget — reclaiming an expired lease increments `retry` no matter which worker reclaims it, and only `ack` resets the counter | `concurrency-model.md` § Timeout; `Store.claim` doc | `store-tck.ts` → "counts a timed-out lease reclaimed by another worker against the retry budget; ack resets it" **(#1183 — the doc previously claimed the opposite; the code was right)** |
| An unexpired lease is invisible to competing claimers; an expired lease is handed to exactly one of them, with the shared retry counter intact | `concurrency-model.md` § Timeout / lease lifecycle | `store-tck.ts` → concurrency (capability): "does not hand an unexpired lease to a competing claimer", "hands an expired lease to exactly one competing claimer, with retry accounting shared across workers" **(#1184)** |
| `notify` is self-filtering — an instance never receives its own commits, only a sibling instance's writing to the same backing store | `Store.notify` doc ("implementations must skip their own commits") | `store-tck.ts` → notify (capability): "does not deliver an instance's own commits (self-filtering)" **(#1184 — promoted from adapter-local suites to the TCK so third-party stores can't badge conformance while echoing their own commits)** |
| `notify` delivers **one notification per commit transaction**, carrying the full ordered event batch | `Store.notify` doc; `cross-process-reactions.md` | `store-tck.ts` → notify (capability): "delivers one notification per commit transaction carrying the full event batch" **(#1184)** |

## PostgresStore notify (adapter-specific — outside the TCK)

The portable notify contract (cross-instance delivery, self-filtering,
batch-per-commit) lives in the TCK's `notify` capability suite as of #1184.
What stays here is PostgreSQL plumbing the TCK can't express portably —
the LISTEN reconnect discipline and the 8000-byte NOTIFY payload cap —
pinned in `libs/act-pg/test/`.

| Claim | Source | Backing test |
|---|---|---|
| `notify` is self-filtered per instance — a commit wakes other instances' listeners, never its own (the LISTEN handler skips payloads where `by === this._by`) | `cross-process-reactions.md` § Self-filter | `notify.contract.spec.ts` (act-pg) → "notify is self-filtered per instance — a commit wakes the other instance, never its own" **(#1120)** |
| An oversize NOTIFY payload (≥ 8000 bytes) skips the NOTIFY instead of aborting the commit — the commit succeeds and delivery falls back to the poll path, preserving at-least-once | `cross-process-reactions.md` § Payload cap | `notify.contract.spec.ts` (act-pg) → "oversize notify payload skips the NOTIFY — the commit succeeds and events stay discoverable via the poll path" **(gap exposed a real bug, fixed — #1120)** |
| The dedicated LISTEN client carries an `error` listener, so a connection loss cannot crash the process; on error it tears the dead client down and re-`LISTEN`s on a fresh one with capped exponential backoff, degrading to the poll path in between | `cross-process-reactions.md` § Connection loss — the LISTEN client self-heals | `notify.resilience.spec.ts` (act-pg) → "attaches an error listener…", "self-heals: on client error it tears down the dead client and re-LISTENs on a fresh one", "grows the backoff on repeated failures and resets it after a healthy reconnect" **(#1189)** |
| A pending reconnect is cancelled by disposal (or a re-subscribe) — no reconnect fires after teardown | `cross-process-reactions.md` § Connection loss — the LISTEN client self-heals | `notify.resilience.spec.ts` (act-pg) → "dispose during a pending reconnect cancels it — no client is checked out after teardown" **(#1189)** |

## Orchestrator and builders

| Claim | Source | Backing test |
|---|---|---|
| `app.reset()` arms the orchestrator's drain flag, so a settled app still replays (`store().reset()` alone does not) | CLAUDE.md safety one-liner; `event-sourcing.md` | `rebuild.spec.ts` → "should replay events when drain runs after reset on a settled app" |
| `reset` resets watermarks to -1 and unblocks blocked streams | `Store.reset` doc | `rebuild.spec.ts` → "should reset subscribed stream watermarks to -1", "should unblock blocked streams after reset" |
| A static `.emit()` of a deprecated event version throws at build | `event-schema-evolution.md`; CLAUDE.md safety one-liner | `deprecation.spec.ts` → "throws when an action statically emits a deprecated event" |
| Single-key records (`.on`, `state(...)`) throw on zero or multiple keys | CLAUDE.md safety one-liner; `state-management.md` | `state-builder.spec.ts` → "should throw when .on() receives multiple keys", "should throw when record has more than one key", "should throw when record has zero keys" |
| Same-name state partials sharing an event must reference the same Zod schema instance; mismatched references throw | CLAUDE.md safety one-liner; `state-management.md` | `slice.spec.ts` → "throws when same-name state partials use different schema references for the same event" |
| Scoped Acts keep per-Act store and cache isolated (no cross-talk) | CLAUDE.md safety one-liner; `extension-points.md` | `scope.spec.ts` → "two Acts with their own scoped ports — no cross-talk", "scoped cache keeps per-Act snapshots isolated" |
| A scoped Act's background paths — settle-driven correlate init, the `start_correlations` poll timer, and per-lane worker ticks — resolve `store()`/`cache()` to the **scoped** ports, not the singleton: static targets subscribe and drains run on the scoped store | CLAUDE.md "Per-Act scoped ports"; `extension-points.md` § Scoped ports | `scope.spec.ts` → "settle() subscribes static targets on the scoped store, not the singleton", "start_correlations polls against the scoped store, not the singleton", "lane worker ticks drain against the scoped store, not the singleton" **(#1191)** |
| Cross-process reactions: the orchestrator auto-wires `Store.notify` **at construction** when the store supports it and reactive events exist; it does not wire when the store lacks `notify` or there are no reactive events | CLAUDE.md "Cross-process reactions"; `cross-process-reactions.md` | `notify.spec.ts` → "subscribes when store has notify and reactions exist", "does not subscribe when store lacks notify", "does not subscribe when there are no reactive events" **(gap filled — #1065)** |
| A windowed close leaves the cache untouched and the stream live — no invalidation on prune, and the stream keeps accepting actions | `close-cycle.md` § Windowed close; `IAct.close` doc-comment | `close-windowed.spec.ts` → "prunes the prefix behind the boundary snapshot and keeps the stream live", "leaves the cache untouched — no invalidation on prune" **(#1011)** |
| `.autocloses({ keep })` requires `.snap(...)` earlier in the chain — type-gated on the `ActionBuilder`, with a runtime throw backstopping untyped callers — and rejects windows below one day and `keep` inside `or` | `close-policies.md` § `keep`; `AutoclosePolicy.keep` doc-comment | `autoclose-builder.spec.ts` → `describe(".autocloses({ keep }) — rolling window")`: "requires .snap earlier in the chain — the runtime guard for untyped callers", "gates keep behind .snap at the type level", "rejects windows below one day — close is low-cadence housekeeping", "rejects keep inside the `or` block" **(#1011)** |
| A stream is never acked past an event while any reaction on it is unhandled — a mid-group failure holds the watermark, redelivers the whole group (already-succeeded reactions re-run, at-least-once), and counts as no progress so the retry counter marches toward `blockOnError` | `error-handling.md` § Retry pattern; `concurrency-model.md` at-least-once | `intra-event-ack.spec.ts` → "holds the watermark when a later reaction on the same event fails", "acks the group once every reaction on the event succeeds", "keeps cross-event partial progress — completed events ack, the failing group holds" **(#1179)** |
| A `keep` prune is staged only once the stream's oldest domain event ages out of the window; otherwise the reaction defers to `tail.created + keep`, and a terminate match takes precedence (full close) with terminate and prune staying independent | `close-policies.md` § `keep`; `close-cycle.md` § Online close-the-books | `autoclose-reaction.spec.ts` → describe("autoclose rolling window (keep)"): "defers while the window holds, prunes once the tail ages out", "terminate and prune stay independent — `is` full-closes even with keep declared", "passes the cutoff to the archiver on a windowed close", "skips the prune when no snapshot qualifies, retrying next trigger" **(#1011)** |

## Gaps closed by #1029

Two load-bearing claims had no executable backing before this checklist:

- **Cache narrow-invalidation, negative half.** The docs guarantee that
  invariant / validation failures leave the warm cache untouched (only
  `ConcurrencyError` invalidates). Nothing tested the negative case — a
  regression that invalidated on every throw would have passed CI.
  Closed in `cache.spec.ts`.
- **`subscribe` max-priority merge.** The `Store.subscribe` doc-comment
  mandates that re-subscribing a stream keeps the maximum priority so the
  highest-priority reaction wins. No adapter test enforced it; a
  last-write-wins regression on any adapter would have shipped silently.
  Closed in `store-tck.ts` (runs on InMemory, Postgres, SQLite).

No documented claim was found to be **false** against the code during this
audit; both gaps were missing tests for behavior that already held.

## Audit closed by #1065

#1029 seeded the checklist; #1065 walked the remaining load-bearing
documented runtime guarantees to exhaustion. Most already had backing tests
that were simply not yet recorded here — the blocked-stream resume-vs-rebuild
distinction (`non-retryable.spec.ts`, `store-tck.ts`, `rebuild.spec.ts`) and
the cross-process `notify` auto-wiring contract (`notify.spec.ts`) are now
mapped to their rows. Two guarantees had no executable backing and gained a
focused test:

- **Backoff's effective floor.** The docs guarantee the floor is
  `max(configured, leaseMillis)` because the controller holds the lease for
  the whole window. Every existing backoff test used `leaseMillis: 1`, so the
  lease-dominates case was untested. Closed in `backoff.spec.ts` (a 20ms
  backoff under a 500ms lease retries only after the lease expires).
- **Lane drain parallelism.** `lanes.spec.ts` covered controller wiring,
  arming, and worker lifecycle but never the actual concurrency guarantee:
  that `_drain_all`'s `Promise.all` lets the fast lane complete while a
  slow-lane handler is stalled. Closed with a gated-handler test.

No documented claim was found **false** against the code during this audit;
every remaining gap was a missing test for behavior that already held.
