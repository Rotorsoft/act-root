-- =============================================================================
-- HASH-on-stream partitioning: forward migration
-- =============================================================================
--
-- What this file does
--   Converts an unpartitioned Act events table into one partitioned by
--   HASH (stream) with 16 child partitions. Streams table is untouched.
--   The shared events_id_seq is preserved (advanced, never recreated).
--
-- Placeholders to substitute (use sed / envsubst before piping to psql)
--   {{schema}}      schema name (matches PostgresConfig.schema)
--   {{table}}       events table name (matches PostgresConfig.table)
--
-- Pre-state
--   Regular (unpartitioned) table {{schema}}.{{table}} with the standard
--   Act events schema:
--     id serial PRIMARY KEY,
--     name varchar(100), data jsonb,
--     stream varchar(100), version int,
--     created timestamptz, meta jsonb, pii jsonb
--   Standard indexes:
--     UNIQUE (stream, version)        -- {{table}}_stream_ix
--     (name)                          -- {{table}}_name_ix
--     (created, id)                   -- {{table}}_created_id_ix
--     ((meta ->> 'correlation'))      -- {{table}}_correlation_ix
--   Sequence {{schema}}.{{table}}_id_seq owns the id column.
--
-- Post-state
--   Partitioned table {{schema}}.{{table}} with composite PK (id, stream)
--   and 16 hash partitions. The original table is renamed to
--   {{schema}}.{{table}}_pre_partition_backup and left in place.
--
-- Tuning
--   This file uses MODULUS 16 (16 partitions). To change the partition count
--   N, edit the MODULUS N values in every CREATE TABLE ... PARTITION OF
--   statement below. Acceptable range is [2, 64]; outside that you should
--   reconsider whether HASH partitioning is the right strategy. The run.sh
--   wrapper handles this substitution if you set PARTITIONS=N in env.
--
-- Expected throughput
--   10k-30k rows/sec sustained copy on commodity PG 17 + NVMe SSD. For a
--   100M-row events table, plan for 1-3 hours of online copy in Phase 1.
--
-- Lock window
--   Phase 2's swap holds ACCESS EXCLUSIVE on {{schema}}.{{table}} for the
--   time it takes to drain late rows and rename two tables. Expect seconds
--   under low write load; minutes if Phase 1 ran for hours under heavy
--   write traffic.
--
-- Disk peak
--   2x the source events table during the copy window. Verify free disk
--   before starting.
--
-- =============================================================================

\set ON_ERROR_STOP on
BEGIN;

-- == Phase 1 ==
-- Build the partitioned shape and copy bulk data with reads and writes
-- flowing normally against {{schema}}.{{table}}.

-- Create the partitioned target table. Composite PK because PG requires
-- the partition key (stream) to be part of every unique constraint.
CREATE TABLE "{{schema}}"."{{table}}_partitioned" (
    id integer NOT NULL DEFAULT nextval('"{{schema}}"."{{table}}_id_seq"'::regclass),
    name varchar(100) COLLATE pg_catalog."default" NOT NULL,
    data jsonb,
    stream varchar(100) COLLATE pg_catalog."default" NOT NULL,
    version integer NOT NULL,
    created timestamptz NOT NULL DEFAULT now(),
    meta jsonb,
    pii jsonb,
    PRIMARY KEY (id, stream)
) PARTITION BY HASH (stream);

