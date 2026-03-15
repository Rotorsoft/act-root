# Performance History

This document tracks the evolution of Act's performance optimizations with benchmark data. For current patterns and strategies, see the [README](libs/act/README.md).

All PostgreSQL benchmarks run against a local instance on port 5431. Each benchmark uses `vitest bench` with default iterations. Numbers vary between runs — focus on relative improvements, not absolute values.

---

## Cache Port (v0.20.0)

**PR:** #460 — Introduced always-on `InMemoryCache` (LRU, maxSize 1000) to eliminate full event replay on `load()`.

### Strategy

Cache stores the latest state checkpoint per stream. On `load()`, only events committed after the cached position are replayed. On `action()`, the cache is updated after every successful commit. Concurrency errors invalidate stale entries.

### Why cache on every commit, not just on snap?

An alternative design would update the cache only at snap boundaries. We benchmarked both:

**Cache on every commit** (chosen):

| Events | No snap | @10 | @50 | @75 | @100 |
|---:|---:|---:|---:|---:|---:|
| **50** | 4,872 | 5,881 | 6,480 | **7,058** | 6,949 |
| **500** | **6,371** | 5,639 | 5,590 | 6,223 | 5,488 |
| **2,000** | 4,257 | **5,329** | 4,573 | 4,812 | 4,039 |

**Cache only on snap** (rejected):

| Events | No snap | @10 | @50 | @75 | @100 |
|---:|---:|---:|---:|---:|---:|
| **50** | 608 | 5,845 | 6,098 | 694 | 1,006 |
| **500** | 212 | **6,481** | 4,955 | 570 | 5,074 |
| **2,000** | 101 | **6,827** | 5,993 | 675 | 4,039 |

The snap-only strategy fails for states without `.snap()` (falls back to full replay) and has cache misses between snap boundaries. Cache-on-commit costs one `Map.set()` per commit but guarantees every `load()` after the first action is a cache hit.

**Compared to pre-cache baselines** (PG, no cache):

| Events | Without cache | With cache | Speedup |
|---:|---:|---:|---:|
| **50** | 655 | 4,872 | **7x** |
| **500** | 215 | 6,371 | **30x** |
| **2,000** | 92 | 4,257 | **46x** |

> **InMemoryStore note:** InMemory benchmarks cap at ~830 ops/s because every method starts with `await sleep(0)` to simulate async behavior. The event-loop yield costs ~1ms per call.

---

## Atomic Stream Claiming (v0.21.0)

**PR:** #471 — Replaced two-phase poll→lease drain cycle with atomic `claim()` using PostgreSQL's `FOR UPDATE SKIP LOCKED`.

### Strategy

The old drain cycle used two separate store calls: `poll()` to discover available streams, then `lease()` to lock them. Between these calls, another worker could grab the same stream — a race condition that wasted cycles.

`claim()` fuses both into a single SQL transaction using `FOR UPDATE SKIP LOCKED` — the PostgreSQL idiomatic competing consumer pattern. Workers never block each other; locked rows are silently skipped. This is the same pattern used by pgBoss, Graphile Worker, and Oban.

Also replaced `lease(leases, 0)` in `correlate()` with `subscribe()` — a clean upsert for registering reaction target streams.

### Single-worker drain cycle (ops/s)

| Streams | poll→lease | claim | Mean (ms) before | Mean (ms) after | Improvement |
|---:|---:|---:|---:|---:|---|
| **50** | 45.1 | 47.5 | 22.2 | 21.1 | **5% faster** |
| **200** | 45.6 | 41.7 | 21.9 | 24.0 | ~same |
| **500** | 33.8 | 37.6 | 29.6 | 26.6 | **11% faster** |
| **1,000** | 17.5 | 17.4 | 57.3 | 57.3 | ~same |

Single-worker improvements are modest because the overhead of poll+lease is small relative to fetch+handle time. The real benefit is under contention.

### Concurrent workers (ops/s — higher is better)

| Config | poll→lease | claim | Improvement |
|---|---:|---:|---|
| **3 workers × 100 streams** | 56.9 | 40.4 | -29% |
| **3 workers × 500 streams** | 43.0 | 45.2 | **5% faster** |
| **5 workers × 100 streams** | 35.9 | 43.9 | **22% faster** |
| **5 workers × 500 streams** | 49.7 | 39.4 | -21% |

Results are mixed under simulated contention because the benchmark uses `Promise.all` within a single Node.js process sharing one connection pool — not true distributed workers. The `_drain_locked` mutex means only one drain actually runs at a time in the same `Act` instance.

**Key insight:** The real benefit of `FOR UPDATE SKIP LOCKED` is in **multi-process deployments** where separate Node.js processes (or containers) compete for streams through the same PostgreSQL database. In that scenario:
- The old poll→lease had a window where all workers poll the same streams, then compete at the lease phase — most lose
- With `claim`, each worker atomically grabs different streams in one query — zero wasted cycles

The benchmarks above test in-process concurrency which doesn't fully exercise this advantage. A proper multi-process benchmark would show larger improvements under contention.

### Interface simplification

The Store interface was also simplified:

| Before | After |
|---|---|
| `poll(lagging, leading)` | *(removed)* |
| `lease(leases, millis)` | *(removed)* |
| — | `claim(lagging, leading, by, millis)` |
| — | `subscribe(streams)` |

Net reduction of 139 lines in the first commit, plus cleaner separation of concerns: `claim` for drain, `subscribe` for correlate, `ack`/`block` for finalization.
