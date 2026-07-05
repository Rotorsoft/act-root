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
| `reactingTo` is auto-injected when a reaction handler omits it; an explicit value is respected | CLAUDE.md safety one-liner; `state-management.md` | `reacting-to.spec.ts` → "should auto-inject reactingTo when handler omits it", "should respect explicit reactingTo when provided" |
| `NonRetryableError` forces a block on the first attempt when `blockOnError` is true (default) | `error-handling.md` "Non-retryable errors" | `non-retryable.spec.ts` → "blocks on first attempt when blockOnError is true (default)" |
| `NonRetryableError` does **not** override `blockOnError: false` | `error-handling.md`; CLAUDE.md safety one-liner | `non-retryable.spec.ts` → "ignores NonRetryableError when blockOnError is false" |
| Per-reaction backoff defers retry until the window elapses (per-worker) | `error-handling.md` "Backoff" | `backoff.spec.ts` → "defers retry until backoff window elapses (per-worker)" |
| Backoff entry clears on a successful ack | `error-handling.md` | `backoff.spec.ts` → "clears backoff entry on successful ack" |
| Backoff still blocks when retries are exhausted | `error-handling.md` | `backoff.spec.ts` → "preserves blocking behavior when retries are exhausted" |
| `compute_backoff_delay` strategy/clamp/jitter semantics | `error-handling.md` | `backoff.spec.ts` → `compute_backoff_delay` unit block |
| Backoff's effective floor is `max(configured, leaseMillis)` — when the lease outlasts the backoff window, the held lease (not the timer) gates the next attempt | `error-handling.md` "Backoff"; CLAUDE.md "Reaction backoff is per-worker" | `backoff.spec.ts` → "effective floor is max(configured, leaseMillis) — the held lease dominates a short backoff" **(gap filled — #1065)** |
| `app.unblock` resumes a blocked stream from its watermark **without replaying history**; `app.reset` rewinds to -1 and replays everything (the resume-vs-rebuild distinction) | CLAUDE.md "Blocked-stream recovery"; `error-handling.md` | `non-retryable.spec.ts` → "recovers via app.unblock without replaying history"; `rebuild.spec.ts` → "should enable replay of projection after reset" **(gap filled — #1065)** |
| Lanes drain in **parallel** — `_drain_all` runs every controller's `drain()` via `Promise.all`, so a stalled slow-lane handler does not block the fast lane | CLAUDE.md "Lanes give intra-process responsiveness"; `configuration.md` § Lanes | `lanes.spec.ts` → "drains lanes in parallel — a stalled slow handler does not block the fast lane" **(gap filled — #1065)** |
| A `defer` outcome holds the triggering event pending — the drain does **not** advance the watermark and does **not** bump `retry` — then re-delivers once the persisted due-time passes | `close-cycle.md` § Defer, not poll; `extension-points.md` § `defer` | `defer-outcome.spec.ts` → "holds pending until the due-time, then redelivers and acks" **(#1090)** |
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
| `truncate` deletes events, removes the stream entry, and seeds a snapshot or tombstone | `Store.truncate` doc | `store-tck.ts` → `truncate` describe block |
| `forget_pii` wipes PII for every event and is idempotent (second call returns 0; no-PII stream returns 0) | `Store.forget_pii` doc | `store-tck.ts` → "wipes pii for every event on the stream via forget_pii", "is idempotent — second forget_pii returns 0, no error", "forget_pii on a stream with no pii events returns 0" |
| `query_streams` reports `maxEventId` tracking the highest committed id | `Store.query_streams` doc | `store-tck.ts` → "maxEventId tracks the highest committed id" |
| `claim` **skips** a stream until its `deferred_at` passes, then makes it claimable again; a defer never bumps `retry`; `reset` clears a pending defer; a filter-form `defer` counts the streams it matched | `Store.defer` doc; `extension-points.md` § `defer` | `store-tck.ts` → `defer` describe block: "hides a stream from claim until its deferred_at passes", "makes a stream claimable once the deferred_at is in the past", "does not bump retry while a stream is deferred", "reset clears a pending defer", "defers streams matching a filter and counts matches" **(#1090)** |
| Stream filters guarantee a portable grammar — `^` / `$` anchors, `.`, `.*`, literal characters (including literal `_` / `%`) — matching identically on every adapter; a richer pattern either matches with full regex semantics or throws `ValidationError`, never a silent approximation | `QueryStreams.stream` / `StreamFilter` / `Query.stream` docs; `extension-points.md` § Stream filters | `store-tck.ts` → "stream filter grammar" describe block: "portable subset: anchors, `.`, and `.*` match identically", "literal `_` and `%` in patterns are not wildcards", "portable subset applies to stream-position filters", "non-portable patterns match with full regex semantics or throw", "bulk stream ops reject non-portable filters instead of mis-matching" **(#1114)** |

## PostgresStore notify (adapter-specific — outside the TCK)

Cross-process NOTIFY semantics need two store instances against the same
physical store (the TCK notes them as "needs two processes"), so they are
pinned in `libs/act-pg/test/` rather than the shared TCK.

| Claim | Source | Backing test |
|---|---|---|
| `notify` is self-filtered per instance — a commit wakes other instances' listeners, never its own (the LISTEN handler skips payloads where `by === this._by`) | `cross-process-reactions.md` § Self-filter | `notify.contract.spec.ts` (act-pg) → "notify is self-filtered per instance — a commit wakes the other instance, never its own" **(#1120)** |
| An oversize NOTIFY payload (≥ 8000 bytes) skips the NOTIFY instead of aborting the commit — the commit succeeds and delivery falls back to the poll path, preserving at-least-once | `cross-process-reactions.md` § Payload cap | `notify.contract.spec.ts` (act-pg) → "oversize notify payload skips the NOTIFY — the commit succeeds and events stay discoverable via the poll path" **(gap exposed a real bug, fixed — #1120)** |

## Orchestrator and builders

| Claim | Source | Backing test |
|---|---|---|
| `app.reset()` arms the orchestrator's drain flag, so a settled app still replays (`store().reset()` alone does not) | CLAUDE.md safety one-liner; `event-sourcing.md` | `rebuild.spec.ts` → "should replay events when drain runs after reset on a settled app" |
| `reset` resets watermarks to -1 and unblocks blocked streams | `Store.reset` doc | `rebuild.spec.ts` → "should reset subscribed stream watermarks to -1", "should unblock blocked streams after reset" |
| A static `.emit()` of a deprecated event version throws at build | `event-schema-evolution.md`; CLAUDE.md safety one-liner | `deprecation.spec.ts` → "throws when an action statically emits a deprecated event" |
| Single-key records (`.on`, `state(...)`) throw on zero or multiple keys | CLAUDE.md safety one-liner; `state-management.md` | `state-builder.spec.ts` → "should throw when .on() receives multiple keys", "should throw when record has more than one key", "should throw when record has zero keys" |
| Same-name state partials sharing an event must reference the same Zod schema instance; mismatched references throw | CLAUDE.md safety one-liner; `state-management.md` | `slice.spec.ts` → "throws when same-name state partials use different schema references for the same event" |
| Scoped Acts keep per-Act store and cache isolated (no cross-talk) | CLAUDE.md safety one-liner; `extension-points.md` | `scope.spec.ts` → "two Acts with their own scoped ports — no cross-talk", "scoped cache keeps per-Act snapshots isolated" |
| Cross-process reactions: the orchestrator auto-wires `Store.notify` **at construction** when the store supports it and reactive events exist; it does not wire when the store lacks `notify` or there are no reactive events | CLAUDE.md "Cross-process reactions"; `cross-process-reactions.md` | `notify.spec.ts` → "subscribes when store has notify and reactions exist", "does not subscribe when store lacks notify", "does not subscribe when there are no reactive events" **(gap filled — #1065)** |

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