-- Create 16 child partitions. Change the MODULUS value here and on every
-- partition below if you want a different bucket count.
CREATE TABLE "{{schema}}"."{{table}}_p00" PARTITION OF "{{schema}}"."{{table}}_partitioned" FOR VALUES WITH (MODULUS 16, REMAINDER 0);
CREATE TABLE "{{schema}}"."{{table}}_p01" PARTITION OF "{{schema}}"."{{table}}_partitioned" FOR VALUES WITH (MODULUS 16, REMAINDER 1);
CREATE TABLE "{{schema}}"."{{table}}_p02" PARTITION OF "{{schema}}"."{{table}}_partitioned" FOR VALUES WITH (MODULUS 16, REMAINDER 2);
CREATE TABLE "{{schema}}"."{{table}}_p03" PARTITION OF "{{schema}}"."{{table}}_partitioned" FOR VALUES WITH (MODULUS 16, REMAINDER 3);
CREATE TABLE "{{schema}}"."{{table}}_p04" PARTITION OF "{{schema}}"."{{table}}_partitioned" FOR VALUES WITH (MODULUS 16, REMAINDER 4);
CREATE TABLE "{{schema}}"."{{table}}_p05" PARTITION OF "{{schema}}"."{{table}}_partitioned" FOR VALUES WITH (MODULUS 16, REMAINDER 5);
CREATE TABLE "{{schema}}"."{{table}}_p06" PARTITION OF "{{schema}}"."{{table}}_partitioned" FOR VALUES WITH (MODULUS 16, REMAINDER 6);
CREATE TABLE "{{schema}}"."{{table}}_p07" PARTITION OF "{{schema}}"."{{table}}_partitioned" FOR VALUES WITH (MODULUS 16, REMAINDER 7);
CREATE TABLE "{{schema}}"."{{table}}_p08" PARTITION OF "{{schema}}"."{{table}}_partitioned" FOR VALUES WITH (MODULUS 16, REMAINDER 8);
CREATE TABLE "{{schema}}"."{{table}}_p09" PARTITION OF "{{schema}}"."{{table}}_partitioned" FOR VALUES WITH (MODULUS 16, REMAINDER 9);
CREATE TABLE "{{schema}}"."{{table}}_p10" PARTITION OF "{{schema}}"."{{table}}_partitioned" FOR VALUES WITH (MODULUS 16, REMAINDER 10);
CREATE TABLE "{{schema}}"."{{table}}_p11" PARTITION OF "{{schema}}"."{{table}}_partitioned" FOR VALUES WITH (MODULUS 16, REMAINDER 11);
CREATE TABLE "{{schema}}"."{{table}}_p12" PARTITION OF "{{schema}}"."{{table}}_partitioned" FOR VALUES WITH (MODULUS 16, REMAINDER 12);
CREATE TABLE "{{schema}}"."{{table}}_p13" PARTITION OF "{{schema}}"."{{table}}_partitioned" FOR VALUES WITH (MODULUS 16, REMAINDER 13);
CREATE TABLE "{{schema}}"."{{table}}_p14" PARTITION OF "{{schema}}"."{{table}}_partitioned" FOR VALUES WITH (MODULUS 16, REMAINDER 14);
CREATE TABLE "{{schema}}"."{{table}}_p15" PARTITION OF "{{schema}}"."{{table}}_partitioned" FOR VALUES WITH (MODULUS 16, REMAINDER 15);

-- Create partitioned indexes. PG propagates these to every child partition
-- automatically; each child gets its own physical B-tree.
CREATE UNIQUE INDEX "{{table}}_partitioned_stream_ix"
    ON "{{schema}}"."{{table}}_partitioned" (stream COLLATE pg_catalog."default", version);

CREATE INDEX "{{table}}_partitioned_name_ix"
    ON "{{schema}}"."{{table}}_partitioned" (name COLLATE pg_catalog."default");

CREATE INDEX "{{table}}_partitioned_created_id_ix"
    ON "{{schema}}"."{{table}}_partitioned" (created, id);

CREATE INDEX "{{table}}_partitioned_correlation_ix"
    ON "{{schema}}"."{{table}}_partitioned" ((meta ->> 'correlation') COLLATE pg_catalog."default");

-- Bulk copy. PG routes each row to the correct child based on hash(stream).
-- This is the slow step. Reads and writes against the source continue normally.
INSERT INTO "{{schema}}"."{{table}}_partitioned" (id, name, data, stream, version, created, meta, pii)
SELECT id, name, data, stream, version, created, meta, pii
FROM "{{schema}}"."{{table}}";

-- == Phase 2 ==
-- Atomic swap. Acquires ACCESS EXCLUSIVE for the late-row drain and rename.

LOCK TABLE "{{schema}}"."{{table}}" IN ACCESS EXCLUSIVE MODE;

-- Drain late rows: anything that landed during the Phase 1 copy.
INSERT INTO "{{schema}}"."{{table}}_partitioned" (id, name, data, stream, version, created, meta, pii)
SELECT s.id, s.name, s.data, s.stream, s.version, s.created, s.meta, s.pii
FROM "{{schema}}"."{{table}}" s
LEFT JOIN "{{schema}}"."{{table}}_partitioned" p ON p.id = s.id AND p.stream = s.stream
WHERE p.id IS NULL;

-- Advance the shared sequence past the highest copied id. The sequence is
-- never recreated; only advanced. Recreating it would silently break the
-- framework's global id monotonicity invariant.
SELECT setval(
    '"{{schema}}"."{{table}}_id_seq"',
    GREATEST(
        (SELECT COALESCE(MAX(id), 0) FROM "{{schema}}"."{{table}}_partitioned"),
        (SELECT last_value FROM "{{schema}}"."{{table}}_id_seq")
    ),
    true
);

-- Rename: source becomes the backup, partitioned becomes the live table.
-- Indexes are renamed together with their tables by PG.
ALTER TABLE "{{schema}}"."{{table}}" RENAME TO "{{table}}_pre_partition_backup";
ALTER TABLE "{{schema}}"."{{table}}_partitioned" RENAME TO "{{table}}";

COMMIT;

-- The migration is complete. Run the Phase 3 verification queries from the
-- README before declaring success and before dropping the backup table.
