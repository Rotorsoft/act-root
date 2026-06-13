# RANGE partitioning on `created` — retention-window archival

> **Default Act is fine for most apps.** If your events table isn't measured
> in hundreds of millions of rows, if your retention window is governed by
> business policy rather than a regulator, or if you haven't already wired
> `.autocloses({...})` and watched it fail to keep up — this recipe isn't
> for you. Read [recipes/scaling/partitioning/README.md](../README.md)
> first; it's a series of gates that exist precisely so this page is
> reached on purpose, not by accident.

## What this recipe does

It rewrites the `events` table as a `PARTITION BY RANGE (created)` table
with one child partition per month (or year — your call). Every event
lands in the partition for the month it was committed. Once a partition
falls fully behind your retention window, you `DETACH` it, copy the
detached child to cold storage, and `DROP` it. The DDL is constant-time
regardless of partition size, so dropping 50 million rows costs the same
as dropping 50 thousand. A periodic cron — driven by `drop-partition.sql`
in this folder — turns the events table into a sliding window that never
grows past the retention boundary.

It also ships:

- `forward.sql` — the one-shot migration from unpartitioned to
  partitioned, structured in the same Phase 1 (build + copy) / Phase 2
  (atomic swap) shape as the HASH recipe.
- `run.sh` — a thin wrapper that substitutes `{{schema}}` / `{{table}}`
  placeholders and pipes the forward migration to `psql` with
  `ON_ERROR_STOP=1`. Does **not** wrap `drop-partition.sql` — that's
  cron-driven, has different failure modes, and shouldn't share a
  blast radius with the migration.
- `drop-partition.sql` — the archival half. Detach + (operator-wired)
  cold-storage dump + drop, scoped to partitions older than a
  `{{cutoff}}` date.

## When to reach for it

The narrow set of workloads where RANGE-on-`created` earns its keep:

1. **Hard regulatory retention windows.** HIPAA requires six years
   minimum; FINRA/SEC 17a-4 wants three to seven; GDPR Article 5(1)(e)
   demands "no longer than necessary." When the regulator hands you a
   number, the events table doesn't get to grow past it. `Act.close()`
   per-row delete is too slow on the volumes that drive a regulator's
   attention in the first place.
2. **Audit-trail semantics that block `.autocloses({...})`.** An
   audit log keeps every event up to the retention boundary, then
   drops everything at once. The whole point is "no tombstones, no
   per-row decisions, just a clean cutover at the boundary." That's
   what partition-drop gives you.
3. **Bulk archival where the disk story matters.** Per-row DELETE
   leaves dead tuples that VACUUM has to chase; on a hundred-million-row
   archive run, that's hours of background I/O. `DROP TABLE` on a
   detached partition returns the disk in seconds.

If you don't fit one of those, the steady-state answer is still
`.autocloses({...})` — see
[../../close-the-books/README.md](../../close-the-books/README.md) and
the framework guide at
[docs/docs/guides/close-policies.md](../../../../docs/docs/guides/close-policies.md).

## Why `.autocloses({...})` doesn't fit here

`.autocloses({ after: { days: 365 * 6 } })` would, in principle,
truncate every stream older than six years. In practice three things
fight you:

- **Per-row work.** The autoclose cycle paginates streams, calls
  `query_stats`, builds a candidate set, runs `run_close_cycle` per
  batch. Each truncate is a per-stream `DELETE FROM events WHERE
  stream = $1`, which on a multi-hundred-million-row table touches
  index pages for every row it removes. The throughput ceiling is
  the index update rate, not the row count.
- **Tombstones stay behind.** `.autocloses({...})` leaves a
  `__tombstone__` per closed stream so subsequent commits raise
  `StreamClosedError`. For audit-trail use cases that's a feature.
  For "the regulator says this data must be physically gone," it's
  a problem: the tombstone is still a row in `events`, and some
  regulators read "I kept a marker pointing at what used to be
  there" as incomplete disposal.
- **VACUUM tail.** Even after the truncate commits, autovacuum has
  to reclaim the dead tuples. On a saturated archive run that VACUUM
  itself becomes the bottleneck.

