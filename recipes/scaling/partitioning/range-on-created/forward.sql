-- =============================================================
-- RANGE-on-created partitioning — forward migration
-- =============================================================
--
-- Placeholders this script expects (substitute via run.sh or
-- envsubst before piping to psql):
--
--   {{schema}}   — schema name, e.g. "public"
--   {{table}}    — events table name, e.g. "events"
--
-- Partition boundaries shipped here cover 24 months back from the
-- migration date + 12 months forward. Adjust the GENERATE_SERIES
-- range in Phase 1 to match your retention shape:
--
--   - Yearly partitions: switch to date_trunc('year', …) and a
--     coarser GENERATE_SERIES (interval '1 year').
--   - Tighter back-window: shorten the back range — but never go
--     past the regulatory retention floor, or the first dropper
--     run after the migration will refuse to drop anything.
--   - Longer forward-window: extend the forward range if you
--     don't want to wire pg_partman or a cron until after the
--     migration settles.
--
-- After the migration, you MUST have ongoing partition
-- provisioning in place. The forward window expires; commits
-- arriving for a month with no partition fail with
-- `no partition of relation "{{table}}" found for row`. Wire
-- pg_partman or a "create next month" job before the forward
-- window's tail.
--
-- States this script depends on / produces:
--
--   Pre-state:
--     - {{schema}}.{{table}}      — unpartitioned events table
--     - {{schema}}.{{table}}_streams — streams table (untouched)
--     - events_id_seq (or {{schema}}.{{table}}_id_seq) owned by
--       the events table
--
--   Post-state:
--     - {{schema}}.{{table}}      — partitioned by RANGE (created),
--       PK is (id, created), child partitions cover the configured
--       window
--     - {{schema}}.{{table}}_pre_partition — backup of the original
--       (unpartitioned) table; keep until the partitioned table is
--       verified, then DROP TABLE … to reclaim disk
--
-- Estimated cost on commodity NVMe + PG 17:
--
--   - INSERT copy rate: ~50–200k rows/sec, dominated by index
--     builds on the new partitions. A 100M-row table takes
--     ~10–30 minutes for the copy alone. Measure on a restored
--     backup before picking the window.
--   - Peak disk: ~1.5–2.0× the current pg_total_relation_size of
--     {{table}} (old table + new partitioned table + indexes
--     coexist during Phase 1).
--   - Phase 2 ACCESS EXCLUSIVE window: seconds to low minutes,
--     determined by the late-rows replay. Stop user-facing writes
--     before Phase 2 if you want a tighter bound.
--
-- This migration is NOT online. Schedule a maintenance window.
-- =============================================================


-- -------------------------------------------------------------
-- Phase 1: build the new partitioned table + child partitions,
-- copy events.
-- -------------------------------------------------------------

BEGIN;

-- New partitioned shell. PK MUST include the partition key, hence
-- (id, created). Column shape matches the live schema in
-- libs/act-pg/src/postgres-store.ts.
CREATE TABLE {{schema}}.{{table}}_new (
    id      serial      NOT NULL,
    name    varchar(100) COLLATE pg_catalog."default" NOT NULL,
    data    jsonb,
    stream  varchar(100) COLLATE pg_catalog."default" NOT NULL,
    version int         NOT NULL,
    created timestamptz NOT NULL DEFAULT now(),
    meta    jsonb,
    pii     jsonb,
    PRIMARY KEY (id, created)
) PARTITION BY RANGE (created);

-- Reuse the existing id sequence so global monotonicity holds
-- across the migration. The serial column on the new table
-- created its own sequence; drop it and point at the live one.
ALTER TABLE {{schema}}.{{table}}_new
    ALTER COLUMN id DROP DEFAULT;
DROP SEQUENCE IF EXISTS {{schema}}.{{table}}_new_id_seq;
ALTER TABLE {{schema}}.{{table}}_new
    ALTER COLUMN id
    SET DEFAULT nextval(pg_get_serial_sequence(
        '{{schema}}.{{table}}', 'id'));

-- Indexes on the parent — Postgres propagates them to every
-- child partition automatically.
CREATE UNIQUE INDEX {{table}}_new_stream_ix
    ON {{schema}}.{{table}}_new
    (stream COLLATE pg_catalog."default", version);
CREATE INDEX {{table}}_new_name_ix
    ON {{schema}}.{{table}}_new
    (name COLLATE pg_catalog."default");
CREATE INDEX {{table}}_new_created_id_ix
    ON {{schema}}.{{table}}_new
    (created, id);
CREATE INDEX {{table}}_new_correlation_ix
    ON {{schema}}.{{table}}_new
    ((meta ->> 'correlation') COLLATE pg_catalog."default");

