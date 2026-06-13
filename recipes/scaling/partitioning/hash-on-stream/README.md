# HASH-on-stream partitioning

This recipe converts an unpartitioned `events` table into one that lives behind
`PARTITION BY HASH (stream)`. The events stay logically one table, the global
`id` sequence stays shared, and `claim()` / single-stream reads still prune to
one partition. What changes is how the storage is laid out underneath: instead
of one giant heap and one giant set of B-trees, you get N smaller heaps and N
smaller B-trees, one per hash bucket.

Default Act is fine for most apps. You shouldn't be here unless the gating
page at [recipes/scaling/partitioning/README.md](../README.md) has already
walked you through the four extreme cases and you've concluded yours is case #1
(regulated / append-only audit logs where `.autocloses(...)` isn't an option).
If your events table can be kept in steady state by `Act.close()` — explicit or
via [.autocloses(...)](../../../../docs/docs/guides/close-policies.md) — close
the tab and reach for that instead. This recipe will cost you more than it
saves.

## When to reach for it

Case #1 from the gating page is the canonical fit: a regulated or append-only
audit log where deletion (even tombstone-shaped deletion) isn't acceptable to
your auditors, and the events table is consequently going to grow monotonically
forever. The operational wins HASH partitioning buys you in that scenario:

- **VACUUM concurrency.** Autovacuum runs per-relation. One unpartitioned table
  means one autovacuum worker walks the whole heap; N partitions means up to N
  workers walking N smaller heaps in parallel, and a long-running VACUUM on one
  bucket doesn't block the others.
- **Smaller B-tree depth.** A B-tree on K rows has height roughly
  `log_fanout(K)`. Splitting K across N partitions reduces the per-tree height
  by approximately `log_fanout(N)` — on commodity workloads this is in the
  ballpark of one level (around 20% shorter trees on 16 partitions for
  realistic fanouts). Each lookup does one fewer page hop.
- **Fresher planner stats.** ANALYZE costs scale with table size. Smaller
  partitions get re-sampled more often within the same autovacuum budget, so
  cardinality estimates stay closer to reality on the hot single-stream path.

These are operational wins, not algorithmic wins. The framework's hot read
paths (`claim()`, single-stream `load`, single-stream `commit`) were already
fast on the unpartitioned table. What you're buying here is **better tail
latency under sustained growth**, not lower median latency. If your audit log
isn't growing fast enough to make VACUUM and index height into operational
problems, HASH partitioning will make your life worse, not better.

There are no measured framework benchmarks for HASH-on-stream on a real
audit-log workload yet; the parallel-rebuild benchmark in
[libs/act-pg/PERFORMANCE.md](../../../../libs/act-pg/PERFORMANCE.md) covers the
rebuild-throughput question, not the steady-state-VACUUM question. Measure on
your own data shape before committing.

## What it does NOT solve

Quoting the gating page so you don't have to switch tabs:

- **Single-aggregate giants** (case #2). "One stream with millions of events on
  a single business-domain aggregate — a long-running ledger for one regulated
  entity, an audit trail for a critical workflow that runs for a decade, a
  compliance event log for a single legal entity." HASH partitioning by
  `stream` does not help here: all the events for one stream hash to the same
  bucket and land in one partition.
  You'd be growing one partition without bound while the others sit empty. See
  [recipes/scaling/partitioning/range-on-id/README.md](../range-on-id/README.md)
  if this is your problem.
- **Bulk archival with retention windows** (case #3). HASH partitions can't be
  dropped — every bucket holds events from every retention period mixed
  together. If your problem is "delete everything older than 18 months in
  constant-time DDL," you need RANGE on `created`, not HASH on `stream`. See
  [recipes/scaling/partitioning/range-on-created/README.md](../range-on-created/README.md).
- **Cross-stream read latency.** HASH partitioning makes every cross-stream
  query pay MergeAppend across N partitions. The drain pipeline, projection
  advance, and `app.reset()` all read in global `id` order across many streams.
  HASH won't make these faster; it makes them measurably slower in exchange for
  the VACUUM and B-tree wins above. The trade is worth it for an audit-log
  workload that's dominated by single-stream commit traffic. It is **not** worth
  it for a workload dominated by projection rebuilds or cross-stream reads.

## Schema changes

The post-migration shape matches the unpartitioned schema in
`libs/act-pg/src/postgres-store.ts` (lines 365–455) on every observable column,
with three structural differences forced by PG's partitioning rules:

1. **Primary key becomes `(id, stream)`.** PG requires the partition key to be
   in every unique constraint. The partition key here is `stream`, so the PK is
   composite. External tooling that assumed `id` alone uniquely identifies a
   row needs updating — within Act itself this is fine because the framework
   never asserts row-identity by `id` alone.
2. **Indexes are partitioned.** The four existing indexes — unique
   `(stream, version)`, `(name)`, `(created, id)`, and
   `((meta ->> 'correlation'))` — are recreated as partitioned indexes that the
   planner propagates to every child partition. Each child gets its own
   physical B-tree.
3. **The `events_id_seq` sequence is preserved verbatim.** Never recreate it.
   The migration ends with a `setval(...)` to advance the sequence past the
   highest copied `id`. Recreating the sequence would silently break global
   `id` monotonicity, which is load-bearing for drain, projections, and
   `app.reset()`. See [docs/docs/architecture/cache-and-snapshots.md](../../../../docs/docs/architecture/cache-and-snapshots.md)
   for why monotonicity matters.

The `streams` table is **not partitioned** by this recipe. It's small, the
`claim()` index pattern (`blocked, priority DESC, at`) doesn't benefit from
hashing, and partitioning it would force every claim query to MergeAppend
across buckets. Leave it alone.

## The workflow

This is the operational workflow. Run it during a maintenance window with a
recent backup at hand. The forward migration is split across two phases: a
concurrent online phase that copies bulk data with reads and writes flowing
normally, and a brief atomic swap that takes an `ACCESS EXCLUSIVE` lock to
drain the last few rows and rename the tables.

### Phase 0: Pre-flight

Cheap checks before any DDL. The goal is to fail fast and loudly if the
environment doesn't match the recipe's assumptions. Verify in order:

- **PostgreSQL version ≥ 14.** Earlier versions lack `enable_partition_pruning`
  on by default and have weaker MergeAppend behavior. The migration may still
  succeed on 12/13 but you'll lose the planner improvements that motivate the
  trade.
- **Free disk space ≥ 2× the current `events` table.** The bulk copy holds
  both the source and the partitioned target on disk until the swap completes.
  Run `SELECT pg_size_pretty(pg_total_relation_size('{{schema}}.{{table}}'))`
  and confirm you have headroom.
- **`{{table}}_id_seq` exists and is owned by `{{schema}}.{{table}}.id`.** The
  swap relies on this sequence surviving the rename intact. Run
  `\d {{schema}}.{{table}}` and confirm the default for `id` is
  `nextval('{{schema}}.{{table}}_id_seq'::regclass)`.
- **No concurrent migration-shaped locks.** Run `SELECT * FROM pg_locks WHERE
  relation = '{{schema}}.{{table}}'::regclass` and confirm only short-lived
  row locks are held. A long-running `CREATE INDEX` or `CLUSTER` will fight
  the migration.
- **The application can tolerate a brief write pause** during Phase 2's swap.
  The swap holds `ACCESS EXCLUSIVE` for the time it takes to drain late rows
  and rename the tables — typically seconds, not minutes, but commit traffic
  will queue during the window. Drain `claim()` workers ahead of the swap if
  your business can't tolerate the queue depth.

If any check fails, stop. Fix the underlying condition and re-run pre-flight.
Do not start Phase 1 until every check passes.

### Phase 1: Build the partitioned shape (online)

This phase runs with reads and writes flowing normally to the existing table.
The `forward.sql` file in this directory:

1. Creates the partitioned target table as `{{table}}_partitioned` with the
   composite PK and the partition definition `PARTITION BY HASH (stream)`.
2. Creates 16 child partitions, one per `MODULUS 16 / REMAINDER 0..15` bucket.
   Tune the partition count below.
3. Creates the four partitioned indexes that propagate to every child.
4. Bulk-copies every row from the current `events` table into the partitioned
   target with a single `INSERT INTO ... SELECT * FROM ...`. PG routes each row
   to the correct child based on `hash(stream) % 16`.

The bulk copy is the slow step. On commodity PG 17 + NVMe SSD, expect a
sustained 10k–30k rows/sec throughput for a table with the Act events shape
(small `jsonb` payloads, the four standard indexes). For a 100M-row events
table, plan for **1–3 hours** of online copy. The system stays available
throughout: writes continue to land in the source table; the new rows that
land during the copy are picked up in Phase 2's drain step.

During Phase 1 you should monitor:

- **WAL pressure.** The copy generates roughly 1× the table's heap size in WAL.
  If you have streaming replicas, watch their lag — pause the copy if a replica
  falls behind your RPO.
- **Autovacuum on the source.** The copy doesn't change the source's
  modification rate, so autovacuum should be unaffected, but a long-running
  open transaction (which `INSERT INTO ... SELECT` is) prevents VACUUM from
  reclaiming dead tuples on the source until the copy commits.
- **Disk usage.** This is the moment of peak disk pressure. The forward.sql
  file is conservative — it uses a single bulk insert. If your disk budget is
  tight, see "Tuning" below for the chunked-copy variant.

### Phase 2: Atomic swap

Once Phase 1's bulk copy completes, the partitioned target has every row that
was in `events` at the moment Phase 1 started, plus zero rows that landed
since. The swap step in `forward.sql`:

1. Takes `LOCK TABLE {{schema}}.{{table}} IN ACCESS EXCLUSIVE MODE`. New writes
   block, in-flight transactions are allowed to finish.
2. Drains late rows — copies every row in the source with `id` greater than the
   max `id` already in the partitioned target. This catches everything that
   landed during the Phase 1 copy.
3. Calls `setval('{{schema}}.{{table}}_id_seq', <max_id>, true)` to advance the
   shared sequence past every copied `id`. The sequence is **not recreated** —
   only advanced.
4. Renames `{{table}}` to `{{table}}_pre_partition_backup` and renames
   `{{table}}_partitioned` to `{{table}}`.
5. Commits, releasing the `ACCESS EXCLUSIVE` lock.

The swap holds the lock for the duration of the late-row drain plus the two
renames. If Phase 1 finished close to "right now" the drain is a few thousand
rows at most and the lock window is on the order of seconds. If Phase 1
finished hours ago and traffic has been heavy, the drain may run minutes —
plan accordingly.

### Phase 3: Verify + report

After the swap commits:

- **Row counts match.** `SELECT count(*) FROM {{schema}}.{{table}}` against
  `SELECT count(*) FROM {{schema}}.{{table}}_pre_partition_backup`. They should
  be equal; differences indicate the late-row drain missed something and
  require investigation before declaring success.
- **Sequence advances correctly.** Issue a `SELECT nextval('{{schema}}.{{table}}_id_seq')`
  and confirm the returned value is greater than the max `id` in the new
  partitioned table. The next real commit should also land cleanly.
- **Partition distribution is roughly even.** Run
  `SELECT tableoid::regclass, count(*) FROM {{schema}}.{{table}} GROUP BY 1`
  and confirm the counts are within ~10% of each other across partitions.
  Severe skew indicates pathological stream-name distribution and the recipe
  isn't buying what it promised.
- **Backup table preserved.** `{{table}}_pre_partition_backup` is still there,
  on disk, unmodified. Do not drop it until you've run the application for at
  least a week against the partitioned shape with no surprises. Disk is
  cheaper than re-running the migration.

## Rollback workflow

Rollback exists for the case where the partitioned shape breaks production in
a way you can't tune around. It is **not** an online operation: it requires a
maintenance window with paused writes. The `rollback.sql` file:

1. Takes `ACCESS EXCLUSIVE` on the now-partitioned `{{table}}`.
2. Renames the current backup `{{table}}_pre_partition_backup` → no-op if you
   want to keep the original under that name; otherwise rename it back to a
   new backup slot like `{{table}}_pre_rollback_backup`.
3. Renames the partitioned `{{table}}` → `{{table}}_post_partition_backup`.
4. Restores the pre-partition table by renaming it back to `{{table}}`, or
   alternatively bulk-copies every row from the partitioned table into a fresh
   unpartitioned `{{table}}` if you want to keep writes that landed
   post-partition.
5. Sets the sequence forward past the max `id` in the restored table.

**The rollback can pull writes that landed post-partition** if you choose the
copy-from-partitioned variant. The simpler variant (rename the original back)
discards every event written after the original swap — only choose it if you
caught the breakage within the first few minutes and your application can
tolerate replaying the lost commits.

You **cannot** roll back online. The schemas differ in the PK shape, the
indexes are physically distinct, and PG has no in-place "unpartition" operation.
Plan the rollback window the same way you planned the forward window: backup,
maintenance announcement, paused writes.

## Safety rails

- **Two backups exist at the end.** After the forward migration,
  `{{table}}_pre_partition_backup` is on disk. After a rollback,
  `{{table}}_post_partition_backup` is on disk. Keep both until you're certain
  you don't need to revisit.
- **The sequence is never recreated.** Only `setval` advances it. This is the
  single most important invariant. Recreating `{{table}}_id_seq` would silently
  break global `id` monotonicity, which would in turn break drain ordering,
  projection watermarks, and `app.reset()`. The `forward.sql` and `rollback.sql`
  files never issue `CREATE SEQUENCE` or `DROP SEQUENCE` against this name.
- **The `streams` table is untouched.** Claim semantics, lane assignments,
  blocked flags, retry counters — all preserved verbatim. The forward
  migration touches the events table only.
- **Every cheap validation runs before any DDL.** Pre-flight is row-count and
  metadata queries; nothing is written until you pass every check. If something
  is off, you find out before you've committed any irreversible action.
- **Pre-flight runs in its own session.** Don't reuse the pre-flight session
  for the forward migration — a stale catalog snapshot can mask a problem that
  appeared between checks.

## Tuning: `--partitions N`

The default partition count is **16**. This is the sweet spot for the
target workload (regulated audit log, growth-dominated, single-stream traffic):

- **Uniform distribution.** 16 buckets with a reasonably well-distributed
  `stream` name space gives each bucket roughly 1/16 of the rows. The standard
  hash function in PG is good enough that you'd need pathological stream names
  (e.g., everyone hashing to the same bucket because they share a prefix and
  the hash collapses) to see severe skew, and `hash_text` doesn't have that
  failure mode.
- **Enough parallelism for VACUUM.** Modern PG instances run at least 3
  autovacuum workers; 16 partitions means a busy table can keep 3 workers
  busy without one of them holding up the others.
- **Not enough to overwhelm the planner.** Every cross-stream query consults
  every partition (modulo pruning). At 16 partitions the MergeAppend cost is
  noticeable but manageable; at 64+ the planner overhead starts to dominate
  for short queries. The PG documentation's general guidance is "hundreds of
  partitions is fine for big-table workloads, thousands is questionable" — but
  Act's MergeAppend-heavy read path is more sensitive than that, so the
  practical cap is lower.

Acceptable bounds are **[2, 64]**. Below 2 you have one partition and you've
done all this work for nothing; above 64 the planner overhead on cross-stream
reads starts being visible in p95 latency and you've crossed into "measure
yourself or regret it" territory. The `run.sh` wrapper validates the bound and
fails fast if you pass anything outside.

If you have specific tenant-shaped traffic patterns (e.g., 90% of writes go to
3 hot streams) HASH partitioning won't fix that — the hash will distribute the
hot streams across buckets but each hot stream's traffic still concentrates in
one bucket. Consider whether the gating page's case #2 (single-aggregate
giants) is closer to your problem than case #1.

## Cross-references

- [Gating page](../README.md) — the four cases this recipe doesn't solve.
- [Close-the-books recipe](../../close-the-books/README.md) — the path you
  should try first.
- [Archival recipe](../../archival/README.md) — for retention-window cases.
- [.autocloses(...) syntax](../../../../docs/docs/guides/close-policies.md) —
  declarative close policies.
- [Production checklist](../../../../docs/docs/guides/production-checklist.md)
  — operational baseline.
- [PG perf data](../../../../libs/act-pg/PERFORMANCE.md) — measured numbers
  for the PG adapter.
- [Core perf data](../../../../libs/act/PERFORMANCE.md) — measured numbers for
  the core framework.
