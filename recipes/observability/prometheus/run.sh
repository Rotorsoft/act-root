#!/usr/bin/env bash
# One-command live demo: Prometheus (docker) + the instrumented app.
# Ctrl-C stops the app and tears the Prometheus container down.
set -euo pipefail
cd "$(dirname "$0")"

step() { echo "[dev:metrics] $*"; }

step "starting prometheus container (docker compose up -d)..."
docker compose up -d
trap '
  echo
  step "shutting down..."
  step "  1/2 demo app stopped (act disposal: traffic loops, /metrics server, bridge)"
  step "  2/2 stopping prometheus container (docker compose down)..."
  docker compose down
  step "teardown complete."
' EXIT

step "waiting for prometheus to be ready on :9090..."
until curl -sf http://localhost:9090/-/ready >/dev/null 2>&1; do sleep 0.5; done
step "prometheus is up — scraping the demo every 2s"
step "UI: http://localhost:9090/graph?g0.expr=rate(act_events_committed_total%5B30s%5D)&g0.tab=0&g1.expr=act_streams_blocked&g1.tab=0"
step "starting instrumented demo app on :4001 (Ctrl-C stops everything)..."
echo

npx tsx examples/live-demo.ts
