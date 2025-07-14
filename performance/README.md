# Performance Benchmark Suite

## Overview

This suite benchmarks the performance of the `@rotorsoft/act` framework using the Postgres event store, following industry standards (TechEmpower-style CRUD) but **adapted for event sourcing**.

### What’s Different?

- **Classic CRUD**: Directly updates/reads state from a table.
- **Event Sourcing (act)**: All changes are appended as events. State is reconstructed by replaying events or reading from a projection table.
- **This suite**: Implements a "Todo" app where all actions (create, update, delete) are events, and reads are from a projection table (for realistic performance).

## How to Run Performance App in Dev mode

- Start Postgres database (5431) using root docker compose
- Start the sample app using pnpm -F perf dev

## Test Scenarios

- **Actions per Second**: How many events (actions) can be written per second?
- **Reads per Second**: How many reads (from projection) can be served per second?
- **Combined Actions & Reactions**: Run both actions and reads scripts in parallel to measure end-to-end throughput (event writes + projection reads).
- **Concurrency Scaling**: How does the system behave as concurrent users increase?
- **Resource Utilization**: CPU, memory, DB connections.

## Quick Start from Monorepo Root

You can start the performance app directly from the root using pnpm scripts:

```sh
# Build the performance app docker image
pnpm perf:build
```

## Running k6 Performance Tests from the Root

You can run individual or combined k6 scenarios using root scripts:

```sh
# Run actions (writes) scenario
pnpm perf:k6:actions

# Run reads scenario
pnpm perf:k6:reads

# Run scaling/concurrency scenario
pnpm perf:k6:scaling

# Run combined actions and reads (actions in background, reads in foreground)
pnpm perf:k6:combined
```

### View Results

- k6 outputs results to the console (RPS, latency, error rate).
- For advanced reporting, you can export to JSON/CSV or integrate with Grafana.

### 5. Customizing Test Parameters

You can set environment variables for k6:

```sh
docker compose run --rm -e VUS=200 -e DURATION=60s k6 run /scripts/actions.js
```

### Machine Details

Before running, record your machine specs (CPU, RAM, OS) for reproducibility.

---

## Results Template

| Scenario          | RPS | p50 Latency | p95 Latency | Error Rate | CPU (%) | RAM (MB) |
| ----------------- | --- | ----------- | ----------- | ---------- | ------- | -------- |
| Actions/sec       |     |             |             |            |         |          |
| Reads/sec         |     |             |             |            |         |          |
| Combined          |     |             |             |            |         |          |
| Scaling (max VUs) |     |             |             |            |         |          |

---

## Source Code Structure

- `app/`: Event-sourced Todo app using act and Postgres (in /performance/app)
- `k6/`: Performance test scripts (in /performance/k6)
- `docker-compose.yml`: Orchestrates DB, app, and test runner

---

## Adapting TechEmpower to Event Sourcing

- **Writes**: All changes are events (`TodoCreated`, `TodoUpdated`, `TodoDeleted`)
- **Reads**: Served from a projection table, updated by event handlers
- **Why?**: This models real-world event-sourced systems and allows fair comparison to classic CRUD

---

## How to Extend

- Add new scenarios to `/performance/k6/`
- Modify the sample app in `/performance/app/` to test other event-sourced patterns
- Integrate with Grafana for advanced metrics

---

## Questions?

Open an issue or contact the maintainers.
