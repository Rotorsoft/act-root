-- =============================================================================
-- HASH-on-stream partitioning: rollback
-- =============================================================================
--
-- What this file does
--   Reverts the events table from PARTITION BY HASH (stream) back to a
--   regular unpartitioned table. The partitioned table is preserved as
--   a backup. The sequence is advanced (never recreated).
--
-- Placeholders to substitute (use sed / envsubst before piping to psql)
--   {{schema}}      schema name
--   {{table}}       events table name
--
-- Requires a maintenance window
--   This is NOT an online operation. Reads will block briefly; writes must
--   be paused for the duration of the run. The schemas differ in PK shape
--   and index layout, so PG cannot perform the swap online.
--
-- Pre-state (after a successful forward.sql)
--   Partitioned table  {{schema}}.{{table}}                  (live)
--   Original backup    {{schema}}.{{table}}_pre_partition_backup
--   Sequence           {{schema}}.{{table}}_id_seq           (shared)
--
-- Post-state (after this rollback)
--   Regular table      {{schema}}.{{table}}                  (live, repopulated)
--   Pre-partition backup remains where forward.sql left it
--   Post-partition backup at {{schema}}.{{table}}_post_partition_backup
--
-- What gets carried forward
--   Every row that the partitioned table held at the moment this script
--   ran. That INCLUDES writes that landed after the original swap — the
--   INSERT step copies from the current partitioned table, not from the
--   pre-partition backup. If you only wanted writes up to the pre-partition
--   moment, drop {{table}}_post_partition_backup and rename
--   {{table}}_pre_partition_backup back to {{table}} manually instead of
--   running this script.
--
-- =============================================================================

\set ON_ERROR_STOP on
BEGIN;

-- Block writes for the duration of the rollback.
LOCK TABLE "{{schema}}"."{{table}}" IN ACCESS EXCLUSIVE MODE;

-- Create a fresh unpartitioned target with the standard Act events shape.
-- PK is the simple (id) again; the partition-key requirement no longer applies.
CREATE TABLE "{{schema}}"."{{table}}_unpartitioned" (
    id integer NOT NULL DEFAULT nextval('"{{schema}}"."{{table}}_id_seq"'::regclass) PRIMARY KEY,
    name varchar(100) COLLATE pg_catalog."default" NOT NULL,
    data jsonb,
    stream varchar(100) COLLATE pg_catalog."default" NOT NULL,
    version integer NOT NULL,
    created timestamptz NOT NULL DEFAULT now(),
    meta jsonb,
    pii jsonb
) TABLESPACE pg_default;

-- Recreate the standard four indexes. These match the indexes that
-- postgres-store.ts's seed() would create on a fresh install.
CREATE UNIQUE INDEX "{{table}}_unpartitioned_stream_ix"
    ON "{{schema}}"."{{table}}_unpartitioned" (stream COLLATE pg_catalog."default", version);

CREATE INDEX "{{table}}_unpartitioned_name_ix"
    ON "{{schema}}"."{{table}}_unpartitioned" (name COLLATE pg_catalog."default");

CREATE INDEX "{{table}}_unpartitioned_created_id_ix"
    ON "{{schema}}"."{{table}}_unpartitioned" (created, id);

CREATE INDEX "{{table}}_unpartitioned_correlation_ix"
    ON "{{schema}}"."{{table}}_unpartitioned" ((meta ->> 'correlation') COLLATE pg_catalog."default");

-- Copy every row from the partitioned table, preserving id values. The
-- partitioned table's MergeAppend serves this in global id order.
INSERT INTO "{{schema}}"."{{table}}_unpartitioned" (id, name, data, stream, version, created, meta, pii)
SELECT id, name, data, stream, version, created, meta, pii
FROM "{{schema}}"."{{table}}"
ORDER BY id;

-- Advance the sequence past the highest copied id. As in forward.sql,
-- the sequence is never recreated.
SELECT setval(
    '"{{schema}}"."{{table}}_id_seq"',
    GREATEST(
        (SELECT COALESCE(MAX(id), 0) FROM "{{schema}}"."{{table}}_unpartitioned"),
        (SELECT last_value FROM "{{schema}}"."{{table}}_id_seq")
    ),
    true
);

-- Rename: partitioned table becomes the rollback backup, the new
-- unpartitioned table becomes live. The pre-partition backup from
-- forward.sql is left alone.
ALTER TABLE "{{schema}}"."{{table}}" RENAME TO "{{table}}_post_partition_backup";
ALTER TABLE "{{schema}}"."{{table}}_unpartitioned" RENAME TO "{{table}}";

COMMIT;

-- Rollback complete. Two backups now exist on disk:
--   {{table}}_pre_partition_backup   (from forward.sql)
--   {{table}}_post_partition_backup  (from this script)
-- Keep both until you're certain the rollback is stable. Disk is cheaper
-- than re-running the migration.
