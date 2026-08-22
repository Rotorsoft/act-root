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

Reactions happen in two stages, and they behave differently enough to measure apart.

**Finding the work.** Something has to read new events and note which reactions care about them. **Doing the work.** A worker picks up one of those notes, reads the events, runs your handler, and records that it finished.

Finding is cheap and shared. Doing is the part that scales with workers.

### Reactions keep up with writes

The whole path, through a real app: save an event, notice it, pick it up, run the handler, mark it done. Workers are separate processes, so they behave like a real deployment ([`correlate-workers.bench.mjs`](../libs/act-pg/scripts/correlate-workers.bench.mjs)), across 2,000 streams over 20 seconds:

| workers | events committed | events handled | backlog |
|---|---|---|---|
| 1 | 10,634 | **10,634** | none |
| 2 | 10,050 | **10,050** | none |
| 4 | 8,880 | **8,880** | none |

**Every event was handled, at every worker count.** Nothing queued up.

What ran out first was the writer — one process saving events one after another, about 500 a second. The reaction side never fell behind it. Adding workers doesn't raise this number, because there was no queue for them to help with; it lowers it slightly, since more workers competing for the same rows do the same total work with more overhead.

**So if you save a few hundred events a second, reactions aren't your limit.** The next table is for when they might be.

### Picking up work scales to about four workers

The doing half on its own, pushed as hard as it will go ([`hybrid-split.bench.mjs`](../libs/act-pg/scripts/hybrid-split.bench.mjs)), with 20,000 reactions registered:

| workers | time to pick up work (median) | reactions picked up per second |
|---|---|---|
| 1 | 2.09 ms | 2,577 |
| 4 | 2.47 ms | **5,107** |
| 8 | 3.03 ms | 5,091 |
| 16 | 4.31 ms | 3,716 |

Throughput roughly doubles from one worker to four, then flattens. Past eight it gets *worse*: workers spend more time competing with each other than working. **Four to eight workers per database is the useful range** on this hardware.

The other half of the picture is that this speed **doesn't change as you add reactions**. Picking up work takes about 1.5 ms whether the system has a thousand registered reactions or a hundred thousand, because a worker checks a small table rather than searching the event history ([#1488](https://github.com/Rotorsoft/act-root/issues/1488)). It used to take 180 ms at a hundred thousand.

### Finding work costs the same no matter how many workers you run

Every worker used to read the whole event log for itself. With four workers that meant reading everything four times and writing the same notes four times — the cost of *finding* work grew with the number of workers doing it, which is backwards. Since [#1532](https://github.com/Rotorsoft/act-root/issues/1532), one worker reads on behalf of the rest:

| workers | times each event is read | times each note is written |
|---|---|---|
| 1 | 1.00 | 1.00 |
| 2 | 1.00 (was 2.00) | 1.00 (was 2.00) |
| 4 | 1.00 (was 4.00) | 1.00 (was 4.00) |
| 8 | 1.00 (was 8.00) | 1.00 (was 8.00) |

This buys headroom, not speed. Adding workers no longer quietly costs extra database capacity just to keep looking.

**What you give up:** finding work is no longer something every worker does independently, so it is no longer immune to one worker dying. One worker holds a short claim on the job; if it dies, nobody looks for new work until that claim lapses — a few seconds, after which another worker takes over on its own. Nothing is lost, but reactions pause for that gap.

### What actually limits a reaction-heavy system

- **Reactions aimed at the same stream run one at a time**, exactly as writes to the same stream do. If everything funnels through one target, that target is your ceiling — no number of workers changes it.
- **Marking work done wears an index.** Only about 38% of those updates take the database's cheap path, so heavy reaction traffic makes one index grow. This is housekeeping, not a wall: leftover rows and table size stay flat, and a periodic rebuild reclaims the space ([production checklist](../docs/docs/guides/production-checklist.md)).
- **Permanently closed streams leave a small row behind**, one each. They are never picked up again, and there are about as many as the closing markers that also stay forever.

## What is deliberately not here

- **Where reactions actually stop keeping up.** Scenario C shows them keeping pace with one writer, not the point where they can't. Finding that needs a writer fast enough to build a queue, which none of these scripts produce. The "picked up per second" column is the closest stand-in.
- **What your handlers cost.** Every handler in these runs does nothing at all. Real ones make HTTP calls and write to databases, and that will dominate everything on this page. Measure your own.
- **The 50M tier** — the audience today is small/medium systems; the linear trends above extrapolate, and `run.sh` accepts your own numbers when you need certainty.
- **Micro-benchmarks** — per-optimization before/after history lives in `libs/act/PERFORMANCE.md` and `libs/act-pg/PERFORMANCE.md`.
