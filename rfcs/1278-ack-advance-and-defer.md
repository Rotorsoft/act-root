# RFC 1278: `Store.ack` advances the watermark and defers in one entry

- **Status:** accepted
- **Issue:** #1278
- **Author:** Claude Opus 4.8
- **Created:** 2026-07-18

## Motivation

On a partial-progress drain — a leased stream carries several events for one
`backoff`-configured reaction, an earlier event succeeds and a later one throws
— the finalize step must do two things: advance the watermark past the events
that *did* succeed, and persist the backoff window (`deferred_at` + climbing
`retry`) for the failing tail.

The original `Store.ack` contract made these mutually exclusive: an entry with
`due` set persisted the schedule **without advancing the watermark** (a defer
holds), an entry without `due` advanced (a plain ack). So a partial-progress
backoff could only pick one. #1278 first shipped the "hold the whole stream"
choice: persist the window, hold the watermark, and let the succeeded prefix
re-run on redelivery. That closed the durability leak but re-ran already-handled
events every backoff window until the tail cleared — up to `N × maxRetries`
redundant reaction invocations. Reactions are idempotent by contract, so it was
*safe*, but wasteful, and it left the watermark-advance behavior the ticket
itself flagged as working (advance past the succeeded events) regressed.

## The change — advance and defer are independent legs

`Store.ack` now treats `at` and `due` as independent:

- **`at`** — the entry always advances the stream watermark to `at` (the last
  event fully handled this cycle).
- **`due`** — when present, the entry *additionally* persists `deferred_at =
  due` and sets `retry` to the entry's own value (climbing on backoff, `-1` on
  an explicit defer). When absent, the entry clears `retry` and `deferred_at`
  (a plain ack).

So a partial-progress backoff/defer advances past the handled prefix **and**
schedules the remainder in one atomic entry — the handled events never re-run.

### Orchestrator side

`run_drain_cycle` computes the advance target per result: `acked_at` (the last
fully-handled event) when the batch made progress, and the pre-fetch watermark
`floor` (`leased[i].at`, a no-op advance) when it did not. The `floor` guard is
load-bearing: on a *no-progress* failure `acked_at` is initialized to the fetch
ceiling (last-fetched id), so advancing to it would skip the failed event.
`leased[i]` pairs with `handled[i]` (Promise.all preserves order), so `floor` is
the untouched claim watermark — no new plumbing through `build_handle`.

Explicit defers ride the same rule, so a mid-batch defer also advances past its
succeeded prefix. Every existing defer test defers immediately (handled == 0),
where the advance target is the floor — a no-op — so the change is behavior-
neutral for them.

### Adapter side

All three adapters drop the `at = CASE WHEN due IS NULL THEN i.at ELSE s.at END`
hold and set `at = i.at` unconditionally; the `deferred_at` / `retry` legs stay
gated on `due`. InMemory, PostgresStore, and SqliteStore change identically.

## Public surface / charter impact

- **Charter-covered port** (`Store.ack`, `Lease.due` doc). This is a **semantic
  refinement**, not a signature change — `Lease` already carried both `at` and
  `due`; no field is added, removed, or retyped. Previously no caller ever set
  both on one entry, so the change adds behavior to a combination that was
  never exercised — it does not alter any input shape a caller relies on.
- The `Lease.due` doc-comment is updated ("advance to `at`, then defer" — no
  longer "without advancing the watermark").
- **TCK** gains "advances the watermark to `at` while persisting the schedule on
  a partial-progress due lease (#1278)"; the two existing hold cases keep
  passing (they pass `at` = the claim watermark, so the advance is a no-op) with
  clarified comments. Validated against InMemory, PostgresStore, SqliteStore.

## Alternatives considered

- **Hold the whole stream (the first #1278 fix, superseded here).** Persist the
  window, hold the watermark, re-run the succeeded prefix on redelivery.
  Orchestrator-only, no adapter change. Rejected because the redundant re-runs
  are real work (bounded by `maxRetries`) and it regresses the watermark-advance
  behavior; correctness was fine, efficiency was not.
- **Thread the pre-fetch floor through `build_handle`.** Change `handle` /
  `handle_batch` to take the fetch ceiling as a separate argument and initialize
  `at` to the floor, so `acked_at` is always advance-safe. Rejected as
  unnecessary: `leased[i].at` already *is* the floor, reachable via the
  `flatMap` index, with no signature churn on the hot path.
- **A new explicit `advance` flag on the ack entry.** Rejected: `at` already
  expresses the advance target; a partial-progress entry passes `acked_at`, a
  hold passes the floor. No new field needed.

## Stability / charter impact

Category: **port semantics** (STABILITY.md). Additive/refining — no rename,
removal, or narrowed type. The behavior-contract checklist gains a row for
"a due-marked ack advances the watermark to `at` and persists the schedule,"
pinned by the new TCK case and `backoff.spec.ts` → "advances the watermark past
the succeeded prefix AND persists the window on partial progress (#1278)."

## Open questions

None.
