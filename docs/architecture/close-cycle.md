# Close cycle

`app.close(targets)` archives, tombstones, and truncates streams from the operational store. The event-sourcing equivalent of "closing the books" in accounting: summarize the period, archive the detail, optionally restart with a fresh opening balance.

The operation has six phases, each gating the next. Failures at each phase have well-defined recovery characteristics — the goal is that any partial-failure state is *safe* (no data loss, no inconsistent state, retryable).

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
          │ Phase 1: Scan stream heads│  For each target, find the latest non-tombstone event.
          │   query backward, limit:1 │  Streams with no events are skipped here.
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

For each target, query the store backward, filter out tombstones in the callback, take the first non-tombstone event. This gives us `(maxId, version, lastEventName)` per stream.

The `with_snaps` flag is *not* set, so snapshot events are filtered server-side. The query returns the latest *domain* event.

- **Stream has no domain events**: not included in the result map. Phase 2's `safe` list will exclude it. Result: stream untouched.
- **Stream has only a tombstone**: same outcome as no domain events — the tombstone is filtered, no result entry, skipped.
- **Query fails**: close() throws to caller. Streams are untouched.

### Phase 2 — Partition by safety

For apps with reactions, we can't tombstone a stream that still has pending reactions in flight — those reactions would never run after the truncate.

Optimization: when `reactiveEvents.size === 0`, skip the safety probe entirely (every stream is safe). Most close operations on apps without reactions take this path.

Otherwise, walk `query_streams` (read-only — no leasing, no state mutation). For each subscribed reader's position, mark any of our targets that still have unprocessed events behind that reader.

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

1. Phase 1 scans backward; the head is `__tombstone__` (because it's filtered, the scan returns no result for this stream)
2. Phase 1's result map doesn't include this stream
3. Phase 2's `safe` list doesn't include this stream
4. Result: stream isn't in `truncated`, isn't in `skipped` from a concurrency error — it's just absent

For a stream that's been *restarted* but not tombstoned (one `__snapshot__` event at v=0), close() will find that snapshot in Phase 1 (snapshots aren't filtered like tombstones are), proceed through guard, and tombstone it. The result is a truncate-and-tombstone of the restarted stream.

## Pointers

- `libs/act/src/internal/close-cycle.ts` — phase-by-phase orchestration, `runCloseCycle`
- `libs/act/src/act.ts` — `Act.close()` — wires correlate + cycle + emit
- `libs/act/src/types/errors.ts` — `StreamClosedError` thrown by `action()` on tombstoned streams
- `libs/act/test/close.spec.ts` — happy-path and failure-mode coverage
- `libs/act/test/property/close.property.spec.ts` — close idempotency under random workloads
