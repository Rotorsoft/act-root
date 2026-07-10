# RFC 1011: close the books on a rolling window — prune history before a snapshot

- **Status:** draft
- **Issue:** #1011 (part of #1008)
- **Author:** Roger Torres (with Claude)
- **Created:** 2026-07-10

## Motivation

`close`/`.autocloses` cover streams whose lifecycle *ends* (tombstone) or whose
history can collapse to a single synthesized snapshot (`restart: true`). Neither
keeps a **windowed tail of real events** on a live stream: restart is "forget
everything before now"; regulated workloads and audit trails need "forget
everything before the window" — keep exactly the last N days queryable as real
events, archive + drop only the prefix older than the window.

The foundation that makes this safe: loads are snapshot-anchored. On a cache
miss `load()` replays `with_snaps: true` and resets state at each
`__snapshot__`, so events before the latest snapshot contribute nothing to any
load result. Deleting a prefix **behind a real app-written snapshot** cannot
change what `load()` returns — no history rewrite, no synthesized boundary.

## Public surface added

All additive; no new methods, no new lifecycle events.

- **`Store.truncate` target** gains optional boundary fields:
  `{ stream, before?: Date, max_id?: number }`. With `before`, the store finds
  the closest safe `__snapshot__` (latest with `created < before` and
  `id <= max_id` when given), deletes events with `id <` that snapshot's id,
  keeps the snapshot + tail, seeds nothing, tombstones nothing, and leaves the
  subscriptions table untouched. No qualifying snapshot ⇒ no-op (stream absent
  from the result). `snapshot`/`meta` must be omitted on windowed targets.
- **`TruncateResult` entry** gains optional `before?: Date` — echoed on
  windowed entries so `closed` consumers can distinguish prunes from full
  closes. On windowed entries `committed` is the surviving boundary snapshot
  (already-committed; nothing new is written).
- **`CloseTarget.before?: Date`** — `app.close([{ stream, before, archive? }])`
  runs the windowed branch: safety probe → per-stream `max_id` (min consumer
  watermark), archive callback, boundary truncate. Mutually exclusive with
  `restart`. `CloseResult.skipped` also collects windowed no-ops.
- **`AutoclosePolicy.keep?: { days: number }`** — the rolling-window variant of
  `.autocloses({...})`. Independent of the terminate fields (`after`/`is`/
  `reaches`/`or`): a policy may terminate, prune, or both. Type-gated behind
  `.snap(...)` — `ActionBuilder` gains a `TSnap extends boolean = false`
  type parameter that `.snap()` flips to `true`; `keep` is only accepted when
  `TSnap` is `true`, and the builder throws at runtime when `.autocloses` with
  `keep` precedes `.snap`. A windowed close is meaningless without snapshots.
- **`AutocloseArchiver`** gains an optional third parameter `before?: Date` so
  `.archives(fn)` archivers can page exactly the pre-cutoff prefix on prunes.
- **`State.autoclose_keep_days?: number`** (internal-facing field on the
  public `State` type, set by the builder, consumed by the synthesized
  reaction). The sibling `autoclose_after_ms` (#1090) is renamed to
  `autoclose_after_days` in the same pass so the whole close surface speaks
  days — a pre-adoption reshape (no published callers), MINOR per project
  precedent. Epoch arithmetic is confined to the `days_after` /
  `days_before_now` helpers in `autoclose-policy.ts`; nothing close-facing is
  denominated in ms/seconds/minutes.

## Execution model

The ticket predates #1090; "retention sweep" translates to the synthesized
autoclose reaction. With `keep`, the reaction's handler queries
`query_stats(..., { tail: true, count: true, exclude: [TOMBSTONE, SNAP] })`
and:

1. terminate predicate matches → full `CloseSignal` (unchanged);
2. else oldest domain event older than `now − keep` → `CloseSignal` with
   `before = now − keep` (a windowed close staged through the same `on_close`
   path);
3. else defer to the earliest derivable due-time —
   `min(head.created + after days, tail.created + keep days)`.

`tail.created + keep days` is exact: the next prune can be productive no sooner
than when the oldest surviving domain event ages out of the window. Off-hours
(`autocloseWindow`) gating applies unchanged, before any evaluation.

## No head guard on windowed closes

The full close tombstone-guards the head so archive runs against a frozen
stream. A windowed close needs no guard: `before` is always in the past, so a
concurrently-written snapshot (`created = now`) can never qualify as the
boundary — once the cutoff is fixed the boundary snapshot is fixed, and the
prefix below it is immutable. Concurrent appends land at the head, above the
boundary. Consumer safety comes from `max_id` (the min watermark of matching
subscriptions, probed read-only via `query_streams`): the boundary never rises
past what the laggiest consumer has read, so a lagging reaction degrades the
prune to a smaller (or no-op) prune, never to data loss. This makes a windowed
close strictly lighter than a full one — no guard commit, no cache touch.

## Alternatives considered

- **New verbs (`trim`/`.autotrims`/`Store.trim`)** — rejected by the 2026-07
  design review recorded in the ticket: accounting closes *periods*, not just
  accounts; the rolling window is a close variant, and sibling verbs would
  triplicate surface across builder, `IAct`, and port.
- **Synthesizing the boundary snapshot** (Marten's `CompactStreamAsync`) —
  rejected: it rewrites history and must fold state inside the store call.
  Anchoring on a real `.snap()` snapshot means deletes only; the precondition
  (stream must snapshot) is enforced by the type gate instead.
- **Guarding the head during windowed archive** — rejected as unnecessary (see
  above); the archive-while-guarded invariant protects full closes where the
  *whole* stream is about to vanish, which is not the case here.
- **Union type for the `truncate` target** — rejected as noise; a single shape
  with documented mutual exclusion keeps the port simple and the orchestrator
  is effectively the only caller constructing windowed targets.
- **Do nothing** — operators can already partition + `DROP PARTITION`, but that
  is table-wide; per-stream regulated retention windows have no answer today.

## Stability / charter impact

- Categories: adapter contract (`Store.truncate` target + `TruncateResult`),
  `IAct` types (`CloseTarget`, `CloseResult` semantics), builder API
  (`.autocloses` option, `ActionBuilder` type param with default), public types
  (`AutoclosePolicy`, `AutocloseArchiver`, `State`).
- Everything is **additive** (optional fields, optional param, defaulted type
  parameter) — MINOR.
- Port change rule: InMemory + act-pg + act-sqlite updated in lockstep; TCK
  gains boundary-truncate cases (prefix deleted, snapshot + tail kept, `max_id`
  cap honored, no-snapshot no-op, multi-target mixing full + windowed,
  full-truncate behavior unchanged, subscriptions preserved).

## Open questions

None — the head-guard question flagged in the ticket is settled above.
