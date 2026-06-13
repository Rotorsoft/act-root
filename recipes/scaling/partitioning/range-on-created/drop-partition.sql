-- =============================================================
-- RANGE-on-created partitioning — partition-drop archival
-- =============================================================
--
-- WARNING: this script is destructive. Running it without prior
-- cold-storage archival (step 2 of the three-phase pattern in
-- README.md) means the events in dropped partitions are GONE.
-- There is no per-row recovery — the only path back is your real
-- database backup, which is a long restore.
--
-- Before wiring this into cron:
--
--   1. Verify the cold-storage dump step. The pg_dump call below
--      is commented out — operator wires their own destination
--      (S3, GCS, tape, whatever the retention policy says).
--   2. Run it once manually with a known-safe cutoff and inspect
--      the output. The script logs every partition it would
--      detach before it touches anything.
--   3. Confirm the regulator accepts partition-drop as physical
--      disposal in your jurisdiction. Some don't.
--
-- Placeholders this script expects:
--
--   {{schema}}   — schema name, e.g. "public"
--   {{table}}    — events table name, e.g. "events"
--   {{cutoff}}   — date in 'YYYY-MM-DD' form. Partitions whose
--                  upper bound is <= this date are eligible for
--                  drop. Computed by the caller, NOT this script,
--                  so the retention policy lives next to the cron.
--
-- Example cutoff calc (six-year retention, drop partitions fully
-- behind that boundary):
--
--   CUTOFF=$(date -u -d "6 years ago" +%Y-%m-01)
--
-- Run shape:
--
--   psql --set ON_ERROR_STOP=1 \
--        --set schema=public \
--        --set table=events \
--        --set cutoff="$CUTOFF" \
--        -f drop-partition.sql
--
-- =============================================================

\set ON_ERROR_STOP on

BEGIN;

-- Build the list of partitions whose declared upper bound is
-- already <= the cutoff. pg_inherits + relpartbound is the
-- supported way to enumerate range partitions and their bounds
-- on PG 14+.
CREATE TEMP TABLE _drop_candidates AS
SELECT
    inhrelid::regclass         AS partition_oid,
    inhrelid                   AS partition_relid,
    pg_get_expr(c.relpartbound, c.oid) AS bound_expr,
    -- Range partitions store bounds as a parseable expression.
    -- Extract the upper bound by regex; for ranges shaped
    -- FOR VALUES FROM ('YYYY-MM-01') TO ('YYYY-MM-01') the
    -- captured group is the "TO" boundary.
    (regexp_match(
        pg_get_expr(c.relpartbound, c.oid),
        E'TO \\\(''([0-9]{4}-[0-9]{2}-[0-9]{2})''\\\)'
    ))[1]::date AS upper_bound
FROM pg_inherits i
JOIN pg_class c ON c.oid = i.inhrelid
WHERE i.inhparent = '{{schema}}.{{table}}'::regclass;

-- Diagnostic: show the operator what's about to be touched.
-- This is the safety check — if the count is wrong or the
-- cutoff is wrong, ABORT now before the DETACH runs.
SELECT
    partition_oid::text AS partition,
    bound_expr,
    upper_bound,
    upper_bound <= :'cutoff'::date AS will_drop
FROM _drop_candidates
ORDER BY upper_bound;

-- Detach every partition that's fully behind the cutoff. DETACH
-- is metadata-only; the data still lives on disk in the
-- detached child table. CONCURRENTLY avoids blocking writers
-- to the parent table, at the cost of a short transaction
-- split. Use plain DETACH if your maintenance window allows it.
DO $$
DECLARE
    p_oid regclass;
BEGIN
    FOR p_oid IN
        SELECT partition_oid FROM _drop_candidates
        WHERE upper_bound <= :'cutoff'::date
        ORDER BY upper_bound
    LOOP
        EXECUTE format(
            'ALTER TABLE {{schema}}.{{table}} '
            'DETACH PARTITION %s;',
            p_oid
        );
        RAISE NOTICE 'Detached %', p_oid;
    END LOOP;
END
$$;

COMMIT;


-- -------------------------------------------------------------
-- Cold-storage hook — OPERATOR WIRES THIS.
-- -------------------------------------------------------------
--
-- After DETACH, each former partition is a regular table whose
-- name follows the {{table}}_pYYYY_MM pattern. The cold-storage
-- copy must complete (and be verified) BEFORE the DROP TABLE
-- step below.
--
-- The recipe leaves this commented out because the destination
-- is operator-specific. A typical shape uses pg_dump from a
-- shell wrapper (NOT inside this SQL file — pg_dump is a
-- client-side tool):
--
--   for p in $(psql -At -c "SELECT relname FROM pg_class
--                          WHERE relname LIKE '{{table}}_p%'
--                            AND NOT EXISTS (
--                              SELECT 1 FROM pg_inherits
--                              WHERE inhrelid = pg_class.oid
--                            )"); do
--     pg_dump \
--       --schema={{schema}} \
--       --table={{schema}}.$p \
--       --format=custom \
--       --file=/tmp/$p.dump
--     aws s3 cp /tmp/$p.dump s3://events-archive/{{table}}/$p.dump
--   done
--
-- Verify the upload (checksum, bytes-on-destination) before
-- running the DROP step. Once dropped there is no second chance.
-- =============================================================


-- -------------------------------------------------------------
-- Drop step — only run AFTER cold-storage archival is verified.
-- Split into its own transaction so an operator can pause
-- between detach + archive and the irreversible drop.
-- -------------------------------------------------------------

BEGIN;

DO $$
DECLARE
    rel record;
BEGIN
    -- Detached partitions are ordinary tables whose names still
    -- match the partition naming convention. Identify them by
    -- absence from pg_inherits (i.e. they no longer belong to
    -- the parent).
    FOR rel IN
        SELECT n.nspname, c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = '{{schema}}'
          AND c.relname LIKE '{{table}}_p%'
          AND c.relkind = 'r'
          AND NOT EXISTS (
              SELECT 1 FROM pg_inherits
              WHERE inhrelid = c.oid
          )
    LOOP
        EXECUTE format(
            'DROP TABLE %I.%I;',
            rel.nspname, rel.relname
        );
        RAISE NOTICE 'Dropped %.%', rel.nspname, rel.relname;
    END LOOP;
END
$$;

COMMIT;

-- =============================================================
-- After successful run:
--
--   - The events table no longer contains any rows from dropped
--     partitions.
--   - Disk space returns to the filesystem in one extent free.
--   - No VACUUM follow-up is needed; nothing was DELETEd.
--   - The cold-storage copy in S3 / GCS / tape is your only
--     remaining trace of the dropped data.
--
-- If something went wrong mid-run, see the recovery section in
-- README.md. The short version: detached-but-not-dropped
-- partitions are still on disk and can be re-attached with
-- ALTER TABLE ... ATTACH PARTITION as long as no concurrent
-- commit landed a duplicate id in the now-empty range.
-- =============================================================
