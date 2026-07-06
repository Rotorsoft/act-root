# The envelope, measured

The scaling recipes describe an envelope of safe operation; this page is the envelope with numbers on it. Every figure below was produced by the reproducible scenarios in [`performance/act-performance/evidence/`](../performance/act-performance/evidence/) against `act-pg` on real Postgres — per the repo's benchmarking rule, InMemory numbers never appear here.

Reproduce on your own hardware:

```bash
docker compose up -d           # repo root — Postgres 17 on :5431
bash performance/act-performance/evidence/run.sh           # 1M tier
TIER=10M bash performance/act-performance/evidence/run.sh  # 10M tier
```

## Reference hardware

| | |
|---|---|
| Machine | Apple M3 Pro, 36 GB |
| Postgres | 17.5 (aarch64, dockerized, repo defaults — no tuning) |
| Store | `@rotorsoft/act-pg` 1.11, single process |
| Date | 2026-07 |

Numbers are indicative, not promises: a tuned server-class Postgres with fast NVMe will beat a dockerized laptop database; a busy shared instance will not. That is why `run.sh` exists.

## Scenario A — sustained commit throughput

Through the real path: `app.do` → validate → load → emit → commit with the optimistic-concurrency guard. 20,000 commits each shape.

| Shape | Throughput | Why |
|---|---|---|
| One hot aggregate, sequential | **~800 events/s** | The serialized floor: every commit loads state and extends the same version chain. This is a per-stream ceiling, not a system ceiling. |
| 1,000 streams, 32 in flight | **~5,200 events/s** | The shape horizontal scale takes. One process, one connection pool — more workers add more of this (see [split-stores](scaling/split-stores/README.md) when one store saturates). |

The 6.5× spread is the concurrency model working as designed: streams are the unit of serialization, so throughput scales with *stream* parallelism, not process parallelism. If your system funnels all writes through one aggregate, that aggregate is your ceiling — restructure the boundaries before reaching for infrastructure ([concurrency model](../docs/docs/architecture/concurrency-model.md)).

## Scenario B — cold start and rebuild

Store seeded to size with one giant aggregate (`hot-1`) plus 5k-event tenant streams.

| Measurement | 1M-event store (100k-event aggregate) | 10M-event store (1M-event aggregate) |
|---|---|---|
| Cold-start load, no snapshot | **0.56 s** | **7.1 s** |
| Cold-start load, with snapshot | **1 ms** (557×) | **7 ms (988×)** |
| Projection rebuild (batched fold, full store) | **3.3 s** (~300k events/s) | **33.5 s (~300k events/s)** |

The cliffs, and the recipe for each:

- **Cold start grows linearly with aggregate length.** ~0.5 s per 100k events replayed on this hardware. The in-process cache hides this after the first load, but every fresh process pays it once per hot stream. At 100k+ events per aggregate, turn on snapshots — the load drops to milliseconds because replay resumes from the latest `__snapshot__` event ([cache-and-snapshots](../docs/docs/architecture/cache-and-snapshots.md)).
- **A stream that grows without bound will eventually not fit the snapshot cadence.** That is the close-the-books signal, not a snapshot-tuning signal ([close-the-books](scaling/close-the-books/README.md)).
- **Projection rebuild is a batched fold, and ~300k events/s means a 10M-event store rebuilds in well under a minute** — rebuild-from-zero is a routine operation at this scale, not an outage. Budget rebuild time when your store approaches 100M+, or archive the cold tier first ([archival](scaling/archival/README.md)).
- **Seeding is not the framework's job.** The fixture seeder writes at Postgres speed (1M rows in ~7 s, 10M in ~70 s, via `generate_series`) precisely because pushing bulk history through `app.do` would take hours — bulk imports belong in SQL, framework commits are for live traffic.

## What is deliberately not here

- **Drain latency under competing workers** — deferred until someone needs it; the [stress harness](../.github/workflows/stress.yml) already proves correctness under contention weekly.
- **The 50M tier** — the audience today is small/medium systems; the linear trends above extrapolate, and `run.sh` accepts your own numbers when you need certainty.
- **Micro-benchmarks** — per-optimization before/after history lives in `libs/act/PERFORMANCE.md` and `libs/act-pg/PERFORMANCE.md`.