`DETACH PARTITION` + `DROP TABLE` sidesteps all three. The DDL is
metadata-only; the dropped partition's disk pages return to the
filesystem in one extent free, no per-row touch, no VACUUM follow-up,
no tombstones in the live table. Some regulators explicitly accept
partition-drop as "physical disposal" — easier to defend in an audit
than "we ran DELETE and trust VACUUM to finish eventually."

## Trade-offs you sign up for

- **Boundary granularity is your partition size.** Monthly partitions
  mean you can dispose of data with month resolution; if the regulator
  says "six years," the cleanest cutover is six years and one month
  (drop the partition once it's fully behind the window — never drop a
  partition that still has events inside the retention boundary).
  Yearly partitions give whole-year accuracy at one-twelfth the
  partition count. Pick based on how tight the retention boundary is
  and how often you want to run the dropper.
- **Cross-stream queries pay MergeAppend.** Every drain, every
  projection advance, every `app.reset()` opens every partition,
  sorts each by `id`, and merges. PG ≥ 14 with
  `enable_partition_pruning = on` (default) handles this competently
  for prepared statements; the overhead is per-partition planner work,
  linear in partition count. With a 6-year monthly partition layout
  you're paying 72-way MergeAppend on every cross-stream read. This is
  the same trade described in
  [../README.md](../README.md) — read it once, then accept it as the
  price of partition-drop archival.