-- Child partitions: 24 months back + 12 months forward. Adjust
-- the start/end of GENERATE_SERIES to match your retention shape.
-- The DO block generates one CREATE TABLE per month.
DO $$
DECLARE
    bucket_start date;
    bucket_end   date;
    part_name    text;
    months_back  int := 24;
    months_fwd   int := 12;
BEGIN
    FOR bucket_start IN
        SELECT generate_series(
            date_trunc('month', now()) - make_interval(months => months_back),
            date_trunc('month', now()) + make_interval(months => months_fwd),
            interval '1 month'
        )::date
    LOOP
        bucket_end := (bucket_start + interval '1 month')::date;
        part_name  := format('{{table}}_p%s',
                             to_char(bucket_start, 'YYYY_MM'));

        EXECUTE format(
            'CREATE TABLE {{schema}}.%I '
            'PARTITION OF {{schema}}.{{table}}_new '
            'FOR VALUES FROM (%L) TO (%L);',
            part_name, bucket_start, bucket_end
        );
    END LOOP;
END
$$;

-- Bulk copy. Single statement so the planner picks the best plan;
-- pg_repack or COPY pipeline would be faster on very large tables
-- but loses the convenience of a transactional checkpoint.
INSERT INTO {{schema}}.{{table}}_new
    (id, name, data, stream, version, created, meta, pii)
SELECT
    id, name, data, stream, version, created, meta, pii
FROM {{schema}}.{{table}};

COMMIT;


-- -------------------------------------------------------------
-- Phase 2: atomic swap. Locks the source table briefly, replays
-- any rows that landed during Phase 1, advances the sequence,
-- renames the tables.
-- -------------------------------------------------------------

BEGIN;

-- Block writes on the source table for the duration of the swap.
-- This is the maintenance-window-cost line item. If a long
-- transaction is open against {{schema}}.{{table}} the LOCK
-- waits forever — abort and investigate before retrying.
LOCK TABLE {{schema}}.{{table}} IN ACCESS EXCLUSIVE MODE;

-- Catch up any rows committed to the source table after Phase 1's
-- bulk INSERT. With writes blocked there can't be new rows during
-- this statement; the watermark is whatever made it through
-- before the LOCK.
INSERT INTO {{schema}}.{{table}}_new
    (id, name, data, stream, version, created, meta, pii)
SELECT
    s.id, s.name, s.data, s.stream, s.version, s.created, s.meta, s.pii
FROM {{schema}}.{{table}} s
LEFT JOIN {{schema}}.{{table}}_new n ON n.id = s.id
WHERE n.id IS NULL;

-- Advance the shared sequence past the highest copied id so the
-- next commit picks up where the unpartitioned table left off.
SELECT setval(
    pg_get_serial_sequence('{{schema}}.{{table}}', 'id'),
    (SELECT COALESCE(MAX(id), 1) FROM {{schema}}.{{table}}_new)
);

-- Atomic rename. The old table becomes the named backup; the new
-- partitioned table takes the production name.
ALTER TABLE {{schema}}.{{table}}
    RENAME TO {{table}}_pre_partition;
ALTER TABLE {{schema}}.{{table}}_new
    RENAME TO {{table}};

-- Indexes on the new table were created with `_new` in their
-- names; rename them to match the production naming convention.
ALTER INDEX {{schema}}.{{table}}_new_stream_ix
    RENAME TO {{table}}_stream_ix;
ALTER INDEX {{schema}}.{{table}}_new_name_ix
    RENAME TO {{table}}_name_ix;
ALTER INDEX {{schema}}.{{table}}_new_created_id_ix
    RENAME TO {{table}}_created_id_ix;
ALTER INDEX {{schema}}.{{table}}_new_correlation_ix
    RENAME TO {{table}}_correlation_ix;

COMMIT;


-- -------------------------------------------------------------
-- Post-migration verification (run interactively, not as part of
-- the migration transaction):
-- -------------------------------------------------------------
--
--   -- Row count parity:
--   SELECT
--     (SELECT count(*) FROM {{schema}}.{{table}}_pre_partition) AS pre,
--     (SELECT count(*) FROM {{schema}}.{{table}}) AS post;
--
--   -- Partition layout:
--   SELECT inhrelid::regclass AS partition,
--          pg_get_expr(relpartbound, inhrelid) AS bounds
--   FROM pg_inherits
--   JOIN pg_class ON pg_class.oid = inhrelid
--   WHERE inhparent = '{{schema}}.{{table}}'::regclass
--   ORDER BY partition::text;
--
--   -- Sequence advanced past the watermark:
--   SELECT last_value
--   FROM {{schema}}.{{table}}_id_seq;
--
-- Once verified and after a representative workload has run
-- against the partitioned table, reclaim the backup:
--
--   DROP TABLE {{schema}}.{{table}}_pre_partition;
--
-- Don't drop the backup before verification — once it's gone, the
-- only path back is your real backup, which is a longer recovery.
-- =============================================================
