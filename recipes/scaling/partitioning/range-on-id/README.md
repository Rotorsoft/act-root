# RANGE partitioning on `id` — for single-aggregate giants

This recipe is **notes-only**. No SQL file ships alongside it, no migration runner, no `--confirm` script. The strategy is documented; the schema is yours to design.

If that feels like a cop-out, read the last section first. The short version: the boundaries that make this strategy work are operator-specific in a way the others aren't, and a templated migration would lie about its own applicability.

Default Act is fine for the overwhelming majority of apps. This recipe exists for one specific shape of pain.

## What this recipe addresses

This is the answer to case #2 from [the gating page](../README.md):

> **Single-aggregate giants.** One stream with millions of events on a single aggregate — a long-running ledger for one regulated entity, an audit trail for a critical workflow that runs for a decade. The aggregate can't be closed because the business still treats it as alive. HASH partitioning by `stream` does not help here (all the events for one stream land in one partition); range partitioning by `id` might.

Act targets business applications, so the "giant" here is a business-domain aggregate that legitimately accumulates events over years, not high-frequency telemetry (which doesn't fit Act's model in the first place — see the top-level [`recipes/README.md`](../../../README.md) for why). Concrete shapes that fit:

- A regulated entity's master ledger that books transactions across the lifetime of the business. The stream is the entity; closing it means closing the entity.
- A workflow audit trail for a single long-running process — a clinical trial, a multi-year procurement contract, a credit facility — where the workflow is one durable thing and the audit is its history.
- A compliance event log for a single legal entity that must retain every regulated event for the lifetime of the relationship.

Notice what these have in common. The stream cardinality is **small** (often one). The per-stream event count is **enormous over time** (years, not seconds). And closing the stream is not on the table: the business still treats the aggregate as alive.

## Why HASH partitioning doesn't help

The instinct is to reach for [HASH on `stream`](../hash-on-stream/README.md) because it's the workhorse. For the single-aggregate-giant case, it does nothing useful.

HASH on `stream` partitions events by `hashtext(stream) mod N`. Every event for a given stream lands in the same partition, every time. That property is what makes HASH good for the regulated-audit case — `claim()` and `commit()` on a single stream prune to one partition cleanly, and operators with thousands of streams see the events distributed across N partitions evenly.

The giant stream is the pathological input to that scheme. It hashes to **one** partition. That partition holds every event for the giant. The other N-1 partitions sit nearly empty, holding the residue of whatever other streams the system has. You paid the full partitioning operational tax — composite PK, MergeAppend on cross-stream reads, planner overhead — and got a single 100M-row partition for your trouble. Same problem, more moving parts.

HASH partitions by stream identity. To help a single-stream giant you need to partition by something **inside** that stream.

## Why RANGE on `id` works

The events `id` is a global monotonic sequence. For one append-heavy stream, ids arrive in roughly time order — id 1M happens earlier than id 50M happens earlier than id 200M. So a range on `id` is implicitly a range on time, even though the partition key is the integer sequence.

Splitting the giant stream's events across id-ranged partitions gives you three properties HASH can't:

1. **A small hot partition.** The newest partition holds only the most recent slice of ids. For an append-heavy workload, that's the only partition that takes writes. Its index height stays low, its working set fits in `shared_buffers`, and per-event commit latency stays close to what it was on day one.
2. **Cold partitions that can move.** Older partitions are read-mostly or read-never. You can `ALTER TABLE ... SET TABLESPACE` them onto cheaper storage (slow disk, network volume, archival tier) without affecting the hot path.
3. **Single-partition pruning on recent reads.** A `load()` that wants "the latest version of this stream" reads the tail. The planner prunes to the newest partition. A targeted `query` with `after: someId` prunes to whatever partition `someId` lives in. The ratio of pruned-to-MergeAppend reads on this workload is unusually favorable because the workload is unusually skewed.

You're still paying MergeAppend for any cross-stream read in `id` order. That cost is real. On the single-aggregate-giant shape it's tolerable because cross-stream reads are rare — the system has one stream that matters and a handful of bookkeeping streams that don't.

## The trade-off — partition maintenance

HASH is set-and-forget. You pick N, run the migration, and never think about partitions again.

