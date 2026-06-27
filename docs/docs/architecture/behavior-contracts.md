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
| Snapshot writes are fire-and-forget; a snap failure does not propagate | `cache-and-snapshots.md` "Snapshot creation" | `event-sourcing.spec.ts` → "should not throw on snap error" |
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

## Store contract (runs on all three adapters via the TCK)

| Claim | Source | Backing test |
|---|---|---|
| `subscribe` is idempotent on repeat | `Store.subscribe` doc | `store-tck.ts` → "subscribes new streams and is idempotent on repeat" |
| `subscribe` keeps the **maximum** priority when a stream is re-subscribed with a different priority | `Store.subscribe` `priority` doc-comment | `store-tck.ts` → "keeps the maximum priority when a stream is re-subscribed" **(gap filled — #1029)** |
| `prioritize` sets priority **directly**, overriding `subscribe`'s max() rule | `Store.prioritize` doc | `store-tck.ts` → "sets priority directly, overriding subscribe's max() rule" |
| `unblock` returns 0 when the stream is not blocked; `reset`/`unblock` return 0 for unknown/empty input | `Store.unblock` / `Store.reset` docs | `store-tck.ts` → "returns 0 when the stream is not blocked", "returns 0 for unknown streams and empty input" |
| `truncate` deletes events, removes the stream entry, and seeds a snapshot or tombstone | `Store.truncate` doc | `store-tck.ts` → `truncate` describe block |
| `forget_pii` wipes PII for every event and is idempotent (second call returns 0; no-PII stream returns 0) | `Store.forget_pii` doc | `store-tck.ts` → "wipes pii for every event on the stream via forget_pii", "is idempotent — second forget_pii returns 0, no error", "forget_pii on a stream with no pii events returns 0" |
| `query_streams` reports `maxEventId` tracking the highest committed id | `Store.query_streams` doc | `store-tck.ts` → "maxEventId tracks the highest committed id" |

## Orchestrator and builders

| Claim | Source | Backing test |
|---|---|---|
| `app.reset()` arms the orchestrator's drain flag, so a settled app still replays (`store().reset()` alone does not) | CLAUDE.md safety one-liner; `event-sourcing.md` | `rebuild.spec.ts` → "should replay events when drain runs after reset on a settled app" |
| `reset` resets watermarks to -1 and unblocks blocked streams | `Store.reset` doc | `rebuild.spec.ts` → "should reset subscribed stream watermarks to -1", "should unblock blocked streams after reset" |
| A static `.emit()` of a deprecated event version throws at build | `event-schema-evolution.md`; CLAUDE.md safety one-liner | `deprecation.spec.ts` → "throws when an action statically emits a deprecated event" |
| Single-key records (`.on`, `state(...)`) throw on zero or multiple keys | CLAUDE.md safety one-liner; `state-management.md` | `state-builder.spec.ts` → "should throw when .on() receives multiple keys", "should throw when record has more than one key", "should throw when record has zero keys" |
| Same-name state partials sharing an event must reference the same Zod schema instance; mismatched references throw | CLAUDE.md safety one-liner; `state-management.md` | `slice.spec.ts` → "throws when same-name state partials use different schema references for the same event" |
| Scoped Acts keep per-Act store and cache isolated (no cross-talk) | CLAUDE.md safety one-liner; `extension-points.md` | `scope.spec.ts` → "two Acts with their own scoped ports — no cross-talk", "scoped cache keeps per-Act snapshots isolated" |

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
