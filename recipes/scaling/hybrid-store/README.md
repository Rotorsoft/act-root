# Hybrid store — put the subscriptions on their own database

Your event log and your subscription table have opposite physics. The log is
append-only, large, and cold: written once, read in ranges, never updated. The
subscription table is tiny, hot, and mutated constantly — every claim bumps a
retry counter, every ack advances a watermark, every correlate scan raises a
work mark.

Running both in one Postgres means the busy small table and the quiet huge one
share a WAL, a checkpointer, an autovacuum budget, and a connection pool. This
recipe separates them without changing a line of application code.

## When to reach for it

Measured on two Postgres instances against one shared workload, every worker in
its own OS process
([`libs/act-pg/scripts/hybrid-split.bench.mjs`](../../../libs/act-pg/scripts/hybrid-split.bench.mjs),
20k subscriptions, 4 committers):

| split ÷ single | 1 worker | 4 | 8 | 16 |
|---|---|---|---|---|
| claim p50 | **0.85×** | **0.88×** | **0.89×** | **0.85×** |
| leased/s | **1.21×** | **1.19×** | **1.10×** | 0.87× |
| ack p50 | **0.79×** | **0.84×** | **0.89×** | 1.06× |

**The split is free, and then some.** The extra network hop — the cost that
should have made this a trade-off — never shows up. Claim latency improves
11–15% and drain throughput up to 21%, because the subscription table stops
sharing locks, buffers and autovacuum budget with a much larger neighbour.

**Reach for this when drain contention is your problem**, or when you want the
subscription store sized, tuned, backed up or failed over differently from the
log. It is small and its loss costs redelivery; the log's loss is unrecoverable,
and the two deserve different operational treatment.

### What we can't tell you

An earlier version of this page led with a bigger claim: that splitting
**doubles commit throughput**, because drain traffic was slowing the event log
by ~2×. That number came from a benchmark whose workers all shared one Node
process and one connection pool, so moving subscription calls to a second pool
mostly relieved the *client*. Re-measured with real processes, it does not
reproduce. It is retracted.

What replaces it is an honest gap. On a single machine, commit throughput
measures **0.77–0.91×** — the split looks like a small loss. That is the test
rig, not the design: both Postgres instances share one host, so splitting adds
no hardware, it just moves the subscription work to a sibling competing for the
same cores and disk. The penalty tracks the neighbour's load exactly (0.93× with
the subscription side idle, 0.70× with it at 390% CPU), and host CPU, client
CPU, committer concurrency and fsync amortization were each tested and ruled out
([details](../../../libs/act-pg/PERFORMANCE.md)).

