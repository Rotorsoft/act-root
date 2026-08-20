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

**The symptom is commit latency, not drain latency.** That surprised us, and
it is the whole point of the recipe.

Measured on two Postgres instances against one shared workload
([`libs/act-pg/scripts/hybrid-split.bench.mjs`](../../../libs/act-pg/scripts/hybrid-split.bench.mjs)):

| | one database | events and subscriptions apart |
|---|---|---|
| commit p50 | 1.43 ms | **0.66 ms** |
| commits/s | 716 | **1455** |
| claim p50 | 16.02 ms | 15.73 ms |
| ack p50 | 1.07 ms | 0.87 ms |

**The split is free.** Claim latency is 0.96–1.01× across every worker count —
the extra network hop, which is the cost that should have made this a
trade-off, does not show up at all.

**And it roughly doubles commit throughput.** The contention is asymmetric:
event-log writes do not slow the subscription workload, but the subscription
workload slows the log. Drain is background work; commits are what your users
wait on. Halving foreground write throughput to run background work is exactly
what separating them fixes.

Reach for this when:

- Commit latency matters and drain traffic is heavy — many subscribed streams,
  a busy correlate, or several workers.
- You want the subscription store sized, tuned, backed up or failed over
  differently from the log. It is small and its loss is survivable; the log's
  is not.

Do **not** reach for it when:

- Claim latency is your complaint. Separation does not help there; it was
  already flat, and [#1518](https://github.com/Rotorsoft/act-root/pull/1518)
  took it to ~1.5 ms at 100k subscriptions.
- You are saturating many workers. The measured advantage narrows to ~1.05× at
  8 workers, and we cannot yet say whether that is real or the benchmark client
  saturating — see the caveat below.

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

**`truncate` spans both stores, and there is no shared transaction.** It is
the only place this recipe owes real work. A full close deletes a stream's
events, seeds a tombstone, *and* removes the subscription row.

The implementation does the log first, deliberately. Its truncate commits the
tombstone that stops new events landing on the stream, so a crash between the
two halves leaves an orphaned subscription row — pointing at a stream whose
events are gone, claiming nothing, and reaped by the next close. The reverse
order would leave a live stream with no subscription, which silently stops
delivery: a worse failure, and one that does not heal itself. `Act.close` is
already resumable after an interrupted truncate
([#1389](https://github.com/Rotorsoft/act-root/issues/1389)).

**Two systems to operate.** Backup, monitoring, failover, version skew. The
honest framing: losing the subscription store costs *redelivery*, not data.
Watermarks are the only record of what has been processed — the log records
what happened, not what was consumed — so restoring an older subscription
backup rewinds watermarks and replays. At-least-once already permits that, but
a webhook target replaying its history is the case where it hurts, and it is
the same hazard `reset` carries.

**It does not fix index churn.** Only 14–41% of subscription-table updates are
HOT, because `ack` moves `at`, and `at` is both a key column of the partial
claim index and part of its membership predicate. That follows from how
Postgres answers an UPDATE, not from where the table lives — a second instance
relocates the churn rather than removing it. A store without MVCC would remove
it; whether that is ever worth building is tracked in
[#1523](https://github.com/Rotorsoft/act-root/issues/1523).

## The caveat on the numbers

Every arm of the benchmark runs as async tasks in **one Node process against
one connection pool**. At 8 workers the client is likely the bottleneck, which
compresses all differences toward 1.0 — and is the most plausible reason the
split's advantage narrows there. A multi-process client should *widen* the gap
rather than close it, but that is a hypothesis, not a result. Tracked in
[#1522](https://github.com/Rotorsoft/act-root/issues/1522).

So: strong evidence at low-to-moderate concurrency, unresolved at high.

## Trying it

```bash
docker compose --profile bench up -d postgres-subs   # second PG on :5432
pnpm build
LOG_LEVEL=error node libs/act-pg/scripts/hybrid-split.bench.mjs
```

`STREAMS`, `SECONDS`, `WORKERS` and `SUBS_PORT` override the shape.

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
