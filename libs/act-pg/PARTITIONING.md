# Partitioning the events table

> **TL;DR — don't.** For almost every Act application, the right answer to "my events table is growing" is `Act.close()`, not partitioning. Partitioning is an **extreme-case escape valve** for the narrow set of workloads where the default storage adapter genuinely can't serve the business. Read this page if and only if you've already ruled out close-the-books as a solution.

## Why this page leads with "don't"

Partitioning is operationally heavy. It adds migration downtime, ongoing planner overhead, a more complex query plan for every cross-stream read, and (for range strategies) ongoing partition-maintenance toil. It also fights against event sourcing's central invariant — global `id` ordering — in ways that are easy to under-appreciate until you measure them.

If you reach for partitioning before you have a workload that genuinely needs it, you'll pay the operational cost without the operational win. So this page is structured as a series of gates: each section is a chance to stop, conclude "partitioning isn't the answer for me," and close the tab.

## The global-`id` constraint

Act's event store assigns a monotonic `id` to every event across every stream. That global order is **load-bearing** for the framework:

- **Drain** reads events in `id` order to dispatch reactions deterministically.
- **Projections** advance by `id` watermark — `(id > last_id ORDER BY id)` is the canonical fetch shape.
- **`app.reset()`** replays projections by walking the entire events table in `id` order.
- **Cross-stream causality** — debugging "what happened first across the system" relies on `id` being a total order.

Partitioning preserves the **shared `events_id_seq`**, so the IDs themselves stay monotonic. What it does *not* preserve is **single-partition scans for global-order queries**. Any read that needs "the next N events across all streams in id order" must:

1. Open every partition,
2. Sort each partition's rows by `id`,
3. `MergeAppend` the per-partition streams into one ordered cursor.

PG's planner does this well, but the cost is linear in partition count. For an events table partitioned 16 ways, every drain query, every projection advance, every full `app.reset` does **16× the planner work and 16× the I/O setup** that an unpartitioned table would do. If your workload is dominated by these cross-stream reads — and **most event-sourced workloads are** — partitioning costs you on the hottest path.

The implication: partitioning's classic upside ("parallel scan across partitions makes things faster") collides with event sourcing's "I need global id order to make sense of anything." For most queries you can't parallelize without paying MergeAppend, and the queries that *can* prune to a single partition (single-stream `claim`, `commit`, `load`) were already fast on the unpartitioned table.

Carry this trade-off through every section below.

## First gate: can `Act.close()` handle the growth?

`Act.close(targets)` truncates a stream's events and leaves a `__tombstone__` (or `__snapshot__`) behind, reclaiming the row count for streams that are semantically complete. For the dominant Act workload — domain aggregates with a definite lifecycle (orders, tickets, sessions, payments) — close is the right tool.

```ts
await app.close([
  { stream: "order-2024-12345", archive: async () => { /* S3 dump */ } },
]);
```

