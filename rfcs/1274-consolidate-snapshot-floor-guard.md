# RFC 1274: Consolidate the `with_snaps` snapshot-floor eligibility guard at the orchestrator

- **Status:** draft <!-- draft | accepted | rejected | superseded -->
- **Issue:** #1274 (supersedes the piecemeal fixes #1267, #1270; folds in #1261)
- **Author:** rotorsoft
- **Created:** 2026-07-16

## Motivation

The `with_snaps` **resume floor** is a cold-load optimization: to load one stream's
current state, the store skips straight to the latest `__snapshot__` instead of
folding from the beginning. That jump is correct **only when the caller wants the
live tail of one exact stream with no window of its own.** The moment the query
carries a bound — an id cutoff, a timestamp cutoff, an event limit — the latest
snapshot may sit *outside* what the caller asked for, and jumping to it silently
corrupts the result.

Every adapter re-implements the "is this query eligible for the floor?" decision
inline, as a **fail-open allowlist of bounds that suppress it**:

```ts
with_snaps && stream_exact && stream &&
  after === undefined && before === undefined &&
  created_before === undefined && created_after === undefined
```

That boolean is copied across three adapters and two scan directions (~five sites).
Every field added to `Query` / `AsOf` must be remembered in all of them, and a
miss doesn't fail loudly — it returns wrong data. We have now shipped the same bug
four times, each a different bound the guard forgot:

| Ticket | Forgotten bound | Symptom |
|---|---|---|
| #1258 / #1261 | `created_before` / `created_after` | time-travel by timestamp folds empty |
| #1267 | `before` (id cutoff) | time-travel by id folds empty |
| #1270 | `backward` **direction** | pre-snapshot events leak (floor was start-jump-only) |
| **#1274** | `limit` | time-travel by limit folds from the snapshot, not the start |

`limit` is in `AsOf` but was never added to any guard, so `load({ limit: 2 })` on a
snapshotted stream returns current-ish state (reproduced: `expected 10 to be 3`).
The pattern guarantees a fifth instance the next time `Query` grows a field.

The root cause is an **altitude mistake**: the floor's eligibility depends on the
caller's *intent* (current-state read vs. bounded/time-travel read), which the
store cannot see — it only sees a flag and some filter fields. The orchestrator
*does* know the intent. In fact it already computes exactly the right predicate:

```ts
// event-sourcing.ts, load()
const time_travel = !!asOf && Object.values(asOf).some((v) => v !== undefined);
```

It uses `time_travel` to bypass the cache — but then, one line later, hands the
store `{ with_snaps: true, ...asOf }` unconditionally, re-delegating the eligibility
decision it just made back down to five fail-open copies.

## Design

Make the orchestrator the single source of truth, and make the stores dumb.

**1. Orchestrator requests the floor only when eligible.** One line in
`event-sourcing.ts`:

```ts
// before
...(cached ? { after: cached.event_id } : { with_snaps: true, ...asOf })
// after
...(cached
  ? { after: cached.event_id }
  : { ...(time_travel ? {} : { with_snaps: true }), ...asOf })
```

A time-travel load drops `with_snaps`, so the store does a full scan of real events
under the `asOf` bound and folds from `init`. The resulting state is identical to
today's (a snapshot's data is by definition the fold of everything at/below it), we
just don't take the jump — correct for *any* bound, including ones not yet invented.
This is **fail-closed**: a new `AsOf`/`Query` field defaults to suppressing the
floor (correct, unoptimized) instead of silently corrupting.

**2. Stores apply the floor whenever asked; the guards are deleted.** Each adapter's
floor trigger collapses to `with_snaps && stream_exact && stream` — no
`before`/`created_*`/`limit` checks. The floor *mechanism* stays per-adapter (PG/SQLite
SQL subquery, InMemory forward start-index, InMemory backward stop-condition); only the
drift-prone *eligibility* boolean goes away. Removing the guards is safe because the
orchestrator — the only supported caller — never sends `with_snaps: true` alongside a
bound after change (1). Direct `store.query({ with_snaps, before })` calls are not a
supported path.

**3. TCK tests relocate to the altitude that now owns the contract.** The store-TCK
keeps the raw floor-mechanism test (`with_snaps` + no bound → resume at snapshot, both
directions) and drops the bound-suppression cases. The suppression contract moves to
orchestrator-level specs in `libs/act/test/time-travel.spec.ts`, asserting
`load({ before | created_before | created_after | limit })` returns correct historical
state on a snapshotted stream. A small matrix there (each `AsOf` field × snapshot
above/below cutoff) is the standing guard that would have caught all four instances at
once.

