#!/usr/bin/env bash
# =============================================================================
# HASH-on-stream partitioning: forward runner
# =============================================================================
# This is a sample. Adapt to your environment. Always run during a
# maintenance window. Always have a backup.
#
# Required env vars:
#   SCHEMA       PG schema name (matches PostgresConfig.schema)
#   TABLE        events table name (matches PostgresConfig.table)
# Optional env vars:
#   PARTITIONS   partition count (default 16, valid range [2, 64])
#   DATABASE_URL libpq connection URL (preferred)
#                or PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE
#
# On any psql error the script aborts via ON_ERROR_STOP=1. Inspect the DB
# state manually and decide whether to roll back (rollback.sql) or fix
# forward.
# =============================================================================

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
forward_sql="${script_dir}/forward.sql"

: "${SCHEMA:?SCHEMA env var is required (PG schema name)}"
: "${TABLE:?TABLE env var is required (events table name)}"

partitions="${PARTITIONS:-16}"

if ! [[ "${partitions}" =~ ^[0-9]+$ ]]; then
    echo "PARTITIONS must be an integer, got: ${partitions}" >&2
    exit 1
fi
if (( partitions < 2 || partitions > 64 )); then
    echo "PARTITIONS must be in [2, 64], got: ${partitions}" >&2
    echo "Outside that range you should reconsider whether HASH partitioning fits your workload." >&2
    exit 1
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
    : "${PGHOST:?DATABASE_URL or PG* env vars are required}"
    : "${PGUSER:?DATABASE_URL or PG* env vars are required}"
    : "${PGDATABASE:?DATABASE_URL or PG* env vars are required}"
fi

if [[ ! -f "${forward_sql}" ]]; then
    echo "forward.sql not found at: ${forward_sql}" >&2
    exit 1
fi

echo "Running HASH-on-stream forward migration:"
echo "  schema     = ${SCHEMA}"
echo "  table      = ${TABLE}"
echo "  partitions = ${partitions}"
echo

# Substitute placeholders. The default forward.sql uses MODULUS 16; rewrite
# the literal to the requested PARTITIONS value before piping to psql.
rendered="$(
    sed \
        -e "s|{{schema}}|${SCHEMA}|g" \
        -e "s|{{table}}|${TABLE}|g" \
        -e "s|MODULUS 16|MODULUS ${partitions}|g" \
        "${forward_sql}"
)"

if [[ -n "${DATABASE_URL:-}" ]]; then
    echo "${rendered}" | psql -v ON_ERROR_STOP=1 "${DATABASE_URL}"
else
    echo "${rendered}" | psql -v ON_ERROR_STOP=1
fi

echo
echo "Forward migration committed."
echo "Run Phase 3 verification queries from README.md before declaring success."
echo "Do not drop ${SCHEMA}.${TABLE}_pre_partition_backup until the partitioned table has run cleanly for at least a week."