RANGE on `id` is **not** set-and-forget. The id sequence keeps growing. Every partition you create has an upper bound, and once the sequence reaches that bound, the next insert needs a new partition that doesn't exist yet. If it isn't provisioned, the insert fails.

You have three honest options:

- **`pg_partman`.** Postgres extension that owns partition lifecycle — premake N partitions ahead of the sequence, drop expired partitions on a schedule. It speaks RANGE-on-integer natively. This is what you almost always want.
- **A cron job.** A nightly script that checks the current `events_id_seq` value and creates the next partition when the sequence is within X% of the top of the current partition. Operationally simpler than `pg_partman`, less robust under bursty ingest.
- **Manual provisioning during a maintenance window.** Defensible if your event rate is predictable enough that you'll provision a year's worth of partitions in one go. Don't choose this without a calendar reminder.

If none of those options feels acceptable, partitioning is probably not the answer for you. Go back to [the gating page](../README.md) and re-read the "when not to partition" section.

## Sketch of the strategy

What follows is a design pattern, not a migration script. The numbers are placeholders.

**Decide a boundary size.** A typical choice is 10M ids per partition, but it depends entirely on your ingest rate and how long you want each partition to stay hot. If the giant stream emits an event per second, 10M ids is about four months of data. If it emits a hundred per second, 10M ids is about a day, and you'll want a much larger boundary or a faster provisioning cadence.

A good rule of thumb: size the partition so the hot partition's working set (events + indexes) comfortably fits in `shared_buffers` for the duration it's the hot one. If `shared_buffers` is 8 GB and your events average 200 bytes on disk including indexes, that's about 40M rows of headroom. Pick a boundary smaller than that and you'll never see the hot path leave memory.

**At migration time:**

```sql
CREATE TABLE {{schema}}.{{table}}_new (
  id          serial NOT NULL,
  name        varchar(100) NOT NULL,
  data        jsonb,
  stream      varchar(100) NOT NULL,
  version     int NOT NULL,
  created     timestamptz NOT NULL DEFAULT now(),
  meta        jsonb,
  pii         jsonb,
  PRIMARY KEY (id)
) PARTITION BY RANGE (id);
```

Note the PK stays `(id)` — RANGE on `id` is the only strategy where the partition key is the existing primary key, so no composite PK is forced on you. External tooling that joins on `events.id` keeps working as-is.

Then create child partitions for the existing id ranges (`FROM (0) TO (10000000)`, `FROM (10000000) TO (20000000)`, ...) up through the current top of the sequence, plus one or two empty future partitions, then copy data, swap names, and recreate indexes per-partition. The full schema (columns, the `(stream, version)` unique constraint, the `(created, id)` index, the `(name)` index, the correlation index) needs to be reapplied on the partitioned table.

**Going forward:** `pg_partman` (or a cron) provisions the next partition before the sequence reaches the top of the current one. You don't need a runtime hook in your app; this is a database-level concern.

## Operational concerns

**Cold-storage migration.** Older partitions can move to cheaper storage with `ALTER TABLE {{schema}}.{{table}}_p_000000000 SET TABLESPACE cold_tier`. Reads still work, they're just slower. For the giant-stream case, "slower reads on history nobody asks for" is exactly the trade you want.

