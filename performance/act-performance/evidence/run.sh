#!/usr/bin/env bash
# Reproduce the envelope measurements from recipes/PERFORMANCE.md on
# your own hardware. Needs the repo's docker Postgres on :5431
# (docker compose up -d at the repo root).
#
#   bash performance/act-performance/evidence/run.sh          # 1M tier
#   TIER=10M bash performance/act-performance/evidence/run.sh # 10M tier
set -euo pipefail
cd "$(dirname "$0")/.."

TIER="${TIER:-1M}"
case "$TIER" in
  1M)  EVENTS=1000000;  HOT=100000  ;;
  10M) EVENTS=10000000; HOT=1000000 ;;
  *) echo "TIER must be 1M or 10M"; exit 1 ;;
esac

echo "== hardware =="
sysctl -n machdep.cpu.brand_string 2>/dev/null || grep -m1 "model name" /proc/cpuinfo || true
echo "$(sysctl -n hw.memsize 2>/dev/null | awk '{print $1/1073741824 " GB"}' || free -h | awk '/Mem/{print $2}') memory"
docker exec act-pg psql -U postgres -tAc "select version()" | cut -d, -f1

echo "== throughput (through app.do) =="
npx tsx evidence/throughput.ts --events 20000

echo "== seeding $TIER tier (direct SQL, not the framework) =="
npx tsx evidence/seed.ts --events "$EVENTS" --hot "$HOT"

echo "== cold start + rebuild =="
npx tsx evidence/coldstart.ts
