# Act recipes

Operator-facing playbook for running an Act application in production. This folder is for the moments where you've stopped writing domain code and started thinking about indexes, maintenance windows, and weekly cron jobs. Framework reference lives in `docs/docs/` and the design history is in `book/`; this tree is the operations handbook.

## Act is for business apps

Before any of the scaling recipes apply, the framework has to be the right tool. Act is built for **business applications** — domain-driven event-sourced systems with aggregates that have lifecycles, invariants, and human-comprehensible workflows. Orders, tickets, subscriptions, accounts, ledgers, claims, applications, sessions, audit trails for regulated processes. Workloads where events represent *business facts* — somebody did something, something was approved, a contract entered a new state — and the system's job is to keep the truth and react to it.

Act is **not** built for telemetry, sensor streams, real-time analytics, log ingestion, or any other high-frequency append-only firehose where events are *measurements* rather than facts. Several reasons:

- The framework's hot path is opinionated around correctness (Zod validation per event, single global `id` sequence, optimistic concurrency on `(stream, version)`, reaction routing through the drain pipeline). Every commit pays that opinion. Telemetry pipelines need the opposite trade — cheap ingest, no per-event validation, batch flushes.
- The default storage adapter is Postgres. Postgres serves business apps beautifully and serves multi-million-events-per-second telemetry workloads poorly. The recipes in this folder all assume the PG side of that boundary; nothing here translates to ClickHouse or TimescaleDB or InfluxDB.
- The state-machine model (one stream = one aggregate, reducer produces current state from event history) is exactly what you want for a business aggregate and exactly not what you want for measurements you'll only ever read as a time series.

If your workload is telemetry-shaped, you want a time-series database, a stream processor, or a purpose-built ingest pipeline. Pick the right tool and skip the rest of this folder. If your workload is business-shaped, read on.

## What "almost" means

The framing the rest of this folder is built around: **default Act plus Postgres plus close-the-books handles almost every real workload.** This folder documents what "almost" actually means — the symptoms of the walls you might hit, and the recipes for getting past them.

## What "default Act handles" looks like

Concrete envelope of safe operation, all numbers traced back to the bench scripts in [`libs/act/PERFORMANCE.md`](../libs/act/PERFORMANCE.md) and [`libs/act-pg/PERFORMANCE.md`](../libs/act-pg/PERFORMANCE.md). Run the same scripts on your hardware before quoting them in capacity planning.

| Dimension                                  | Where you stop being CPU-bound                                                                         | Source                                                                            |
|--------------------------------------------|--------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------|
| Cross-stream commits, InMemoryStore        | ~13,900 commits/sec at 50-way parallelism (synthetic upper bound)                                       | `libs/act/PERFORMANCE.md` § Current scenarios                                     |
| Same-stream contention, InMemoryStore      | ~8,000 commits/sec with retries, no invariants                                                          | `libs/act/PERFORMANCE.md` § Current scenarios                                     |
| Realistic ticket workflow (3 actions, 2 invariants) | ~414 commits/sec — the synthetic-to-realistic gap is roughly 50%                                 | `libs/act/PERFORMANCE.md` § Realistic workloads                                   |
| Realistic same-stream contention with invariant | ~3,940 commits/sec — about half the synthetic ceiling                                              | `libs/act/PERFORMANCE.md` § Realistic workloads                                   |
| Single-process reaction latency floor (PG) | p50 ~4 ms idle / ~10 ms at 100 commits/sec, saturates around 200 commits/sec sustained                  | `libs/act/PERFORMANCE.md` § Reaction latency                                      |
| Cross-process commit→reaction latency (PG) | p50 11 ms via LISTEN/NOTIFY; polling at 50 ms is roughly 3× slower; default 10 s polling is ~1000× off  | `libs/act-pg/PERFORMANCE.md` § ACT-101                                            |

Numbers above are macOS 25.4 (Apple Silicon) against the docker PG used by the adapter's own tests (`postgres:17-alpine` on port 5431). Production PG running on commodity Linux with persistent disks lands in the same order of magnitude — expect tail latency to be jumpier under autovacuum and replication, and re-run the scripts before quoting anything in a runbook.

**On the storage shape itself:** events table growth is linear, and PG's btree indexes serve billions of rows without any algorithmic surprise. The walls you hit first are operational — VACUUM duration, replication lag, the size of the table dump you have to take during a schema migration window — not query planner failure. If your events table is under 10M rows and your maintenance windows fit, you have no engineering problem; you have an organic accumulation that the next section addresses.

## Reach for close-the-books before anything else

Almost every "my events table is growing" symptom is solved by retiring streams that have finished their business lifecycle. Resolved tickets, completed orders, expired sessions, abandoned carts — the events stay correct and the stream stays auditable, but the row count comes back to the framework for the next live stream. The mechanism is `Act.close()` plus the declarative `.autocloses({...})` policy, which compiles to a synthesized reaction that defers to the cooldown and then runs the same close primitive — no background sweep.

