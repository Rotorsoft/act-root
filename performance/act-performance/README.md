# act-performance

Two things live here, sharing one dependency set:

## The envelope evidence (`evidence/`)

The reproducible scenarios behind [`recipes/PERFORMANCE.md`](../../recipes/PERFORMANCE.md) — sustained commit throughput through the real `app.do` path, and cold-start / snapshot / projection-rebuild wall-clock against stores seeded to 1M or 10M events. Needs the repo's docker Postgres on :5431 (`docker compose up -d` at the repo root):

```bash
pnpm -F act-performance evidence        # 1M tier, prints hardware + numbers
pnpm -F act-performance evidence:10m    # 10M tier
```

`seed.ts` builds the fixture at Postgres speed (server-side `generate_series`) — bulk history does not go through the framework, live traffic does. That split is itself one of the published findings.

## The k6 HTTP sandbox (`src/`)

An express server exposing a todo app over HTTP, with k6 load scripts and an influxdb sink (`docker-compose.yml`). This measures the whole HTTP stack, not the framework in isolation — use it for interactive experiments; the published numbers come from `evidence/`.

```bash
pnpm -F act-performance compose         # build + start the stack
pnpm -F act-performance throughput:parallel
```

The k6 scripts live in `performance/k6`. Set the load with `VUS`, `DURATION` and `WRITE_RATIO`, for example `docker compose run --rm -e VUS=200 -e DURATION=60s -e WRITE_RATIO=0.5 k6 run /scripts/throughput.js`. Results stream to InfluxDB: open Grafana on :3000, add the InfluxDB data source (`http://influxdb:8086`, database `k6`) and import dashboard 2587.
