---
id: cache-and-snapshots
title: Cache and snapshots
---

# Cache and snapshots

Two distinct checkpoint mechanisms at different layers. Both exist to keep `load()` fast on long streams; they fail in different ways and recover from each other.

## The two checkpoints

| | **Cache** | **Snapshot** |
|---|---|---|
| **Where it lives** | In-memory port (`InMemoryCache` LRU by default; pluggable to Redis) | A `__snapshot__` event committed to the store |
| **Lifetime** | Process lifetime; lost on restart, eviction | Persists in the event log forever |
| **Created by** | `action()` after each commit; `load()` after each non-empty replay | `me.snap?.(snapshot)` callback after a commit |
| **Read by** | Every `load()` (cache-first) | `load()` on cold start or cache miss |
| **Granularity** | Latest checkpoint per stream | Multiple checkpoints per stream, anchored to specific event IDs |
| **Invalidated by** | `ConcurrencyError`, manual `cache().invalidate()` | Never — events are immutable |

## Why two layers

A long stream needs to be replayed *somewhere*. The cheapest place is RAM (cache), but RAM is volatile. The next-cheapest is disk-via-DB (snapshot), but reading even one snapshot still costs a round trip. The framework uses both: cache catches the warm case for zero round-trips; snapshots catch the cold-start case to bound replay cost.

## Read path — `load()`

```
                  load(state, stream, asOf?)
                                │
              ┌─────────────────┴─────────────────┐
              │                                   │
          asOf set?                        cache.get(stream)
        (time-travel)                             │
              │                       ┌───────────┴───────────┐
              │                       │                       │
              │                      hit                     miss
              ▼                       ▼                       ▼
          skip cache              cached.state            init state
        with_snaps:true          cached.event_id         with_snaps:true
        scan from asOf           query after             scan from start
              │                  cached.event_id         (snap if any)
              │                       │                       │
              └───────────────────────┼───────────────────────┘
                                      ▼
                                replay events
                                      │
                                      ▼
                        (write cache if replayed > 0
                         and not time-travel)
```

Three distinct entry conditions, three different store-query shapes:

- **Cache hit**: query `after: cached.event_id` (no `with_snaps`). Skip everything older — the cached state is correct as-of the cached event ID.
- **Cache miss**: query from start with `with_snaps: true`. The query stream will surface any `__snapshot__` events; the reducer absorbs the snapshot's state and resets `patches` to 0.
- **Time-travel** (`asOf` set): bypass cache entirely, query from start with snapshots, plus the `asOf` filter (`before`, `created_before`, `created_after`, `limit`). Time-travel reads must reflect history, not current cached state.

After the loop, if any events were processed (`replayed > 0`) and we're not in time-travel mode, the cache is updated to the new checkpoint. This is what makes read-heavy paths warm — without it, repeated `load()`s on the same stream would all be misses.

### Why no race protection on the cache write

Two `load()`s on the same stream can race. If both write to cache, a slower load could overwrite a fresher entry with a stale checkpoint. Doesn't matter:

```
1. Cache has v=10 (from some earlier action)
2. Slow load A starts; reads cache; queries past v=10 — finds nothing new
3. Concurrent commit happens; action writes cache.set(v=11)
4. Slow load A finishes (its view is v=10); writes cache.set(v=10)
5. Cache now has v=10 (stale by one event)
6. Next load B reads cache (v=10); queries after v=10 — finds the v=11 event
7. Replays it; writes cache.set(v=11)
8. Cache is correct.
```

Step 7 is the key: every load that processes events past the cached point updates the cache. Stale entries are self-correcting on the next access. No version-comparison needed at write time.

## Snapshot creation

Snapshots are created by user code via the `me.snap?` predicate at the end of every `action()`:

```ts no-check
const last = snapshots.at(-1)!;
const snapped = me.snap && me.snap(last);
// ... cache.set with patches: snapped ? 0 : last.patches
if (snapped) void snap(last);  // commits a __snapshot__ event, fire-and-forget
```

The user-supplied predicate decides *when* to snap. Common patterns:

- **By patch count**: `.snap((s) => s.patches >= 50)` — every 50 events since last snap.
- **By time elapsed**: keep timestamp on state, snap when `Date.now() - state.lastSnapAt > 60_000`.
- **Never**: omit `.snap()`. Streams with bounded length (single-day TTL, capped by app logic) often don't need snapshots.

The actual write is fire-and-forget — `void snap(last)` doesn't block the action's return. Snapshot failures log via `snap()`'s internal try/catch but don't propagate — a **warn**-level line carries the stream, the failure reason, and the operational consequence (cold starts replay full history until snapshots succeed), so a persistently failing snapshot write is visible to operators instead of silently degrading every cold start. The cache is the immediate source of truth; the snapshot is durability for cold start.

