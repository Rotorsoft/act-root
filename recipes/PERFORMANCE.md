# The envelope, measured

The scaling recipes describe an envelope of safe operation; this page is the envelope with numbers on it. Every figure is from `act-pg` against real Postgres — per the repo's benchmarking rule, InMemory numbers never appear here.

Reproduce on your own hardware:

```bash
docker compose up -d           # repo root — Postgres 17 on :5431
pnpm build

# Scenarios A and B — commits, cold start, rebuild
bash performance/act-performance/evidence/run.sh           # 1M tier
TIER=10M bash performance/act-performance/evidence/run.sh  # 10M tier

# Scenario C — reactions
LOG_LEVEL=error node libs/act-pg/scripts/correlate-workers.bench.mjs
LOG_LEVEL=error node libs/act-pg/scripts/hybrid-split.bench.mjs
```

## Reference hardware

| | |
|---|---|
| Machine | Apple M3 Pro, 36 GB |
| Postgres | 17.5 (aarch64, dockerized, repo defaults — no tuning) |
| Store | `@rotorsoft/act-pg` 1.11 |
| Date | Scenarios A and B, 2026-07; Scenario C, 2026-08 |

Scenarios A and B run in a single process. Scenario C runs workers as separate OS processes with cross-process wakeups enabled, because correlation only happens in a worker that has been woken — several Acts inside one process with wakeups off leaves all but one of them idle, which understates the cost of the thing being measured.

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

## Scenario C — reactions

The question this page could not answer until now: how much *reaction* traffic does the framework carry, and what happens when you add workers?

Reactions move in two stages. **Discovery** reads the event log forward and marks every subscription an event resolves to. **Delivery** claims a marked subscription, fetches its events, runs the handler, and acknowledges. They scale differently and fail differently, so they are measured separately.

### Delivery keeps up

End to end through a real app — commit, discover, claim, fetch, handle, ack — with workers as separate OS processes and cross-process wakeups on ([`libs/act-pg/scripts/correlate-workers.bench.mjs`](../libs/act-pg/scripts/correlate-workers.bench.mjs)), 2,000 aggregates, 20 s:

| workers | events committed | events handled | backlog |
|---|---|---|---|
| 1 | 10,634 | **10,634** | none |
| 2 | 10,050 | **10,050** | none |
| 4 | 8,880 | **8,880** | none |

**Handled matches committed exactly at every worker count.** The limit here is the writer — a single process committing sequentially, around 500 events/s — not the reaction pipeline, which never fell behind. Adding workers does not raise this number because there was no backlog for them to work on; it lowers it slightly, since more workers contend for the same rows to do the same amount of work.

The honest reading: **if your commit rate is in the hundreds per second, reactions are not your constraint.** For the shape where they might be, see the next table.

### Claiming work scales, and stays flat as subscriptions grow

The delivery half on its own, driven as hard as the claim/ack loop allows ([`hybrid-split.bench.mjs`](../libs/act-pg/scripts/hybrid-split.bench.mjs)), 20,000 subscriptions:

| workers | claim p50 | subscriptions leased/s |
|---|---|---|
| 1 | 2.09 ms | 2,577 |
| 4 | 2.47 ms | **5,107** |
| 8 | 3.03 ms | 5,091 |
| 16 | 4.31 ms | 3,716 |

Throughput roughly doubles from one worker to four and then flattens; past eight, latency climbs while throughput falls, which is competing consumers contending for the same rows. **Four to eight workers per store is the useful range** on this hardware.

Separately, claim latency is **flat in the number of subscriptions** — about 1.5 ms whether the store holds a thousand or a hundred thousand, because `claim` reads eligibility off the subscription row rather than probing the event log ([#1488](https://github.com/Rotorsoft/act-root/issues/1488)). Before that change it was 180 ms at 100k.

### Discovery is now a constant, not a multiple

Every worker used to read the whole log for itself. Measured on real processes, that was exactly N reads and N mark-writes per committed event for N workers — the cost of *finding* work grew linearly with the workers doing it. Since [#1532](https://github.com/Rotorsoft/act-root/issues/1532) one worker reads on behalf of the rest:

| workers | log reads per event | mark writes per event |
|---|---|---|
| 1 | 1.00 | 1.00 |
| 2 | 1.00 (was 2.00) | 1.00 (was 2.00) |
| 4 | 1.00 (was 4.00) | 1.00 (was 4.00) |
| 8 | 1.00 (was 8.00) | 1.00 (was 8.00) |

What this buys is headroom rather than latency: discovery stops consuming database capacity proportional to your worker count, which is what made adding workers quietly expensive.

**The trade:** discovery is no longer fault-tolerant by redundancy. One worker holds a short lease, and if it dies nobody discovers work until that lease expires — seconds, self-healing, and nothing is lost, but reaction latency spikes for that window.

### What bounds a subscription-heavy system

- **Streams are the unit of parallelism, in reactions as in commits.** Reactions targeting one stream serialize against each other exactly as writes to one aggregate do.
- **Acknowledgements churn an index.** Only about 38% of subscription updates take Postgres's cheap path, so heavy drain traffic grows the claim index. It is housekeeping rather than a ceiling — dead rows and table size hold flat — and a periodic `REINDEX INDEX CONCURRENTLY` reclaims it ([production checklist](../docs/docs/guides/production-checklist.md)).
- **Retired streams keep their subscription rows.** One row per permanently closed stream, inert and never claimed, on the same order as the tombstone that also stays forever.

## What is deliberately not here

- **The true reaction ceiling.** Scenario C shows delivery keeping pace with a single sequential writer, not the point where it stops keeping pace. Finding that needs a writer fast enough to build a backlog, which none of these harnesses do. The `leased/s` column is the closest available proxy.
- **Reaction handler cost.** Every handler in these runs is a no-op. Real handlers do work — HTTP calls, database writes — and that dominates. Measure yours.
- **The 50M tier** — the audience today is small/medium systems; the linear trends above extrapolate, and `run.sh` accepts your own numbers when you need certainty.
- **Micro-benchmarks** — per-optimization before/after history lives in `libs/act/PERFORMANCE.md` and `libs/act-pg/PERFORMANCE.md`.
