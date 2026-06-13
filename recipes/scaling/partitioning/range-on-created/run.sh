#!/usr/bin/env bash
# =============================================================
# RANGE-on-created partitioning — forward migration runner
# =============================================================
#
# This wrapper substitutes {{schema}} / {{table}} placeholders in
# forward.sql and pipes the result to psql with ON_ERROR_STOP=1.
# It does NOT wrap drop-partition.sql — that script runs on a
# different cadence (cron-driven, daily/weekly), has a different
# blast radius (irreversible data loss), and should never share
# an invocation surface with the migration. Wire drop-partition
# into cron separately and gate it on its own confirmation step.
#
# Usage:
#
#   SCHEMA=public TABLE=events ./run.sh
#
# Required environment:
#
#   SCHEMA       — schema name (no quoting; passed to sed)
#   TABLE        — events table name
#
# Database connection — either:
#
#   DATABASE_URL — postgres://user:pass@host:port/db
#
# Or the standard PG* envs (PGHOST, PGPORT, PGUSER, PGPASSWORD,
# PGDATABASE) that psql reads natively.
#
# Pre-flight expectations (the script does NOT verify these for
# you; they're operator responsibility):
#
#   - You're in a planned maintenance window.
#   - A verified backup exists and the restore path is tested.
#   - No long-running transactions are open against the events
#     table. Phase 2 takes ACCESS EXCLUSIVE; an existing lock
#     waits forever.
#   - Disk headroom is ~1.5–2× the current events-table size.
#   - Partition provisioning (pg_partman or custom cron) is
#     planned for after the migration. The forward.sql ships
#     12 months of forward partitions; that's the deadline.
#
# Failure mode:
#
#   psql is invoked with --single-transaction so any error
#   inside forward.sql rolls back to the pre-migration state.
#   You can safely re-run after fixing whatever broke.
# =============================================================

set -euo pipefail

# Fail fast on missing required env.
: "${SCHEMA:?SCHEMA env var is required (e.g. SCHEMA=public)}"
: "${TABLE:?TABLE env var is required (e.g. TABLE=events)}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FORWARD_SQL="${SCRIPT_DIR}/forward.sql"

if [[ ! -f "${FORWARD_SQL}" ]]; then
    echo "ERROR: ${FORWARD_SQL} not found" >&2
    exit 1
fi

# Build the psql connection args. Prefer DATABASE_URL if present;
# otherwise let psql pick up PG* envs from the environment.
PSQL_ARGS=(
    --set ON_ERROR_STOP=1
    --single-transaction
    --no-psqlrc
    --quiet
)

if [[ -n "${DATABASE_URL:-}" ]]; then
    PSQL_ARGS+=(--dbname "${DATABASE_URL}")
fi

echo "==> Running forward partition migration"
echo "    schema = ${SCHEMA}"
echo "    table  = ${TABLE}"
echo "    script = ${FORWARD_SQL}"
echo

# Substitute placeholders and pipe. We use sed here (not psql
# variables) because the placeholders appear in identifiers
# (table names, index names) where :'var' interpolation would
# inject quoting that breaks the DDL.
if sed \
        -e "s/{{schema}}/${SCHEMA}/g" \
        -e "s/{{table}}/${TABLE}/g" \
        "${FORWARD_SQL}" \
   | psql "${PSQL_ARGS[@]}"; then
    echo
    echo "==> Migration complete."
    echo
    echo "Next steps:"
    echo "  1. Verify row-count parity between"
    echo "     ${SCHEMA}.${TABLE}_pre_partition and ${SCHEMA}.${TABLE}."
    echo "  2. Inspect partition layout (see forward.sql for the query)."
    echo "  3. Run a representative workload against the partitioned"
    echo "     table before dropping ${SCHEMA}.${TABLE}_pre_partition."
    echo "  4. Wire pg_partman or a custom cron to provision new"
    echo "     monthly partitions before the forward window expires."
    echo "  5. Wire drop-partition.sql into cron with a cutoff date"
    echo "     computed from your retention policy. Verify the cold-"
    echo "     storage hook before its first scheduled run."
else
    echo
    echo "==> Migration FAILED. Transaction rolled back; database is" >&2
    echo "    in its pre-migration state. Investigate the psql error" >&2
    echo "    above before retrying." >&2
    exit 1
fi