The companion epic **act-close-the-books** (#802) lets `close()` happen automatically on a per-state policy (`.autocloses(retention(90, "days"))`, `.autocloses(terminal("OrderCompleted"))`, etc.). Once that's wired, an app's events table reaches a steady state — closed streams shed their history continuously, the table doesn't grow without bound, and no partitioning is required.

**If `close()` can keep your events table in steady state, stop reading. You don't need partitioning.**

You should think hard before deciding `close()` can't help. Apps frequently believe their streams are "long-lived and never end" when in fact most of them have natural terminal events that go unused (sessions that expired six months ago, tickets that nobody will ever reopen, carts that were abandoned). Adding a terminal close policy is almost always cheaper than partitioning.

## Second gate: do you have an extreme workload?

The narrow set of workloads where `close()` genuinely can't help:

1. **Regulated / append-only audit logs.** Financial ledgers, compliance trails, blockchain-adjacent systems where deletion is forbidden by policy or law. `Act.close()` is unavailable because tombstones are still "deletion" in the strict regulatory reading. The events table grows monotonically forever; index height, VACUUM duration, and planner stats eventually dominate tail latency.

2. **Single-aggregate giants.** One stream with millions of events on a single aggregate — a multi-year IoT device telemetry trail, a long-running ledger for one regulated entity, an audit trail for a critical workflow that runs for a decade. The aggregate can't be closed because the business still treats it as alive. HASH partitioning by `stream` does not help here (all the events for one stream land in one partition); range partitioning by `id` might.

3. **Bulk archival with retention windows.** Regulatory frameworks that require retention for N months and then mandate disposal. `Act.close()` deletes per-row, which is slow on hundreds of millions of rows; `DETACH PARTITION` + `DROP TABLE` is constant-time DDL regardless of partition size. Some regulators also accept partition-drop as "physical retention until partition retirement," which is more defensible than per-row delete.

4. **Parallel projection rebuild as the bottleneck.** Operations teams running periodic full `app.reset()` on a multi-hundred-million-row events table, where the rebuild window is the operational bottleneck. *Caveat:* see the global-`id` discussion above — partitioning helps rebuild throughput only when the partitioned MergeAppend cost is dominated by per-partition parallel I/O. Benchmark before assuming this; the framework's PG benchmark (#851) reports observed vs theoretical speedup for exactly this reason.

**If your workload doesn't hit one of these four cases, stop reading.** You don't need partitioning. The remaining sections are for the operators who legitimately do.

## When partitioning doesn't help at all

Even if you fit one of the four extreme cases, partitioning isn't always the right shape. Cases where it's specifically *not* the answer:

- **Events table under ~10M rows.** Planner overhead from partition pruning + MergeAppend costs more than the table size saves.
- **Cross-stream queries dominate.** If your projections / reactions span many streams and need global id order, partitioning slows the read path. Even the rebuild win is conditional.
- **No HA replicas.** The migration to partitioned shape rewrites the table — WAL volume is significant and a non-replicated database means the migration window is the only window.
- **Single-tenant SaaS with bounded customer count.** Cap the customer-stream count via the `cardinality` close policy instead; you'll get bounded storage without the partitioning operational tax.
- **You haven't measured `close()` first.** This is the most common mistake. Operators reach for partitioning before they've actually quantified what `close()` would save them.

## If partitioning is still the answer: strategy menu

Three strategies, each with different trade-offs. None of them is "better partitioning" — they buy different properties for different problems.

| Strategy | Migration | Ongoing cost | Solves |
|---|---|---|---|
| **HASH on `stream`** | Full table copy (offline or `pg_repack`-online). Set-and-forget after. | Cross-stream queries pay MergeAppend across N partitions. Single-stream queries unaffected. | Regulated append-only audit; parallel rebuild *if* the benchmark supports it |
| **RANGE on `id`** | Full table copy. Ongoing: provision new partitions as the id sequence grows. | `ORDER BY id` queries can prune to one partition (the hot one). Older partitions go cold and can be moved to slower storage. | Single-aggregate giants; bounded planner cost as the table grows |
| **RANGE on `created`** | Full table copy. Ongoing: `pg_partman` (or manual cron) provisions monthly/yearly partitions. | `DETACH` + `DROP` is constant-time bulk archival. Cross-stream queries pay MergeAppend. | Retention-window bulk archival in regulated domains |

Notes on each:

- **HASH on `stream`** is the workhorse if you must partition for general storage growth. A stream's events colocate in one partition, so `claim()` and single-stream reads prune cleanly. Cross-stream operations pay the MergeAppend cost — be sure you measured this on your workload before committing.

- **RANGE on `id`** is the only strategy that helps "single-aggregate giant" scenarios. It deliberately splits one stream across partitions, ordered by the global id. Recent partitions stay hot, older partitions go cold. Document-light: range partitioning is a per-app schema design (event volume, retention window, archival policy), not a turn-key recipe. The framework documents the *strategy*; the schema is yours to design.

- **RANGE on `created`** is the strategy for bulk archival by retention window. Pair with `pg_partman` for partition creation and the framework's `drop-partition.ts` runner (#853, when shipped) for the archival half of the loop. Don't use this strategy if you don't have a clean retention boundary — picking a wrong cutoff means re-partitioning later, which is the same migration cost twice.

## Costs you'll see no matter which strategy you pick

- **PK becomes composite.** Partitioning by anything other than `id` requires the partition key to be in every unique constraint. The events PK becomes `(id, partition_key)` instead of `id`. This is mechanically fine but breaks any external tooling that assumed `id` alone uniquely identifies a row.
- **Index storage.** Each index is recreated per partition. For N partitions and K indexes, you have N×K index trees instead of K. Disk overhead is small per index but non-zero.
- **`events_id_seq` is shared.** The sequence stays global so `id` monotonicity holds across partitions. This is a feature, not a cost — without it, the framework's global-order assumptions break entirely.
- **Planner overhead.** Every query consults more relations. PG ≥ 14 with `enable_partition_pruning = on` (default) caches pruned plans, so prepared statements amortize. Ad-hoc queries pay a small constant overhead per partition checked.
- **Rebuild semantics.** `app.reset(targets)` still works post-migration; the cost depends on whether your workload's hot path is single-stream (cheap) or cross-stream (MergeAppend). Run the partitioning benchmark (#851) on your data shape before committing — the theoretical N× parallel speedup is rarely the observed speedup, and may not exist at all on cross-stream-dominated workloads.

## Recipes

The framework ships recipes for the strategies that have a clean turn-key implementation. Range-based schema design is yours to own.

- **HASH partitioning** — migration script + `--confirm` runner: see *(linked from #850 once shipped — `libs/act-pg/migrations/partitioned/001_hash_partition_events.sql`)*.
- **Partition-drop archival (RANGE on `created`)** — migration + drop runner: see *(linked from #853 once shipped)*.
- **Range partitioning for single-aggregate giants** — documentation-only guidance: see *(linked from #852 once shipped)*.
- **Parallel rebuild benchmark** — observed-vs-theoretical numbers on partitioned vs unpartitioned `app.reset`: see *(linked from #851 once shipped → `libs/act-pg/PERFORMANCE.md`)*.

## If you remember one thing

Partitioning is the answer to a problem most Act apps don't have. It is operationally heavy, fights against event sourcing's global-`id` ordering on the cross-stream read path, and almost always costs more than it saves unless the workload genuinely belongs to one of the four extreme cases above.

`Act.close()` — manual or via the `.autocloses(...)` policy from epic #802 — is the right answer for the dominant workload. Reach for partitioning only after you've ruled close out, measured the cost, and confirmed that your workload is the narrow exception that justifies the operational tax.