**If you ever DROP an old partition, the consistency rules from the gating page apply.** Range-on-id partitions are usually moved to cold storage rather than dropped — the strategy is built around "keep everything, just stratify it." But operators sometimes drop the oldest range when retention policy says so, or when cold storage itself reaches its budget. The moment you do, you're in the same territory as range-on-created's drop path: every alive stream with events in the dropped range needs a `__tombstone__` (`app.close()` / `.autocloses({...})`) or a `__snapshot__` (`app.snap()` / state-level `.snap` predicate) **outside** the dropped range, or `app.load()` for that stream silently returns wrong state. See [the gating page's consistency section](../README.md#consistency-cost-when-a-strategy-involves-drop-partition) for the full explanation and the pre-flight check pattern. The recipe doesn't ship a drop runner for range-on-id because the cut points are app-specific; if you write one, copy the consistency guard from `recipes/scaling/partitioning/range-on-created/drop-partition.sql` and adapt the cutoff column from `created` to `id`.

**Projection rebuild.** `app.reset(targets)` still works post-migration. It walks every partition in id order via MergeAppend, the same way an unpartitioned table would walk in id order. If the projection reads only the giant stream, the planner prunes the unrelated partitions (there aren't any — RANGE on `id` doesn't distinguish by stream). If the projection has a watermark, you can prune cold partitions out of the rebuild manually by capping the `id >= start_id` clause, which is cheap to do but requires changes outside the framework.

**Cross-stream reads pay MergeAppend.** Same trade as HASH. If you have a healthy fraction of cross-stream reads — drain, reactions across many streams, dashboards — measure them on your shape before committing. The PG perf data at [`libs/act-pg/PERFORMANCE.md`](../../../../libs/act-pg/PERFORMANCE.md) was measured on unpartitioned tables; expect cross-stream queries to slow by some MergeAppend constant per partition crossed.

**VACUUM behavior changes.** Per-partition autovacuum runs independently. The hot partition will autovacuum often; cold partitions rarely. This is usually an improvement over the unpartitioned shape, where one autovacuum had to consider the whole table — but it does mean your monitoring needs to know the partition layout to make sense of vacuum metrics.

## When this strategy does NOT fit

- **You have many active streams.** Use [HASH on `stream`](../hash-on-stream/README.md) instead — RANGE on `id` gives you nothing if the events are already distributed across thousands of streams.
- **You have one giant + you want global id parallelism on rebuild.** RANGE on `id` doesn't parallelize rebuild — MergeAppend is sequential by id. The rebuild-bench territory belongs to HASH, and even there the speedup is conditional on the shape. See the partitioned-vs-unpartitioned numbers logged with #851 in [`libs/act-pg/PERFORMANCE.md`](../../../../libs/act-pg/PERFORMANCE.md).
- **`close()` would have worked.** Re-read [`docs/docs/guides/close-policies.md`](../../../../docs/docs/guides/close-policies.md). Most "long-lived" aggregates have unused terminal events. Closing the stream — manually or via `.autocloses({ is: "DeviceRetired" })` — is dramatically cheaper than partitioning.
- **Your hot path is cross-stream.** If drain and reactions read across many streams, partitioning costs you on the read path. Range-on-id only pays off when the workload is dominated by appends and tail-reads on the giant stream.
- **You don't actually have a giant yet.** Provision-as-you-go works fine in an unpartitioned table up to ten million rows or so. Don't pre-partition for a problem you don't have.

## Why no migration script

The other recipes in this folder ship templated SQL — `{{schema}}`, `{{table}}`, a few parameters at the top, and a `sed`-friendly file an operator can adapt in an hour. For range-on-id, a template would lie.

The numbers that make this strategy work — partition boundary size, current id watermark, ongoing-maintenance choice, cold-tier tablespace policy, whether `pg_partman` is allowed in your environment — are all operator-specific. A 10M-id-per-partition template would be wrong for a workload doing a hundred events per second and equally wrong for a workload doing one. The migration shape changes depending on how much downtime you can take, whether you have a replica to fail over to, and whether your audit trail has any cross-stream correlations you need to preserve order on.

What we can ship honestly is the **strategy**: partition by RANGE on `id`, pick a boundary that fits your hot partition into `shared_buffers`, automate the provisioning, accept that cross-stream reads pay MergeAppend. From there, the schema is a one-off design that belongs in your repo, not the framework's.

If you want a starting point for the SQL itself, the [HASH on `stream` recipe](../hash-on-stream/README.md) is the closest template — same partitioning mechanics, different key. Use it as a structural reference and adapt the partition definitions.

## Pointers

- [Postgres partitioning documentation](https://www.postgresql.org/docs/current/ddl-partitioning.html) — start here if you've never partitioned a Postgres table before. Section 5.11 is the canonical reference.
- [`pg_partman`](https://github.com/pgpartman/pg_partman) — the extension that owns ongoing partition lifecycle for RANGE strategies.
- [Partitioning gating page](../README.md) — re-read before committing. The "when not to partition" section catches most operators.
- [Close-the-books guide](../../../../docs/docs/guides/close-policies.md) — the strategy you should rule out before reaching this page.
- [Production checklist](../../../../docs/docs/guides/production-checklist.md) — §10 "Closing the books" and §11 "Lane sizing" cover the surface area you should have already exhausted.
- [HASH on `stream` recipe](../hash-on-stream/README.md) — for many-active-streams workloads, or as a structural reference for the SQL.
