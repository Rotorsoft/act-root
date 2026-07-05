#!/usr/bin/env bash
# One-command live demo: Prometheus (docker) + the instrumented app.
# Ctrl-C stops the app and tears the Prometheus container down.
set -euo pipefail
R="$(cd "$(dirname "$0")" && pwd)"

step() { echo "[dev:metrics] $*"; }

if lsof -ti :4001 >/dev/null 2>&1; then
  step "port 4001 is already in use — is another demo still running? (lsof -ti :4001)"
  exit 1
fi

step "starting prometheus + grafana containers (docker compose up -d)..."
docker compose -f "$R/docker-compose.yml" up -d
trap '
  echo
  step "shutting down..."
  step "  1/2 demo app stopped (act disposal: traffic loops, /metrics server, bridge)"
  step "  2/2 stopping prometheus + grafana containers (docker compose down)..."
  docker compose -f "$R/docker-compose.yml" down
  step "teardown complete."
' EXIT

step "waiting for prometheus to be ready on :9090..."
until curl -sf http://localhost:9090/-/ready >/dev/null 2>&1; do sleep 0.5; done
step "prometheus is up — scraping the demo every 2s"
step "waiting for grafana to be ready on :3001..."
until curl -sf http://localhost:3001/api/health >/dev/null 2>&1; do sleep 0.5; done
step "grafana is up (provisioned dashboard ready)"
step "prometheus (raw queries): http://localhost:9090"
step "starting the app — drive everything from http://localhost:4001 (Ctrl-C here stops it all)..."
echo

npx tsx "$R/examples/live-demo.ts"