## How the two interact on cold start

A fresh process loading a long stream:

```
1. cache.get(stream) → undefined (process restart, cache empty)
2. query store from start with with_snaps:true, returning:
     v=0  (Created)
     v=10 (__snapshot__, data = state at v=10)
     v=11 (Updated)
     ...
     v=42 (Updated)
3. As each event arrives in the reducer:
     v=0:  apply Created reducer; patches=1
     v=10: SNAP_EVENT detected; state = e.data; snaps++; patches=0
     v=11: apply Updated reducer; patches=1
     ...
     v=42: apply Updated reducer; patches=32
4. Return snapshot { state, version: 42, patches: 32, snaps: 1 }
5. Cache updated to v=42 with patches=32, snaps=1
6. Subsequent load() on this stream: cache hit, query after v=42, no replay
```

The snapshot at v=10 means we replayed 32 events instead of 42 (the snapshot data replaces the first 11 events worth of reducer work). Snap policy `>= 50` would have kept all 43 events as a single replay — fine for a 43-event stream, painful for a 5,000-event stream.

## Time-travel reads

`load()` accepts an optional `AsOf` parameter:

```ts no-check
type AsOf = Pick<Query, "before" | "created_before" | "created_after" | "limit">;
```

When any field is set, the framework treats this as a historical read:

- Cache is bypassed (cached state may include events past the cutoff)
- Cache write at the end is skipped (don't pollute with a historical view)
- Query uses `with_snaps: true` so any snapshot before the cutoff serves as a replay anchor
- Snapshots *after* the cutoff are filtered out by the same `before` / `created_before` predicate

The time-travel path is read-only by design — the framework's mutation API (`action()`) always operates on current state and never accepts `asOf`.

## Observability — what the trace tells you

The `load` trace breadcrumb surfaces what just happened:

```
load: orders-1 hit v=42 replayed=0 snaps=1 patches=32
load: orders-1 (as-of before=5000) miss v=4 replayed=11 snaps=0 patches=11
```

- `hit/miss` — cache lookup outcome
- `v=` — stream head version after this load
- `replayed=` — events processed past the cache point. Zero after a warm cache hit; high on cold start
- `snaps=` — total snapshots taken on this stream (cumulative across all loads)
- `patches=` — events since last snap (snap-policy accumulator)

A `cache: hit` with `patches=8` is *not* a contradiction. The cache had a checkpoint past 8 events of patches-since-snap. The cache hit means we didn't replay; the patches counter is what `snap()` policies key on for "should I take a snap soon."

## Cache invalidation — narrow contract

The cache is invalidated in only two places:

1. **`ConcurrencyError`** in `action.commit`: the commit failed because the stream advanced past `expectedVersion`. The cached state could be stale.
2. **`cache().invalidate(stream)`**: explicit caller request. Used by `app.close()` to drop tombstoned streams.

Anything else — handler errors, validation errors, schema failures — leaves the cache untouched. The cache reflects committed state; if no commit happened, no invalidation needed.

## Snapshot evolution — events first, snapshots second

The cache carries an integrity contract: an entry's `state` always equals the fold of events at or below its `event_id`. Commits that land past the frontier an action loaded (reaction-driven appends skip the optimistic guard by design) invalidate the entry instead of writing a gapped fold, and the next load replays to truth. The same contiguity check gates snapshot persistence — a `__snapshot__` event is never written from a fold that missed interleaved events.

A subtle gotcha: when a state's reducer changes (new field, renamed field), older snapshots in the store contain old-shape state. The framework doesn't migrate snapshots.

The supported pattern:

1. Add the new field with a default in the reducer's output
2. New events get the field; existing events still produce the old shape
3. New snapshots reflect the new shape
4. Old snapshots produce old-shape state on cold start; the next reducer call adds the new field

This works because reducers are pure functions of state + event. As long as reducers handle missing fields gracefully (or `cache_hit` semantics align), schema evolution is safe. See [Event schema evolution](./event-schema-evolution) for the full story on schema versioning.

For a destructive reducer change (renamed field that you can't add as a new optional), the right move is to retire the stream via `app.close({ restart: true })` — that loads current state, commits a fresh `__snapshot__` reflecting the new shape, and tombstones older history.

## Pointers

- `libs/act/src/internal/event-sourcing.ts` — `load()`, `action()`, `snap()` — the only callers of `cache()` in the framework
- `libs/act/src/adapters/in-memory-cache.ts` — default `Cache` implementation (LRU)
- `libs/act/src/types/index.ts` — `Cache` interface, `CacheEntry` shape
- `libs/act/test/property/cache-coherence.property.spec.ts` — invariants the implementation must hold