**No single-host benchmark can settle the commit question**, so this page no
longer claims a foreground-write win. If commit latency is what you are trying
to fix, the split is plausible but unproven — measure it on your own two hosts
before committing to it. [#1522](https://github.com/Rotorsoft/act-root/issues/1522)
tracks the two-machine run.

Do **not** reach for it when claim latency alone is your complaint:
[#1518](https://github.com/Rotorsoft/act-root/pull/1518) already took that to
~1.5 ms at 100k subscriptions on a single database, and 11% off an already-small
number rarely justifies a second system.

## What makes it possible

Every hot method belongs cleanly to one half:

| Event log | Subscriptions |
|---|---|
| `commit`, `query`, `query_stats`, `restore`, `forget_pii`, `notify` | `subscribe`, `claim`, `ack`, `block`, `unblock`, `defer`, `prioritize`, `reset`, `query_streams` |

That was not true until [#1488](https://github.com/Rotorsoft/act-root/issues/1488).
`claim` used to answer "does this stream have work?" by probing the event log,
so the hottest call in the framework touched both halves and no split was
possible without putting a cross-database join on it. Now eligibility is a
predicate on the subscription row (`at < correlated_at`), and the halves come
apart.

The ids stored on subscriptions (`at`, `correlated_at`) come from the log's
sequence, and they cross the boundary safely because nothing ever
*dereferences* one — they are only compared. That is the opaque-token property
Kafka offsets and Axon tracking tokens have.

## The recipe

[`hybrid-store.ts`](./hybrid-store.ts) is a complete implementation, and it is
mostly delegation. Wire it before building your Act:

```ts
import { act, store } from "@rotorsoft/act";
import { PostgresStore } from "@rotorsoft/act-pg";
import { hybridStore } from "./hybrid-store.js";

store(
  hybridStore(
    new PostgresStore({ port: 5432, schema: "events" }), // the log
    new PostgresStore({ port: 5433, schema: "events" })  // the subscriptions
  )
);

const app = act().withState(/* ... */).build();
```

`store(...)` must come **before** `act()...build()` — the orchestrator wires
its `notify` subscription at construction, so late injection silently does
nothing.

Nothing downstream changes. Reactions, projections, `settle()`, `close()` and
the whole builder API are unaware there are two databases.

## What you take on

**`truncate` used to span both stores. It no longer does.**

Retiring a stream deletes its events, seeds a tombstone, and forgets its
subscription. Until [#1527](https://github.com/Rotorsoft/act-root/issues/1527)
the `Store` contract required all three in one transaction, which a hybrid
cannot provide — so this recipe had to call the two halves itself, pick an
order, and accept a crash window. That ordering argument was subtle and getting
it backwards failed silently, which made it the one place a hybrid owed real
work rather than delegation.

The port now splits it. `truncate` is the event-log half; the optional
`retire(streams)` is the subscription half, and `Act.close` calls it after a
successful truncate with the streams it actually retired. The recipe is two
more delegations:

```ts
truncate: log.truncate.bind(log),
retire: subs.retire?.bind(subs),
```

The crash window still exists — two systems, no shared transaction, nothing
changes that. What changed is who reasons about it. The orchestrator fixes the
order (log first, so the tombstone that stops new events landing is committed
before the subscription goes), and `Act.close` is already resumable after an
interrupted truncate
([#1389](https://github.com/Rotorsoft/act-root/issues/1389)), so an orphaned
subscription row claims nothing and is reaped by the next close.

**Two systems to operate.** Backup, monitoring, failover, version skew. The
honest framing: losing the subscription store costs *redelivery*, not data.
Watermarks are the only record of what has been processed — the log records
what happened, not what was consumed — so restoring an older subscription
backup rewinds watermarks and replays. At-least-once already permits that, but
a webhook target replaying its history is the case where it hurts, and it is
the same hazard `reset` carries.

**It does not fix index churn.** Only 14–41% of subscription-table updates take
Postgres's cheap path, because `ack` moves `at`, and `at` is both a key column
of the claim index and part of the condition deciding which rows belong in it.
That follows from how Postgres answers an update, not from where the table
lives — a second instance relocates the churn rather than removing it.

Measured over a sustained run, this is housekeeping rather than a ceiling: dead
rows hold flat, table size holds flat, and only the indexes drift, at roughly
half-empty pages. A scheduled `REINDEX INDEX CONCURRENTLY` handles it — see
[the production checklist](../../../docs/docs/guides/production-checklist.md).
A store without MVCC would avoid the churn entirely, and
[#1523](https://github.com/Rotorsoft/act-root/issues/1523) closed on the
conclusion that it is not worth a second engine to do so.

## The caveat on the numbers

Both Postgres instances run on one host, sharing CPU, disk and a Docker VM.
That is fine for the subscription-side numbers, which are about contention
inside the database, but it is the wrong shape for anything about commit
throughput — see [what we can't tell you](#what-we-cant-tell-you) above.

At 16 workers the split's `leased/s` drops to 0.87×, the only subscription-side
regression in the matrix. Two Postgres instances plus 21 client processes on 12
cores is a crowded machine, and that is the most likely explanation, but it is
unconfirmed for the same reason.

## Trying it

```bash
docker compose --profile bench up -d postgres-subs   # second PG on :5432
pnpm build
LOG_LEVEL=error node libs/act-pg/scripts/hybrid-split.bench.mjs
```

`STREAMS`, `SECONDS`, `WORKERS`, `COMMITTERS` and `SUBS_PORT` override the
shape. Every worker runs as its own OS process, and the run reports how much of
the host the benchmark client itself consumed — if that approaches 100%, the
cell measured the client and the output says so.

`COMMITTERS` matters more than it looks: with one committer, commit throughput
is exactly 1/latency, and a lone writer on a dedicated server pays for every
WAL flush by itself instead of sharing one with the drain traffic. That reads as
"the split made commits slower" when it is really a statement about group
commit. The default is 4.

## Related

- [Split stores by bounded context or tenant](../split-stores/README.md) — the
  other axis. That one splits by *what the data is about*; this one splits by
  *what the data is for*.
- [RFC 1449](../../../rfcs/1449-split-store-port.md) — why the `Store` port was
  **not** split in two to enable this. A hybrid adapter behind the single
  interface gets the same deployment flexibility without a breaking change, so
  the port split was deferred to 2.0 and is probably superseded.
- [`libs/act-pg/PERFORMANCE.md`](../../../libs/act-pg/PERFORMANCE.md) — the
  full measurements, including the first benchmark that asked the question
  backwards and reached the wrong conclusion.
