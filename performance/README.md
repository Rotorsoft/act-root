# Performance Benchmark Suite

## Overview

This suite benchmarks the performance of the `@rotorsoft/act` framework using the Postgres event store, following industry standards (TechEmpower-style CRUD) but **adapted for event sourcing**.

### What’s Different?

- **Classic CRUD**: Directly updates/reads state from a table.
- **Event Sourcing (act)**: All changes are appended as events. State is reconstructed by replaying events or reading from a projection table.
- **This suite**: Implements a "Todo" app where all actions (create, update, delete) are events, and reads are from a projection table (for realistic performance).

## How to Run Performance App in Dev mode

- Start Postgres database (5431) using root docker compose
- Start the sample app using pnpm -F act-performancedev

## Throughput and Consistency Test

The `throughput` scenario measures both endpoint throughput and projection consistency in two phases:

### Phase 1: Load (Mutations + Reads)

- Concurrent writers mutate todos (create, update, delete) while readers poll the projected count.
- Metrics collected:
  - **Throughput**: Actions/sec and Reads/sec.
  - **Projection Lag**: The absolute difference between the projected count and the in-memory count, recorded as a trend (distribution, p95, max, etc.).

### Phase 2: Convergence (Consistency)

- After mutations stop, only readers run.
- Each read triggers a debounced drain via the `/drain` endpoint to help the projection settle.
- The test measures how long it takes for the projected count to converge to the in-memory count and remain consistent for several consecutive reads.
- **The convergence phase ends as soon as all VUs detect robust consistency: both the projected and in-memory counts match, and all events in the event store have been projected, for the required number of consecutive reads (checked via the `/stats` endpoint).**
- Metrics collected:
  - **Convergence Time**: Time from the end of mutations to when the projection and in-memory counts match and stay matched.
  - **Final Projection Lag**: The lag (difference) between projection and in-memory count at the end of the convergence phase, even if full consistency was not achieved.
  - **Event ID Lag**: The difference between the last event created and the last event projected, providing a precise view of how far the projection is behind the event store. This is available in the `/stats` endpoint and is recorded during the convergence phase.

### How to Run

#### Serial Projection Mode

```sh
pnpm -F act-performance throughput:serial
```

This sets `SERIAL_PROJECTION=true` so all projections are processed serially (single lease).

#### Parallel Projection Mode

```sh
pnpm -F act-performance throughput:parallel
```

This uses the default (parallel, one lease per stream) projection strategy.

You can adjust VUs, duration, and write ratio as before:

```sh
docker compose run --rm -e VUS=200 -e DURATION=60s -e WRITE_RATIO=0.5 k6 run /scripts/throughput.js
```

### Metrics Explained

- **Throughput**: Measures how many actions and reads the system can handle per second under load.
- **Projection Lag**: Shows how far behind the projection is from the actual state during heavy mutations.
- **Convergence Time**: Indicates how quickly the system becomes consistent after the write storm ends.
- **Final Projection Lag**: Shows how close the system got to consistency at the end of the convergence phase, even if it did not fully converge.
- **Event ID Lag**: The difference between the last event created and the last event projected, providing a precise view of how far the projection is behind the event store. This is available in the `/stats` endpoint and is recorded during the convergence phase.

This methodology allows you to compare not just raw throughput, but also the real-world consistency behavior of the event-sourced system under different projection strategies.

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

## Performance Stats Endpoint

After running a test, you can query the `/stats` endpoint to get a summary of the run:

- **totalEventsProjected**: Total number of events projected (all mutations processed by the projection).
- **totalTodos**: Total number of todos ever created.
- **activeTodos**: Number of active (not deleted) todos.
- **lastEvents**: The last 10 projected events (with their details).

Example:

```sh
curl http://localhost:3000/stats
```

Use this endpoint to analyze the volume of events, the current state of the system, and to debug or validate the results of your performance tests.

## Visualizing k6 Metrics with InfluxDB and Grafana

This project includes InfluxDB and Grafana services in `performance/act-performance/docker-compose.yml` for visualizing k6 performance test metrics.

### 1. Start InfluxDB and Grafana

```sh
docker compose -f performance/act-performance/docker-compose.yml up -d influxdb grafana
```

### 2. Run k6 with InfluxDB Output

Run your k6 test and output metrics to InfluxDB:

```sh
k6 run --out influxdb=http://localhost:8086/k6 performance/k6/throughput.js
```

### 3. Access Grafana

- Open your browser and go to: [http://localhost:3000](http://localhost:3000)
- Login (default user: `admin`, password: `admin`)

### 4. Add InfluxDB as a Data Source

- Go to **Configuration > Data Sources**
- Add a new InfluxDB data source:
  - URL: `http://influxdb:8086` (if using Docker Compose network) or `http://localhost:8086` (if running locally)
  - Database: `k6`
  - No authentication needed for default setup
  - Click **Save & Test**

### 5. Import a k6 Dashboard

- Go to **Create > Import Dashboard**
- Use dashboard ID: `2587` (official k6 load testing results dashboard)
- Select your InfluxDB data source
- Click **Import**

You will now see real-time and historical k6 metrics, including your custom trends like `convergence_speed`.