- **Ongoing partition provisioning.** The migration creates a window
  of child partitions (the template ships 24 months back + 12 months
  forward). After that, you need either
  [`pg_partman`](https://github.com/pgpartman/pg_partman) on a cron
  or a hand-rolled "create next month's partition" job. If a commit
  arrives for a month that doesn't have a partition, the insert fails
  with `no partition of relation "{{table}}" found for row`. Wire
  monitoring on that error early.
- **PK becomes composite.** Postgres requires the partition key to
  appear in every unique constraint, so the events PK becomes
  `(id, created)` instead of `id`. Mechanically fine — Act only ever
  reads `id` as a watermark, and the framework's `Store` contract
  doesn't promise `id` is the sole PK — but any external tooling that
  joined on `id` alone needs to be reviewed.
- **Backups and replicas need rechecking.** Partitioned tables affect
  `pg_basebackup` chunk boundaries, logical replication publication
  semantics (each child is its own publishable relation), and any
  point-in-time recovery target you computed against the old shape.

## Workflow

### Phase 0 — pre-flight

The same gates as the HASH recipe apply, plus one:

- **PG ≥ 14.** Partition pruning at execution time and
  `DETACH PARTITION CONCURRENTLY` both need PG 14+.
- **Disk headroom for 1.5× the events table.** Phase 1 copies the
  whole table into a new partitioned shell before the swap. Peak
  disk during the migration is "old table + new table + indexes" —
  budget for at least 1.5× the current `pg_total_relation_size`,
  measured during a representative workload.
- **A maintenance window long enough for the copy.** Order-of-
  magnitude: on a commodity NVMe + PG 17 instance the `INSERT INTO ...
  SELECT FROM` rate is roughly 50–200k rows/sec, dominated by index
  builds on the new partitions. Measure on a restored backup before
  picking the window.
- **No concurrent DDL or long-running transactions.** Phase 2 takes
  `ACCESS EXCLUSIVE` on the old table briefly; an open transaction
  holding even an `AccessShareLock` will block it indefinitely.
- **A backup taken with restore tested.** The atomic swap renames
  tables; a botched run is recoverable but only from a backup.
- **A planned partition-provisioning solution.** Decide before the
  migration whether you're using `pg_partman` or a custom cron job.
  Don't leave it as a follow-up — the first month after the migration
  ends is the deadline.

### Phase 1 — migrate

`forward.sql` handles the migration. Drive it via `run.sh`:

```sh
SCHEMA=public TABLE=events ./run.sh
```

Phase 1 of the script builds the new partitioned table
(`{{table}}_new`), creates 36 child partitions (24 back + 12 forward
— adjust the boundaries to your retention shape), creates the
indexes on the parent, and copies the events table contents with a
single bulk `INSERT INTO ... SELECT FROM`.

Phase 2 takes `ACCESS EXCLUSIVE` on the source table, replays any
late rows committed during Phase 1, advances `events_id_seq` past
the watermark, and renames the tables in one transaction. The
`streams` table is untouched (partitioning is on `events` only).

### Phase 2 — recurring archival

Once partitioning is live, set up a cron job — daily is the usual
cadence — that runs `drop-partition.sql` with a cutoff based on the
retention boundary:

```sh
# Daily at 03:00, drop partitions whose upper bound is older than 6 years.
0 3 * * * SCHEMA=public TABLE=events CUTOFF=$(date -d "6 years ago" +%Y-%m-01) psql ...
```

The script is destructive — see the archival pattern below before
wiring it.

## The archival pattern

`drop-partition.sql` documents the safe sequence; the operator wires
the cold-storage step. The pattern is three phases, in order, per
partition:

1. **`ALTER TABLE ... DETACH PARTITION`** — removes the child from
   the partitioned table. The partition is still a regular table on
   disk; it just doesn't participate in queries against the parent
   anymore. Read access still works directly against the detached
   table name.
2. **Cold-storage dump.** `pg_dump` the detached child to S3 / GCS /
   tape / whatever your retention policy actually requires. The
   recipe leaves this as a commented-out hook because the destination
   is operator-specific. Verify the dump completed and the bytes
   landed in cold storage **before** moving to step 3 — once you've
   dropped the partition there's no second chance.
3. **`DROP TABLE`** — the detached partition is now a regular table;
   dropping it frees the disk extents in one DDL operation.

The three-step shape exists because each step has a different
failure mode. `DETACH` is reversible (`ATTACH PARTITION` back, if
the child is still on disk and untouched). The dump is retryable —
re-run it if it failed, the partition is detached but intact. The
drop is irreversible — once the table is gone, the only path back
is the cold-storage copy you took in step 2.

If your regulator accepts partition-drop as physical disposal and
you don't need a long-term cold-storage copy, you can skip step 2
and go straight from `DETACH` to `DROP`. Document that decision —
the next operator (or auditor) will want to know why step 2 is
missing.

## What this recipe is NOT

- **Not a backup strategy.** Backups need point-in-time recovery,
  cross-region replication, restore-tested cadences. Partition-drop
  archival is one-way: once the partition is gone, the data is gone
  from the live database. Pair it with a real backup pipeline.
- **Not real-time replication.** If a downstream system needs the
  archived events queryable, archive them somewhere queryable
  (Parquet on S3, Snowflake, BigQuery) before the drop. The
  `recipes/scaling/archival/README.md` recipe covers the
  "keep-it-queryable" path; this one is for the "regulatory
  disposal" path.
- **Not for streams that should stay queryable from the app.** Once
  the partition is dropped, `app.load(stream)` for a stream whose
  events lived only in that partition will return an empty array.
  The framework has no way to know the events used to exist.
  Streams that should stay queryable belong outside the retention
  window or in the always-current partition.
- **Not a substitute for `.autocloses({...})`.** Inside the
  retention window, `.autocloses({...})` is still the right tool
  for keeping individual stream sizes bounded. Range-on-created
  governs the table-wide retention floor; autocloses governs the
  per-stream rotation. They compose — close streams as they go
  terminal, drop whole partitions when they age out.

## Pointers

- Decision tree that landed you here:
  [../README.md](../README.md)
- Default close-the-books path:
  [../../close-the-books/README.md](../../close-the-books/README.md)
- Cold-storage archival (keep-it-queryable):
  [../../archival/README.md](../../archival/README.md)
- Framework guide for `.autocloses({...})`:
  [../../../../docs/docs/guides/close-policies.md](../../../../docs/docs/guides/close-policies.md)
- Production checklist (where partition planning fits in the
  larger operational picture):
  [../../../../docs/docs/guides/production-checklist.md](../../../../docs/docs/guides/production-checklist.md)
- `act-pg` benchmark history (so you know what "fast" looks like
  on the unpartitioned baseline before you decide it's not enough):
  [../../../../libs/act-pg/PERFORMANCE.md](../../../../libs/act-pg/PERFORMANCE.md)
