#!/usr/bin/env bash
# One-command live demo: Prometheus (docker) + the instrumented app.
# Ctrl-C stops the app and tears the Prometheus container down.
set -euo pipefail
cd "$(dirname "$0")"

docker compose up -d
trap 'docker compose down' EXIT

echo
echo "prometheus UI:  http://localhost:9090/graph?g0.expr=rate(act_events_committed_total%5B30s%5D)&g0.tab=0&g1.expr=act_streams_blocked&g1.tab=0"
echo

npx tsx examples/live-demo.ts