## Public surface added

**None.** This is a semantics/structural change, not an addition:

- No new export. The eligibility predicate reuses the existing `time_travel` local in
  `event-sourcing.ts` (internal). No `snapshot_floor_eligible` helper is exported.
- No builder method, port method, or lifecycle event.
- No public type change — `AsOf` / `Query` are unchanged.

Because it adds no surface, the rfc-gate does not require this RFC; it exists to record
the **contract-semantics** decision (below), which the charter *does* cover.

## Alternatives considered

- **Keep the per-adapter guards; just add `limit` + a TCK matrix (status quo + patch).**
  Fixes #1274 but leaves the fail-open allowlist and its five copies in place — the
  fifth instance is still one `Query` field away. The TCK matrix would catch drift, but
  we'd be maintaining the same boolean in five places forever. Rejected: treats the
  symptom, not the altitude mistake.

- **Extract a shared `snapshot_floor_eligible(query)` predicate exported from core,
  imported by every adapter.** DRYs the boolean to one place (precedent: adapters import
  `is_query` / `is_literal_source` from `@rotorsoft/act`). But it *adds public surface*
  (a new export the charter then protects), keeps the decision in the store layer where
  it doesn't belong, and still requires each adapter to call it correctly in both
  directions. The orchestrator already has the predicate for free — exporting a second
  copy is strictly worse than using the one that exists. Rejected.

- **Do nothing.** Four shipped bugs and a structural guarantee of more. Not viable.

## Stability / charter impact

- **Category:** adapter contract (`Store.query`) — specifically the *semantics* of the
  `with_snaps` flag, documented in the `Store.query` doc-comment and
  `behavior-contracts.md` row 30.
- **Breaking?** Not for any supported path. `IAct.load` behavior is unchanged (it still
  returns correct current-state *and* time-travel state; time-travel loses only an
  internal perf shortcut). The change to `Store.query` is **strictly permissive** for
  adapter authors — a conforming adapter now does *less* (apply the floor when asked; no
  bound-guarding). Existing third-party adapters that still self-guard keep working,
  because the orchestrator stops sending the conflicting combo. Existing in-tree guards
  are removed as cleanup, not as a contract break callers can observe.
- **TCK / in-tree adapters:** store-TCK bound-suppression cases are removed; the raw
  floor-mechanism case stays and gains a backward variant; orchestrator-level
  suppression tests are added under `libs/act/test/`. All three in-tree adapters
  (InMemory / act-pg / act-sqlite) are simplified in lockstep.
- **Doc audit:** `Store.query` doc-comment and `behavior-contracts.md` row 30 + row 39
  are rewritten to state that floor eligibility is an orchestrator concern and that
  `with_snaps` on the store means "apply the floor."
- **Supersedes:** #1267 (PR #1271) and #1270 (PR #1273) — their localized guards are
  replaced by the one-line orchestrator toggle; #1261's guards are removed too. Whether
  to land #1267 (high-severity) first and refactor after, or go straight to the
  consolidation, is an open question below.

## Open questions

1. **Landing order.** #1267 is a high-severity data-corruption bug with an approved,
   isolated fix already in review (PR #1271). Do we (a) merge #1267 now for the fast fix
   and let this RFC's PR remove its guard as cleanup, or (b) close #1271/#1273 and ship
   only the consolidation? Option (a) de-risks the high-sev bug; option (b) avoids
   churn. Recommendation: (a) if the consolidation needs more than a day of review,
   else (b).
2. **Residual store guard.** Should stores keep the minimal `stream_exact && stream`
   part of the trigger (defensive, cheap), or assume the orchestrator always loads one
   exact stream? Proposed: keep `with_snaps && stream_exact && stream` — it's not a
   bound-guard, just the definition of when a per-stream floor is meaningful.
3. **Time-travel perf.** Dropping `with_snaps` on time-travel loads removes the
   below-cutoff-snapshot anchor optimization, so a bounded load full-scans real events.
   Time-travel already bypasses the cache and is the rare/slow path, so this is
   presumed acceptable — flagging in case a caller relies on snapshot-anchored
   time-travel at scale.
