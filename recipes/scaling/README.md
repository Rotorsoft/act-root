# Scaling Act in production

This is the operator's decision tree for "my Act application is under storage or
throughput pressure." It starts where your pager woke you up (a symptom) and ends
at one of five places: a close-the-books recipe, an archival recipe, a split-stores
recipe, a partitioning recipe, or an honest "you've outgrown the framework's
shipped assumptions" door.

Default Act is fine for most apps. The framework's defaults — global `id`
ordering, single Postgres instance, drain-driven reactions, optimistic concurrency
on commit — comfortably handle hundreds of streams, tens of millions of events,
and the commit/reaction rates measured in
[libs/act/PERFORMANCE.md](../../libs/act/PERFORMANCE.md) and
[libs/act-pg/PERFORMANCE.md](../../libs/act-pg/PERFORMANCE.md). If you haven't
yet hit a measured wall, you don't need this folder.

> **Make sure Act is the right tool first.** This decision tree assumes you're
> running a business application — domain aggregates with lifecycles, invariants,
> events that represent business facts. If your workload is telemetry, sensor
> streams, log ingestion, or any other high-frequency append-only firehose
> where events are *measurements*, the scaling story below doesn't apply
> because Act isn't the right tool in the first place. Time-series databases
> and stream processors exist for those workloads. See
> [recipes/README.md](../README.md#act-is-for-business-apps) for the longer
> framing on what Act is and isn't shaped for.

If you have, the gates below run in order. Each gate is a question you answer
before moving down. Most operators stop at Gate 1.

## Symptoms cheat-sheet

Use this to jump straight to the gate that owns your problem. Detailed reasoning
follows below.

```
| If you see ...                                  | Read ...                |
| ----------------------------------------------- | ----------------------- |
| events table growing without bound              | Gate 1                  |
| slow query_stats / app.load on busy aggregates  | Gate 1                  |
| reducer cost rising as streams accumulate       | Gate 1                  |
| auditors want history, business wants it gone   | Gate 2                  |
| GDPR / retention window + cold-tier requirement | Gate 2                  |
| one store hosting several contexts / tenants    | Gate 3                  |
| seq contention between unrelated workloads      | Gate 3                  |
| drain waking on another context's commits       | Gate 3                  |
| VACUUM windows dominating maintenance budget    | Gate 4 (case 1)         |
| append-only audit ledger, deletion forbidden    | Gate 4 (case 1)         |
| one stream with millions of events, no close    | Gate 4 (case 2)         |
| regulatory retention windows + bulk drop        | Gate 4 (case 3)         |
| app.reset() takes too long                      | Gate 4 (case 4, caveat) |
| claim() / SKIP LOCKED contention                | not partitioning;       |
|                                                 | check reaction backoff  |
|                                                 | + lane sizing in        |
|                                                 | production-checklist    |
| drain throughput plateau                        | not partitioning;       |
|                                                 | check lanes (LaneConfig)|
|                                                 | + streamLimit           |
| LISTEN/NOTIFY wakeup misses                     | not scaling; see        |
|                                                 | libs/act-pg/PERFORMANCE |
| close-cycle CPU climbing every release          | tune autocloseCycleMs / |
|                                                 | closeBatchSize, then 1  |
| even after Gates 1-4, the wall doesn't move     | Gate 5                  |
```

The right-hand column points into a gate, not a fix. The gate's prose explains
which recipe to run.

## Gate 1: Can close-the-books handle it?

This is the gate you should read first and longest, because it is the answer for
roughly 90% of "my events table is growing" tickets.

The most common storage-growth pattern in event-sourced apps is not "every
stream is busy forever." It is "old streams keep their history forever even
though nothing reads them anymore." Resolved tickets nobody will reopen.
Sessions that ended six months ago. Carts abandoned in 2024. Each one keeps
paying index space, replay time, and `query_stats` latency for a workflow that
ended long ago.

`Act.close()` is the right tool. It writes a tombstone at the head of the stream
and atomically truncates the events, leaving the stream inaccessible for new
commits (`StreamClosedError`) and old reads (`StreamClosedError` on `app.load`).
The events table reaches a steady state: as new streams open, old streams shed
their history, and the high-water mark stops climbing.

Two ways to wire this. **Explicit close**, called from the action handler that
recognizes the terminal event:

```ts
await app.close([
  { stream: "order-2024-12345", archive: async () => { /* see Gate 2 */ } },
]);
```

**Declarative auto-close**, a per-state policy declared on the builder:

```ts
const Ticket = state({ Ticket: ticketSchema })
  .emits({ TicketOpened, TicketResolved })
  // ...
  .autocloses({
    is: "TicketResolved",      // domain lifecycle
    after: { days: 90 },       // AND cooldown
  })
  .build();
```

The `.autocloses({...})` form covers ~90% of real policies in a line. See
[docs/docs/guides/close-policies.md](../../docs/docs/guides/close-policies.md)
for the full API: terminal-event matching, time windows, cardinality thresholds,
`or:` backstops, and the per-cycle cost knobs (`autocloseCycleMs`,
`closeBatchSize`, `closeYieldMs`).

The recipe at [recipes/scaling/close-the-books/](./close-the-books/) is the
operator-side companion: how to identify which streams should close, how to
roll out an `.autocloses` policy to a running fleet without surprising users,
how to size the cycle knobs, what `query_stats` to monitor as you cut over.

### How to know you're done with Gate 1

You're done when one of two things is true:

1. The events table reaches steady state. Total row count plateaus over a few
   close cycles. `app.query_stats({})` shows a stable distribution of live
   streams instead of monotonic growth. Move on with your life.

2. You can show, with numbers, that even aggressive close policies can't keep
   pace with the workload. A single-aggregate giant whose stream never reaches
   a terminal event. An append-only audit log whose business rules forbid
   deletion. A retention regime where the volume between "close-eligible" and
   "drop-eligible" is itself larger than the database can comfortably hold.

If you're in case 2, continue to Gate 2 or beyond. If you haven't measured —
if you're guessing close won't work — go measure first. Operators routinely
believe their streams are "long-lived and never end" when in fact most of them
have natural terminal events that go unused.

## Gate 2: Do you need history off the hot path but not deleted?

Some workloads want close-the-books' benefits — bounded hot-table size,
predictable replay windows, fast `query_stats` — and also want the events
to remain readable later. Auditors investigating a six-month-old incident.
Analysts running quarterly retro queries. Regulators asking for
proof-of-history. Customer-support reading the full timeline of a closed
ticket.

The pattern is `.autocloses` paired with `.archives`. The framework runs the
archiver inside the close-cycle's guard window — tombstone first, archiver
second, `Store.truncate` last — so the archived snapshot and the deleted
events are consistent. If the archiver throws, the truncate is skipped and the
stream is retried next tick. No events are lost.

```ts
.autocloses({ is: "TicketResolved", after: { days: 90 } })
.archives(async (stream, head) => {
  const events = await loadHistory(stream);
  await s3.upload(`tickets/${stream}.jsonl`, events);
})
```

Three contracts the framework expects from your archiver, all spelled out in
the [close-policies guide](../../docs/docs/guides/close-policies.md#the-archive-contract):
idempotency (re-running on a retry must not double-write), speed (the
archiver holds the stream's guard; stage heavy work elsewhere), and durable
acknowledgment (the framework only knows the archiver resolved; don't ack
before the data is actually durable).

The recipe at [recipes/scaling/archival/](./archival/) walks through the three
common sinks — S3-as-JSONL, a cold Postgres tier, an analytics warehouse —
including the SQL snippets that read the archived data back later. It also
covers the operational checklist: what to monitor on the archive bucket, how
to verify a sampling of archives match their original streams, and how to
restore a single archived stream if the business asks.

Stay at Gate 2 if archival is the heaviest tool your workload needs. Reach
for Gates 3 and 4 only when the hot table itself — even with `.autocloses`
running — can't sustain the read or maintenance shape your operations team
needs.

## Gate 3: Is one store serving more than one bounded context or tenant?

The gates so far assumed the events table is full of *finished* streams.
This gate is for the table that's already bounded and still hurts —
because of what it contains, not how much. Every Act store maintains one
global `id` sequence, one total order over everything in it. That order
is load-bearing *within* a bounded context: drain dispatches by it,
projections advance by it, causality debugging relies on it. But when one
store hosts several bounded contexts (orders, billing, audit) or several
tenants, the total order also covers pairs of events that no reader ever
compares — and you pay for it anyway. Every commit serializes through the
shared `events_id_seq`. Every cross-stream read merge-sorts the union.
A flash sale in the orders context wakes drain scans that only care about
audit's streams.

The question this gate asks: **what actually reads across the boundary?**
If the honest answer is "nothing" — no projection spans contexts, no
replay crosses tenants — then the shared total order is an accident of
deployment, and the fix is structural: one Act per context or tenant,
each built with its own store and cache via `ActOptions.scoped`. Each
split-off store gets its own sequence, its own watermark space, its own
drain and close cycle. Per-schema `PostgresStore`s on a shared host is
the gentle first step; a schema that outgrows the host later moves to
its own instance without an application-code change.

```ts
const orders = builder.build({
  scoped: {
    store: new PostgresStore({ schema: "orders" }),
    cache: new InMemoryCache({ maxSize: 5000 }),
  },
});
```

The costs are real and permanent: no cross-store total order,
cross-context reactions go through a forwarded bus or an inbound
receiver instead of the drain pipeline, and every operational surface
(inspector, `app.reset`, `blocked_streams`, dashboards) multiplies by N.
The recipe at [recipes/scaling/split-stores/](./split-stores/) spells
out the symptoms, the `scoped` mechanics (store + cache together,
per-store notify wiring, the AsyncLocalStorage boundary), and the honest
give-up list.

Run this gate before partitioning, always. Partitioning keeps the
accidental total order and pays MergeAppend planner cost forever to
preserve it; splitting stores removes the coupling instead. If the
table is divisible along a context or tenant seam, split it. Continue
to Gate 4 only when the workload is one giant *indivisible* context.

## Gate 4: Is your workload one of the four genuine extremes?

Partitioning is operationally heavy. It rewrites the events table, makes the
primary key composite, adds N×K index trees instead of K, and pays MergeAppend
cost on every cross-stream read. Most apps that reach for partitioning end up
paying the cost without the benefit, because their workload was actually a
Gate 1 problem in disguise.

The four workloads where close + archival genuinely can't help are quoted
verbatim from [libs/act-pg/PARTITIONING.md](../../libs/act-pg/PARTITIONING.md):

> 1. **Regulated / append-only audit logs.** Financial ledgers, compliance
>    trails, blockchain-adjacent systems where deletion is forbidden by policy
>    or law. `Act.close()` is unavailable because tombstones are still
>    "deletion" in the strict regulatory reading. The events table grows
>    monotonically forever; index height, VACUUM duration, and planner stats
>    eventually dominate tail latency.
>
> 2. **Single-aggregate giants.** One stream with millions of events on a
>    single business-domain aggregate — a long-running ledger for one
>    regulated entity, an audit trail for a critical workflow that runs for a
>    decade, a compliance event log for a single legal entity. The aggregate
>    can't be closed because the business still treats it as alive. HASH
>    partitioning by `stream` does not help here (all the events for one
>    stream land in one partition); range partitioning by `id` might.
>
> 3. **Bulk archival with retention windows.** Regulatory frameworks that
>    require retention for N months and then mandate disposal. `Act.close()`
>    deletes per-row, which is slow on hundreds of millions of rows;
>    `DETACH PARTITION` + `DROP TABLE` is constant-time DDL regardless of
>    partition size. Some regulators also accept partition-drop as "physical
>    retention until partition retirement," which is more defensible than
>    per-row delete.
>
> 4. **Parallel projection rebuild as the bottleneck.** Operations teams
>    running periodic full `app.reset()` on a multi-hundred-million-row events
>    table, where the rebuild window is the operational bottleneck. *Caveat:*
>    see the global-`id` discussion above — partitioning helps rebuild
>    throughput only when the partitioned MergeAppend cost is dominated by
>    per-partition parallel I/O. Benchmark before assuming this; the
>    framework's PG benchmark (#851) reports observed vs theoretical speedup
>    for exactly this reason.

Be honest about which of these you have — and check the Gate 3 seam
first: several of the workloads that *look* like case 1 are really
several contexts sharing a store, and splitting is cheaper than any
partition scheme. Only case 1 maps cleanly to HASH
partitioning. Case 2 needs range-on-`id` and is more documentation than
turn-key recipe. Case 3 needs range-on-`created` and pairs with the
partition-drop runner. Case 4 is conditional — partitioning may help your
rebuild, may hurt it, and the only way to know is to benchmark on your data
shape.

The partitioning gating page at
[recipes/scaling/partitioning/](./partitioning/) is the next required read
before any of the strategy-specific recipes. It restates the global-`id`
constraint, the MergeAppend tax on cross-stream reads, and the migration cost
you'll pay regardless of strategy. Once you've cleared that gate, the
strategy recipes are:

- [recipes/scaling/partitioning/hash-on-stream/](./partitioning/hash-on-stream/)
  for case 1 (regulated append-only).
- [recipes/scaling/partitioning/range-on-id/](./partitioning/range-on-id/)
  for case 2 (single-aggregate giants).
- [recipes/scaling/partitioning/range-on-created/](./partitioning/range-on-created/)
  for case 3 (retention-window bulk drop).

Case 4 doesn't have a dedicated recipe because the answer is "run #851's
parallel-rebuild benchmark on your data shape and decide from the numbers."
The bench is the recipe.

## Gate 5: You've reached the framework's limit

Some workloads outgrow the assumptions the framework ships with. One
bounded context's events cannot fit on a single Postgres instance even
with HASH partitioning. The global `id` order *within a single context*
is itself the bottleneck — drain throughput plateaus because the
lagging-frontier claim ordering is serialized through one sequence, and
there's no seam left to split along (Gate 3 already gave each context
and tenant its own store). Multi-region write-anywhere semantics that
conflict with optimistic concurrency on a shared sequence.

The framework intentionally does not ship sharding, multi-master, or
cross-region strategies. They are not "missing features"; they are bespoke
trade-offs that depend on which invariants you're willing to give up
(global ordering, single-writer simplicity, exact-once drain) for what gain.
Shipping a one-size-fits-all answer would be wrong.

If you're at Gate 5, the path forward is:

1. Confirm with numbers that Gates 1-4 don't move your wall. Specifically:
   show the close-cycle is doing what it can, archival is keeping the hot
   table bounded, every divisible context or tenant already has its own
   store, partitioning has been measured (not assumed) for your read
   shape, and the wall is still there.

2. Open an issue at https://github.com/Rotorsoft/act-root/issues with the
   `area:ops` label, attach your numbers, and describe which framework
   assumption is the binding constraint. "Drain at X commits/sec across Y
   workers but `claim()` serializes through one sequence." Concrete.

3. Expect the conversation to be bespoke. We may sketch a sharded variant,
   find a split seam Gate 3 missed, or conclude that your case is genuinely
   the kind of scale where you outgrow the framework. All three are
   legitimate outcomes; "Act is wrong for this" is sometimes the right
   answer.

This gate isn't a recipe because there isn't a generic one. It is a door
into a focused conversation grounded in measurements.

## A closing note on order

The gates are ordered by how often they apply, not by how interesting they
sound. Gate 1 is boring and answers most tickets. Gate 4 is exciting and
answers very few. The temptation, especially under pressure, is to skip
straight to partitioning because it sounds like the heavyweight answer.
Resist it. The cost of running Gate 1 first is at most a day of measurement;
the cost of partitioning a table that didn't need it is months of
operational tax that can't be undone without another full migration.

Most "we need to scale Act" tickets are Gate 1 tickets in disguise. Start
there.