```ts
const Ticket = state({ Ticket: ticketSchema })
  .init(() => defaults)
  .emits({ TicketOpened, TicketResolved })
  // …
  .autocloses({ is: "TicketResolved", after: { days: 90 } })
  .archives(async (stream, head) => {
    await s3.upload(`tickets/${stream}.jsonl`, await loadHistory(stream));
  })
  .build();
```

Full syntax (verb-shaped declarative form, `or: {...}` backstops, archive contract, cycle knobs) lives in [`docs/docs/guides/close-policies.md`](../docs/docs/guides/close-policies.md). The recipe at [`recipes/scaling/close-the-books/README.md`](scaling/close-the-books/README.md) is the operator-side companion: when to declare which predicate, what to monitor on the cycle, how to handle predicates that throw, and the cost model for the per-cycle scan.

If `close()` can keep your events table in steady state — and for the dominant Act workload it can — none of the heavier recipes in this folder apply to you. Stop there.

## Recipe index

| Recipe                                                                              | Use when                                                                                               | Operational tax            |
|-------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------|----------------------------|
| [scaling/README.md](scaling/README.md)                                              | You're not sure which recipe applies. Decision tree maps symptoms to recipes.                          | Reading time only          |
| [scaling/close-the-books/README.md](scaling/close-the-books/README.md)              | Events table growing because finished streams aren't shedding history. Solves 90% of growth concerns.  | Per-cycle scan + tombstones |
| [scaling/archival/README.md](scaling/archival/README.md)                            | You want to persist a stream's events to a cold tier (S3, warehouse) before `close()` truncates them.  | `.archives` handler latency on the close-cycle guard window |
| [scaling/split-stores/README.md](scaling/split-stores/README.md)                    | One store serves several bounded contexts or tenants that never needed a shared order. One Act + one store per context via `ActOptions.scoped`. | One store per context to provision, back up, monitor; cross-context reactions via bus/receiver |
| [scaling/partitioning/README.md](scaling/partitioning/README.md)                    | You're in one of the four extreme cases where `close()` genuinely can't help. Gating page leads with "don't." | Migration window + ongoing planner overhead + range maintenance |
| [temporal/README.md](temporal/README.md)                                            | You need something to happen *because time passed* (a deadline, a cooldown, a repeating timer). One-shot is plain `.defer`; this folder owns the recurring case. | Reaction lease per timer stream |
| [temporal/recurring-timers/README.md](temporal/recurring-timers/README.md)          | A reaction has to re-fire on a cadence (repeating nudge, widening escalation, bounded retries, wall-clock tick) rather than fire once. | One tick event committed per firing |

Partitioning itself splits into three subrecipes that buy different properties:

| Subrecipe                                                                                                           | Solves                                                                                |
|---------------------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------|
| [scaling/partitioning/hash-on-stream/README.md](scaling/partitioning/hash-on-stream/README.md)                       | Regulated append-only audit logs where deletion is forbidden                          |
| [scaling/partitioning/range-on-id/README.md](scaling/partitioning/range-on-id/README.md)                             | Single-aggregate giants (one stream with millions of events, can't be closed)         |
| [scaling/partitioning/range-on-created/README.md](scaling/partitioning/range-on-created/README.md)                   | Retention-window bulk archival — `DETACH PARTITION` + `DROP TABLE` instead of per-row delete |

## Conventions

Each recipe is a folder with a `README.md` and optional runnable artifacts: raw SQL files, shell scripts, occasional TypeScript samples. The SQL files use `{{schema}}` and `{{table}}` placeholders matching the PG adapter's identifier shape; substitute them with `sed` or `envsubst` against your own deployment's identifiers before running anything against a live database. Shell scripts use `bash` and assume `psql` on `PATH`. TypeScript samples are runnable against the `postgres:17-alpine` docker container on port 5431 that backs the PG adapter's own test suite (`docker run -d --name pg-stress -p 5431:5432 -e POSTGRES_PASSWORD=postgres postgres:17-alpine`) so you can rehearse a recipe against an ephemeral DB before adapting it for production.

Every recipe is written as something an operator runs during a maintenance window, not something the framework runs for you. Recipes that need a tickle every N hours (range partition provisioning, archival uploads with retry) get a sample cron stanza in their README; the framework itself stays out of the loop.

## When the recipes don't cover your case

If you've worked through the decision tree and the wall you're hitting isn't here, open an issue at [Rotorsoft/act-root](https://github.com/Rotorsoft/act-root/issues) tagged `area:ops` with the symptom (table size, query, percentile that's slipping), the bench script you used to characterize it, and the close-the-books policy you've already tried. The recipes folder grows by case; "we hit this wall and the existing recipes didn't fit" is exactly the input that adds a new one.
