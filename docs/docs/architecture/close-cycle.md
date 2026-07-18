---
id: close-cycle
title: Close cycle
---

# Close cycle

`app.close(targets)` archives, tombstones, and truncates streams from the operational store. The event-sourcing equivalent of "closing the books" in accounting: summarize the period, archive the detail, optionally restart with a fresh opening balance.

`Act.close()` first runs `correlate({ limit: 1000 })` so the safety probe in Phase 2 sees dynamic reaction targets, then hands off to `run_close_cycle` which executes six gating phases (1 through 6 below). Phase 0 is the preparatory correlate. Failures at each phase have well-defined recovery characteristics — the goal is that any partial-failure state is *safe* (no data loss, no inconsistent state, retryable).

Targets carrying a `before` cutoff never enter this pipeline. `run_close_cycle` splits the target list up front: `before` and `restart` are mutually exclusive (the call throws before touching the store), windowed targets take a dedicated branch (see [Windowed close](#windowed-close--prune-behind-a-snapshot) below), and the remaining full targets run the phases unchanged.

## Phase diagram

```
            close(targets)
                  │
                  ▼
          ┌───────────────────────────┐
          │ Phase 0: Correlate        │  Discover dynamic reaction targets so the safety check
          │   correlate(limit:1000)   │  in Phase 2 can see them.
          └───────────┬───────────────┘
                      │
                      ▼
          ┌───────────────────────────┐
          │ Phase 1: Scan stream heads│  For each target, find the latest non-tombstone event in
          │   query_stats             │  a single indexed round trip; snapshots filtered out.
          └───────────┬───────────────┘
                      │
                      ▼
          ┌───────────────────────────┐
          │ Phase 2: Safety partition │ Skip any stream whose subscribed reactions are still
          │   query_streams           │ behind the head. Those go into `skipped`.
          └───────────┬───────────────┘
                      │
                      ▼
          ┌───────────────────────────┐
          │ Phase 3: Guard with       │ Commit `__tombstone__` with expectedVersion. If the
          │   tombstones (parallel)   │ stream advanced past our scan (concurrent writer),
          │                           │ we get ConcurrencyError → that stream goes to skipped.
          └───────────┬───────────────┘
                      │
                      ▼
          ┌───────────────────────────┐
          │ Phase 4: Load restart     │ For targets with `restart: true`, load the final state
          │   seeds (parallel)        │ NOW, while the stream is guarded. The owning state is
          │                           │ derived from the last event's name → registered state.
          └───────────┬───────────────┘
                      │
                      ▼
          ┌───────────────────────────┐
          │ Phase 5: Run archive      │ User callback per stream. Sequential: callbacks may
          │   callbacks (sequential)  │ share resources (S3 client, etc). A failure here
          │                           │ propagates to the caller; streams remain guarded.
          └───────────┬───────────────┘
                      │
                      ▼
          ┌───────────────────────────┐
          │ Phase 6: Truncate + seed  │ Atomic per-store transaction: delete every event for
          │   (atomic per stream)     │ the stream, insert a single seed (`__snapshot__` for
          │                           │ restart, `__tombstone__` for tombstone-only).
          └───────────┬───────────────┘
                      │
                      ▼
                 Cache update
                      │
                      ▼
                 emit("closed", result)
```

## Phase-by-phase failure semantics

The framework's invariant: **at every stable state during close, the stream is in a coherent, retryable shape.** No matter where you crash, re-running close on the same target produces the same final result (idempotent) or skips it cleanly (already done).

### Phase 0 — Correlate

If `app.close()` is called and dynamic-resolver streams haven't been correlated yet, the safety check in Phase 2 would miss them. So we explicitly correlate first with a generous limit.

- **If correlate fails**: close() throws to caller. Nothing has been written. Idempotent retry.

### Phase 1 — Scan stream heads

Call `Store.query_stats(streams, { exclude: [SNAP_EVENT] })` once for the whole target set. The store returns the latest non-snapshot event per stream in a single round trip — on Postgres and SQLite this uses the existing `(stream, version)` index for an index-only path (see [ACT-639](https://github.com/Rotorsoft/act-root/issues/639)). Streams whose latest non-snap event is a tombstone are skipped in the consuming loop (the call doesn't re-tombstone an already-closed stream). The kept entries become a `Map<stream, { maxId, version, lastEventName }>` consumed by the subsequent phases.

- **Stream has no domain events**: absent from the result map (no qualifying event). Phase 2's `safe` list excludes it. Result: stream untouched.
- **Stream has only a tombstone**: included in the result map (the head is the tombstone), then dropped by the explicit `head.name === TOMBSTONE_EVENT` filter in the consumer. Same outcome — skipped.
- **`query_stats` call fails**: close() throws to caller. Streams are untouched.

Before #639 this phase ran `N` parallel `query(backward: true, limit: 1)` calls — one round trip per stream. The new shape collapses to one call regardless of `N`, which matters most for bulk close jobs (hundreds of streams).

### Phase 2 — Partition by safety

For apps with reactions, we can't tombstone a stream that still has pending reactions in flight — those reactions would never run after the truncate.

Optimization: when `reactiveEvents.size === 0`, skip the safety probe entirely (every stream is safe). Most close operations on apps without reactions take this path.

Otherwise, walk `query_streams` (read-only — no leasing, no state mutation), keyset-paginating on the `after` cursor through every matching position so coverage doesn't depend on subscription count. The probe passes `source_matches` scoped to the streams being closed, narrowing the scan to subscriptions whose `source` could match a target; since that filter is best-effort, the probe re-checks source and target in process for each row. For each subscribed reader's position, it marks any target that still has unprocessed events behind that reader.

- **Reader is behind**: target goes to `skipped`. Callable code can retry close after the reader catches up (e.g., after `await app.settle()`).
- **Reader is at or past head**: target is `safe`.
- **Probe fails**: close() throws. Nothing committed.

### Phase 3 — Guard with tombstones

For each safe stream, commit a `__tombstone__` event with `expectedVersion = lastVersion` from Phase 1. The tombstone serves two purposes:

1. **Concurrency check**: if another writer committed between Phase 1's scan and now, our `expectedVersion` won't match and we get `ConcurrencyError`. That stream moves to `skipped`.
2. **Block subsequent commits**: `action()` checks the head event before committing. If the head is `__tombstone__`, `action()` throws `StreamClosedError`. No new events can land on this stream from this point forward.

All guards run in parallel (`Promise.all`). Each result is independently bucketed: `guarded` (tombstone landed) or `skipped` (concurrency error).

- **Guard fails for some streams**: those go to `skipped`. The remaining guards continue.
- **No streams guarded**: close returns early with `{ truncated: empty, skipped }`. Other phases don't run.

After this phase, the framework's invariant is: **every stream in `guarded` has a tombstone at head and no concurrent writer can land an event on it.**

### Phase 4 — Load restart seeds

For each guarded stream where `target.restart === true`, load the final state.

This phase runs *after* the guard, not before, by design. Loading state requires reading events. If we loaded before the guard, a concurrent commit could change the stream while we're reading; the seeded snapshot would be stale.

After the guard, no concurrent writer can interfere. The load reflects the exact state at the moment the stream was guarded.

The "owning state" for each stream is found via `eventToState.get(lastEventName)`. The build-classify pass at Act construction builds this map: event-name → state-definition that emits it. The duplicate-event guard in `merge.ts` ensures one event maps to at most one state.

- **No state owns the last event** (deleted state, schema versioning gone wrong): we can't seed. The stream still gets tombstoned (no `restart: true` semantics), but a warning is logged. This is a degraded state — cold path.
- **Load fails**: propagates to caller. Streams remain guarded but not truncated. Retryable.

### Phase 5 — Run archive callbacks

Sequential. Each `target.archive?` callback is awaited in turn.

```ts no-check
for (const stream of guarded) {
  const archiveFn = targetMap.get(stream)?.archive;
  if (archiveFn) await archiveFn();
}
```

Why sequential: archive callbacks frequently share connections (S3 client, etc). Parallel parallel writes can exhaust connection pools and produce nondeterministic failure modes. A user who *wants* parallelism can fan out in their own callback.

- **Callback throws**: propagates. Subsequent callbacks don't run. Streams remain *guarded but not truncated*. The caller can retry close — Phase 1's scan will find the existing tombstone, Phase 3 will detect the stream is already at the tombstone version (no-op guard), Phase 4 will reload (idempotent), Phase 5 will run archive *again*. Archive callbacks must be idempotent, or the user must tolerate retries.
- **Callback succeeds for some, fails for one**: same — subsequent streams don't truncate. Retryable.

After this phase: archive completed (or partially completed); streams still tombstoned but not truncated. Safe state.

### Phase 6 — Truncate + seed

Atomic per-stream transaction. For each guarded stream:

```sql
BEGIN
  DELETE FROM events WHERE stream = ?
  DELETE FROM streams WHERE stream = ?
  INSERT INTO events (...)  -- the seed: __snapshot__ if restart, __tombstone__ otherwise
COMMIT
```

The seed is not optional. After truncate, the events table for this stream has exactly one row — either a snapshot (allowing future actions to start fresh from it) or a tombstone (closing the stream permanently).

The result map contains `{ deleted: count, committed: seed_event }` per stream. The cache is then updated:

- **Restart**: `cache.set(stream, { state: seed, version: 0, event_id: seed.id, patches: 0, snaps: 1 })`. Future loads serve the seed state from cache.
- **Tombstone**: `cache.invalidate(stream)`. The cache is cleared; future loads will see only the tombstone and `action()` will throw `StreamClosedError`.

- **Truncate fails for one stream**: that stream's pre-truncate state is preserved (transaction rolled back). Other streams continue. The failed stream is still safely guarded — retryable.

## Idempotency

Calling `close()` on an already-closed stream is a no-op:

1. Phase 1's `query_stats` returns the head — which is `__tombstone__` — but the consumer loop drops any entry whose `head.name === TOMBSTONE_EVENT` so we don't re-tombstone an already-closed stream
2. Phase 1's result map doesn't include this stream
3. Phase 2's `safe` list doesn't include this stream
4. Result: stream isn't in `truncated`, isn't in `skipped` from a concurrency error — it's just absent

For a stream that's been *restarted* but not tombstoned (one `__snapshot__` event at v=0), Phase 1 calls `query_stats` with `exclude: [SNAP_EVENT]` so the snapshot is filtered out server-side — leaving the stream absent from the result map. Without a head, Phase 2 doesn't include the stream in `safe`, so the restarted-but-empty stream stays untouched. To force-tombstone a restarted stream, commit at least one domain event first.

## Windowed close — prune behind a snapshot

A full close is a lifecycle ending: the stream is done, freeze it, archive it, tombstone it. `app.close([{ stream, before: cutoff }])` closes the books on a **rolling window** instead: the stream stays live and keeps accepting actions, but the prefix of events older than the cutoff is deleted from the operational store. Nothing is seeded, nothing is tombstoned, and the subscriptions table is untouched.

What makes this safe at all is that loads are snapshot-anchored. On a cache miss `load()` replays with `with_snaps: true` and resets state at each `__snapshot__`, so events before the latest snapshot contribute nothing to any load result. Deleting a prefix behind a real, app-written snapshot cannot change what `load()` returns — there is no history rewrite and no synthesized boundary. This is the same anchoring that distinguishes the primitive from Marten's `CompactStreamAsync`, which synthesizes a snapshot inside the store call; the closest relative is EventStoreDB's `$tb` (truncate-before), the same prefix-delete idea. The precondition follows directly: the state must snapshot (`.snap(...)`), because without snapshots there is no boundary to anchor on.

`run_windowed_closes` (in `libs/act/src/internal/close-cycle.ts`) runs the min-watermark probe once, then processes each target under a **per-stream lock** (see below):

1. **Min-watermark probe.** A read-only `query_streams` walk — same pagination and conservative in-process source matching as the full path's Phase 2 — folds the minimum subscription watermark per target stream. This becomes the `max_id` cap handed to the store: the boundary snapshot may never sit above what the laggiest consumer has read. When the app has no reactions at all, the probe is skipped entirely; nothing can lag.
2. **Prune-pending probe.** Inside each stream's critical section, a read-only query resolves the boundary the truncate *would* pick — the latest `__snapshot__` with `created < before` (and, when capped, `id <= max_id`) — and asks whether any event sorts below it. No qualifying snapshot, or a boundary that is already the earliest event, means there is nothing to prune: the stream is reported in `skipped` and the archive is not run.
3. **Archive.** The per-target `archive` callback runs against the cutoff, only for streams the prune-pending probe accepted. The prefix being archived is immutable (see below), so the callback reads stable history even while the stream keeps committing at the head.
4. **Boundary truncate.** A `Store.truncate` call with `{ stream, before, max_id }`. The store finds the closest safe boundary — the latest `__snapshot__` with `created < before` and, when `max_id` is given, `id <= max_id` — and deletes events below it, keeping the snapshot and everything after it.

### Why there is no head guard, but there is a per-stream lock

The full path tombstone-guards each stream so the archive callback runs against a frozen stream — necessary when the *whole* stream is about to vanish. The windowed branch needs no guard against **appends**, because the cutoff is always in the past. A concurrently-written snapshot carries `created = now`, so it can never qualify as the boundary; once the cutoff is fixed, the boundary snapshot is fixed, and the prefix below it is immutable. Concurrent appends land at the head, above the boundary, where the prune never reaches. Consumer safety doesn't need the guard either — it comes from the `max_id` cap: a lagging reaction degrades the prune to a smaller prune (or a no-op), never to data loss. The cache also stays warm: current state is unchanged by construction, so there is nothing to invalidate.

The guard-free design assumes a **single closer per stream**, and that assumption doesn't hold on its own ([#1222](https://github.com/Rotorsoft/act-root/issues/1222)). An autoclose windowed close runs under the `__autoclose__:X` drain lease, but a manual `app.close([{ stream: X, before }])` calls `run_close_cycle` directly and never takes that lease — so both can enter the windowed branch for the same stream at once, and each would fire the user's `archive` callback against the same prefix (a double S3 upload / double JSONL append). The orchestrator threads a **process-local per-stream lock** into the cycle (shared across `app.close` and the drain's `on_close`, since both run on the same Act instance). Windowed work for a given stream serializes behind it; the second closer through runs the prune-pending probe, sees the prefix has already been pruned (the boundary is now the earliest event), skips its archive, and lands in `skipped`. Different streams still proceed in parallel. This coordinates archive at-most-once per pruned range without reintroducing a store-level guard or changing the days-only, prune-not-retire semantics.

### Skipped semantics and result shape

A stream with no qualifying snapshot (never snapshotted, or every snapshot is younger than the cutoff or above the `max_id` cap) is a no-op: the store leaves its events untouched and omits it from the truncate result, and `run_windowed_closes` reports it in `CloseResult.skipped` — the same bucket the full path uses for pending-reaction and concurrent-writer skips. Retry after the next snapshot lands.

Streams that did prune appear in `CloseResult.truncated` with two windowed markers: the entry echoes `before`, and `committed` is the **surviving boundary snapshot** — an event the app wrote earlier, not a new seed. Consumers of the `closed` lifecycle event use the `before` field to distinguish prunes from full closes. Mixed target lists work in one call: windowed entries and full entries land in the same `truncated` map, skips from both branches in the same `skipped` array.

## Online close-the-books

`Act.close(targets)` is the **explicit** close path — the operator hands the framework a list of stream names, the cycle runs once, the streams get truncated. Online close is the **declarative** version of the same primitive: a state declares a close policy, and the framework retires eligible streams without anyone calling `close`. As of [#1090](https://github.com/Rotorsoft/act-root/issues/1090) it is no longer a background sweep. `.autocloses(policy)` compiles to an internal **reaction** that rides the same drain the rest of the app already runs, and that reaction reuses `run_close_cycle` (phases 0–6 above) when a stream finally qualifies.

### Surface

Two state-builder declarators:

- `.autocloses(policy)` — a declarative `AutoclosePolicy` object (`{ is, after, reaches, or, keep }`). The terminate fields (`is` / `after` / `reaches` / `or`) decide when a stream's lifecycle ends; `keep: { days }` is the independent rolling-window variant that stages [windowed closes](#windowed-close--prune-behind-a-snapshot) while the stream stays open (see [the close-policies guide](../guides/close-policies.md#keep--days---the-rolling-window)). The opaque function-predicate form is gone; see [the migration note in the close-policies guide](../guides/close-policies.md#migrating-from-the-function-predicate-form).
- `.archives(fn)` — `(stream, head, before?) => Promise<void>`. Optional companion. On a full close it runs while the stream is guarded but **before** truncate so the host can persist events to durable storage (S3, cold tier) before the tombstone lands. On a windowed close the third argument carries the cutoff (absent on full closes): archive the events older than `before` — the prune deletes a subset of them (the prefix below the boundary snapshot), so archive plus live stream always equals full history.

Both are state-level (one per state, last-write-wins, mirror of `.snap` / `.discloses`). Absent → the state opts out of online close entirely; the orchestrator synthesizes no reaction for it and pays nothing.

### Autoclose as a synthesized reaction

At build time (`act().build()` synthesizes the reaction once the registry is fully merged — before the orchestrator classifies it, so its dynamic resolver is discovered and its target subscribed), the builder walks every state that declared `.autocloses(policy)` and injects one reaction registered against every event that state owns. The registry is then frozen; the orchestrator never mutates it. The handler doesn't sweep anything — it fires when the aggregate commits, evaluates the policy against the aggregate's **live head**, and either closes, defers, or does nothing.

The subtle part is *where* the reaction runs. It runs on a **synthetic per-aggregate stream**: `target = __autoclose__:<stream>`, `source = <stream>`. Keeping the autoclose lease off the aggregate's own watermark is load-bearing — if it shared a watermark with the aggregate's other reactions, an autoclose deferral would hold all of them back too (a deferral parks the whole stream). The synthetic target isolates the autoclose lease so it can defer freely; the close still *targets* the aggregate.

```
            aggregate commits event e
                       │
                       ▼  (synthetic stream __autoclose__:<e.stream>, source = e.stream)
          ┌────────────────────────────────────────────┐
          │ off-hours window check                      │  outside the window →
          │   in_autoclose_window(autocloseWindow, now) │  DeferSignal(now + cycleMinutes)
          └───────────────────┬────────────────────────┘
                              │ in window
                              ▼
          ┌────────────────────────────────────────────┐
          │ query_stats([aggregate], {count,            │  no live (non-tombstone)
          │   exclude:[TOMBSTONE_EVENT]})               │  head → return (already closed)
          └───────────────────┬────────────────────────┘
                              │ live head + count
                              ▼
          ┌────────────────────────────────────────────┐
          │ policy(aggregate, head, count) ?            │
          └───────┬───────────────────────┬────────────┘
            true  │                        │ false
                  ▼                        ▼
       CloseSignal({ stream,    policy has a time gate (after) ?
         archive, at: head.id })   yes → DeferSignal(head.created + min after)
                  │                  no  → ack, wait for the next event
                  ▼
       DrainController.on_close → run_close_cycle(targets) → emit("closed")
```

Because the policy is re-evaluated against the live head on every visit, a **reopened** stream re-evaluates correctly: a ticket resolved and then reopened has `Opened` at head, so an `is: "Resolved"` policy no longer holds and the stream is not closed. The handler runs with `blockOnError: false` and `maxRetries: 3` — a transient `query_stats`/store error retries rather than quarantining the synthetic stream, and a stream that vanishes mid-cycle (a competing worker truncated it) yields an empty `query_stats` result and the handler simply returns.

A `keep` policy rides the same reaction with two additions. Its `query_stats` call also fetches the **tail** and excludes snapshots along with tombstones — the prune decision keys on the oldest *domain* event, because after a prune the oldest surviving row is the boundary snapshot, whose age says nothing about whether another prune would be productive. When the terminate predicate matches, the full close wins (precedence unchanged). Otherwise, if the tail has aged out of the window (`tail.created < now − keep`), the handler stages a `CloseSignal` with `before = now − keep` — a windowed close through the same `on_close` path. And when neither fires, the defer due-time is the earliest of the two derivable instants: `head.created + after` (the terminate cooldown opening) and `tail.created + keep` (the moment the oldest surviving domain event ages out). The off-hours `autocloseWindow` gate applies before any of this, unchanged.

### Defer, not poll

When the policy hasn't matched yet but has a time component (`after`), the handler throws `DeferSignal(head.created + the minimum `after` window in days)` — the earliest instant the time gate could open. That becomes a `HandleResult.defer`: the drain does **not** advance the watermark and does **not** bump `retry`, persists the due-time via `Store.defer`, and `claim` skips the synthetic stream until the due-time passes. The persisted `deferred_at` is the correctness mechanism — it holds across every competing worker. A per-worker `DeferTimer` is layered on top purely as an optimization, waking the local worker promptly at the due-time instead of on the next ordinary cycle; it clamps long horizons to `setTimeout`'s ~24.8-day ceiling and re-arms, since the persisted column is what actually gates the re-claim. Policies with no time gate (`is` / `reaches` only) don't park on a due-time at all — they ack and wait for the next event on the aggregate to re-trigger.

**The schedule is persisted atomically with the cycle's acks.** Drain finalization is a single `Store.ack` call: leases that processed successfully ack (watermark advances), and leases that deferred ride the same batch marked with `due` — the adapter applies both in one transaction. A cycle's outcomes therefore can never land partially: if the finalize fails, *nothing* landed — close requests were not acked (so they redeliver), no watermark moved, no schedule was written — and the ordinary failure path takes over: the error feeds the circuit breaker (surfacing on the `error` lifecycle event), the controller stays armed, and the breaker's paced retry probe re-drives `settle()` even on the default lane. On the retried cycle everything redelivers: the close lands, the handler re-throws its `DeferSignal` (the due-time is derivable from the triggering event, so it resolves to the same instant), and the schedule persists. The failure mode is one early redelivery, never a stalled recurrence or a lost close. The same reasoning covers a worker that crashes mid-finalize: nothing landed, so the first drain after restart (controllers arm at construction) redelivers and finalizes again.

When the policy *does* match, the handler throws `CloseSignal({ stream, archive, at: head.id })`. `build_handle` turns it into a `HandleResult.close`, the drain acks the synthetic reaction to the live head id (`at`) so the close-cycle safety probe — which matches subscriptions by `source = aggregate` — sees autoclose caught up instead of blocking its own close, and `DrainController.on_close` hands the target to the orchestrator's `run_close_cycle`. From there the explicit-close phases run unchanged: safety partition, tombstone guard, archive-while-guarded, atomic truncate, then `emit("closed", result)`.

The crucial composition is the same as before: **online close doesn't reinvent any phase.** It reaches the candidate a different way (a reaction firing on commit, deferring across the cooldown) but closes through the identical `run_close_cycle` machinery `app.close` uses.

### Config knobs

`.autocloses` still reads a handful of `ActOptions`, validated at `act().build()` (a `ZodError` at build, never on the first cycle):

- `autocloseWindow` — optional off-hours gate, `{ start, end, timeZone? }`. When the current hour is outside `[start, end)` the handler defers to the exact instant the window next opens (`next_window_open`, DST-correct via `Intl`) — derived from the window itself, no polling cadence. This closed a real latency gap: the old poll (`autocloseCycleMinutes`, default 12 h) could oscillate around a short window and keep missing it. Hours are `[0, 23]` integers in `timeZone` (IANA, default UTC); `start > end` is an overnight window. Omit to evaluate on every commit. On a DST spring-forward day whose `start` hour is skipped (e.g. `start: 2` in `America/New_York` on the March transition, where 02:00 local never occurs), the window still opens at the gap's replacement instant — both `in_autoclose_window` and `next_window_open` admit it, so autoclose defers ~1 h to that instant rather than being disabled for the whole ~24 h day.
- `autocloseCycleMinutes` / `closeBatchSize` / `closeYieldMs` / `closeOnError` — **deprecated since #1175** (decision record: `rfcs/1175-close-cadence-days.md`). Accepted and range-validated so existing configs keep building and typos keep failing loudly, but nothing consumes them — the last three had been dead since #1090 removed the sweep. Removal rides the next major.

### Latency

A stream closes shortly after it qualifies, not on a fixed sweep boundary: the reaction fires on the aggregate's own commits, and for `after`-style cooldowns the persisted defer wakes the worker at the exact cooldown instant (modulo the off-hours window, which parks the re-check until the window opens). Eligibility still means "old" — terminal-plus-grace or past a retention age — so the close lands when the cooldown elapses rather than "right this second."

### What's NOT online-close

- **Restarting** streams. An online terminate always tombstones — `restart: true` is an explicit-close-only feature. Hosts that want "rotate this stream every 24h" run an explicit `app.close({ stream, restart: true })` from their own scheduler. (A `keep` prune is not a rotation either: it deletes a prefix behind an existing snapshot, never seeds anything.)
- **Cross-state coordination**. Each state's policy sees only its own aggregate's head. There's no "close stream A only if stream B is closed" primitive — the host runs that policy explicitly if they need it.
- **Arbitrary conditions**. The declarative policy derives a due-time and a terminal set; conditions it can't express (per-stream metadata, a saga waiting on the *absence* of an event) belong in your own logic or scheduler calling `app.close`.

### Pointers

- `libs/act/src/act.ts` — autoclose-reaction synthesis (`__autoclose__:` synthetic stream, off-hours gate, defer-to-cooldown, `CloseSignal`) and the `DrainController.on_close` → `run_close_cycle` wiring
- `libs/act/src/internal/defer-signal.ts` / `close-signal.ts` — the control-flow signals a reaction throws to defer or close
- `libs/act/src/internal/defer-timer.ts` — the per-worker wake optimization over `stream → due-time` (clamped to `setTimeout`'s ceiling)
- `libs/act/src/internal/autoclose-policy.ts` — `AutoclosePolicy` schema, `compile_autoclose_policy`, `policy_min_after_days`, `policy_keep_days`
- `libs/act/src/internal/config.ts` — the `autocloseWindow` schema + resolver (the single home for builder-facing config bags); `libs/act/src/internal/autoclose-window.ts` — `in_autoclose_window` / `next_window_open`
- `libs/act/src/builders/state-builder.ts` — `.autocloses` / `.archives` declarators
- `libs/act/test/autoclose-reaction.spec.ts` — synthesized-reaction behavior (immediate close, live-head reopen, cooldown park, threshold, off-hours defer, rolling-window prune/defer)
- `libs/act/test/autoclose-policy.spec.ts` / `autoclose-builder.spec.ts` — policy compilation + declarator validation
- `libs/act/test/defer-outcome.spec.ts` / `defer-timer.spec.ts` — the `defer` outcome and the wake timer
- `libs/act-pg/test/autoclose.spec.ts` / `libs/act-sqlite/test/autoclose.spec.ts` — adapter integration
- [Online close-the-books policies](../guides/close-policies.md) — operator-facing guide for writing policies

## Pointers

- `libs/act/src/internal/close-cycle.ts` — phase-by-phase orchestration, `run_close_cycle`, and the windowed branch `run_windowed_closes`
- `libs/act/src/act.ts` — `Act.close()` — wires correlate + cycle + emit
- `libs/act/src/types/errors.ts` — `StreamClosedError` thrown by `action()` on tombstoned streams
- `libs/act/test/close.spec.ts` — happy-path and failure-mode coverage
- `libs/act/test/close-windowed.spec.ts` — windowed-branch coverage (prune + live stream, lagging-consumer cap, no-snapshot skip, cache untouched, mixed targets)
- `libs/act/test/property/close.property.spec.ts` — close idempotency under random workloads
