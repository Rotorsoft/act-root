---
id: close-cycle
title: Close cycle
---

# Close cycle

`app.close(targets)` archives, tombstones, and truncates streams from the operational store. The event-sourcing equivalent of "closing the books" in accounting: summarize the period, archive the detail, optionally restart with a fresh opening balance.

`Act.close()` first runs `correlate({ limit: 1000 })` so the safety probe in Phase 2 sees dynamic reaction targets, then hands off to `runCloseCycle` which executes six gating phases (1 through 6 below). Phase 0 is the preparatory correlate. Failures at each phase have well-defined recovery characteristics — the goal is that any partial-failure state is *safe* (no data loss, no inconsistent state, retryable).

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

```ts
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

## Online close-the-books

`Act.close(targets)` is the **explicit** close path — the operator hands the framework a list of stream names, the cycle runs once, the streams get truncated. Online close is the **declarative** version of the same primitive: each state's builder declares a predicate, the framework polls candidates on a background ticker, and eligible streams pass through the same `run_close_cycle` pipeline above.

### Surface

Two state-builder declarators:

- `.autocloses(predicate)` — `(stream, head: Committed<TEvents,...>, count) => boolean`. The cycle calls this once per candidate stream; truthy results queue for truncate.
- `.archives(fn)` — `(stream, head) => Promise<void>`. Optional companion. Runs while the stream is guarded but **before** truncate so the host can persist events to durable storage (S3, cold tier) before the tombstone lands.

Both are state-level (one per state, last-write-wins, mirror of `.snap` / `.discloses`). Absent → the state opts out of online close entirely (zero per-tick cost).

Autoclose is low-urgency housekeeping, so each run sweeps the whole store and the cadence is how often that repeats — a couple of times a day, not a hot path. Five `ActOptions` knobs, validated at `act().build()`:

- `autocloseCycleMinutes` — how often a sweep runs, in minutes. Default 720 (12 h), range `[1, 1440]` (1 minute to 24 hours).
- `closeBatchSize` — the per-batch page size within a run. A run pages through the whole store this many streams at a time, bounding memory and the per-batch write burst. Default 64, range `[1, 1024]`.
- `closeYieldMs` — delay between batches. Default 0, range `[0, 1000]`. SQLite operators raise this to release the writer lock.
- `closeOnError` — whether a thrown predicate counts as "close this stream". Default false (skip the stream, log the error).
- `autocloseWindow` — optional off-hours gate, `{ start, end, timeZone? }`. A tick only sweeps when the current hour is inside `[start, end)`; hours are `[0, 23]` integers in `timeZone` (IANA, default UTC, DST-correct), and `start > end` is an overnight window. Omit to sweep on every tick.

### A run

```
┌─────────────────────────────────────────────────────────┐
│  AutocloseController.run_once                           │
│  ─ guard against overlapping runs                       │
│  ─ skip if the off-hours window excludes the current hr  │
│  ─ compute close_correlation(correlator, $autoclose)    │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│  run_autoclose_cycle — page through the whole store      │
│  loop until a short page ends the sweep:                 │
│    Store.query_stats({}, { count: true,                 │
│      exclude: [TOMBSTONE_EVENT],                        │
│      after: cursor, limit: closeBatchSize })            │
│    for each stream on the page:                          │
│      owner = event_to_state.get(head.name)              │
│      predicate = registry.autoclose_policy(owner.name)  │
│      if predicate(stream, head, count) → candidate      │
│      (state.archive threaded as CloseTarget.archive)    │
│    flush this page's candidates as ONE batch via        │
│      run_close_cycle (phases 0-6 above) → ONE probe     │
│    yield closeYieldMs; advance cursor to the last stream │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│  Controller: if truncated.size > 0 →                    │
│    emit("closed", close_result)                         │
└─────────────────────────────────────────────────────────┘
```

The crucial composition: **online close doesn't reinvent any phase**. It builds a candidate list and hands it to `run_close_cycle`. Safety-partition, tombstone-guard, archive-while-guarded, atomic truncate — all the invariants on this page apply to the autoclose path unchanged.

Closed streams are tombstoned and excluded from `query_stats`, and they sort behind the cursor, so the forward scan never revisits them. Each page is one batch is one safety probe; the `closeBatchSize` paging keeps a run from materializing every candidate or truncating thousands at once, even though a single run covers the whole store.

### Sweep latency

A stream isn't closed the instant it qualifies — it closes on the next run, up to one `autocloseCycleMinutes` away (and only during the off-hours window, if one is set). This fits autoclose semantics: eligibility always means "old" (past a retention age, or terminal-plus-grace), never "right this second." Tighten the window by shortening `autocloseCycleMinutes`.

### Lifecycle

- Construction-time: the orchestrator builds the controller only when at least one state declares `.autocloses(...)`. Otherwise `_autoclose` stays `undefined` and the orchestrator pays zero per-tick cost.
- `start_correlations()` starts the ticker; `stop_correlations()` (and therefore `shutdown()` / `dispose()`) stops it.
- The ticker `unref()`s its Timeout so a forgotten autoclose worker doesn't keep the process alive after the rest of the app shuts down.

### What's NOT online-close

- **Restarting** streams. Online close always tombstones — `restart: true` is an explicit-close-only feature. Hosts that want "rotate this stream every 24h" run an explicit `app.close({ stream, restart: true })` from their own scheduler.
- **Cross-state coordination**. Each state's predicate sees only its own candidates. There's no "close stream A only if stream B is closed" primitive — the host runs that policy explicitly if they need it.
- **Per-tick partial commits**. The cycle either succeeds or fails per batch; a thrown predicate inside a batch logs and skips the stream (or closes it, under `closeOnError: true`). The batch itself never half-truncates.

### Pointers

- `libs/act/src/internal/autoclose-cycle.ts` — `run_autoclose_cycle` + `AutocloseController`
- `libs/act/src/builders/state-builder.ts` — `.autocloses` / `.archives` declarators
- `libs/act/test/autoclose-builder.spec.ts` — declarator + registry + validation
- `libs/act/test/autoclose-cycle.spec.ts` — cycle behavior against `InMemoryStore`
- `libs/act/test/autoclose-controller.spec.ts` — controller lifecycle + reentrancy + ticker error handling
- `libs/act-pg/test/autoclose.spec.ts` / `libs/act-sqlite/test/autoclose.spec.ts` — adapter integration
- [Online close-the-books policies](../guides/close-policies.md) — operator-facing guide for picking and writing predicates

## Pointers

- `libs/act/src/internal/close-cycle.ts` — phase-by-phase orchestration, `runCloseCycle`
- `libs/act/src/act.ts` — `Act.close()` — wires correlate + cycle + emit
- `libs/act/src/types/errors.ts` — `StreamClosedError` thrown by `action()` on tombstoned streams
- `libs/act/test/close.spec.ts` — happy-path and failure-mode coverage
- `libs/act/test/property/close.property.spec.ts` — close idempotency under random workloads
