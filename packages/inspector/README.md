# Act Inspector

Event sourcing observatory for the Act framework. Connect to any Act PostgreSQL store and inspect, query, and visualize events in real time.

## Quickstart

```bash
# From the monorepo root
pnpm install
pnpm dev:inspector
```

This starts both the tRPC server (port 4001) and the Vite client (port 3001).

Open [http://localhost:3001](http://localhost:3001) — the connection dialog appears on launch.

### Auto-discover

Click **Scan...** to automatically find Act stores on your host:

1. Scans ports 5430–5480 (configurable) for PostgreSQL servers
2. Tries common credentials (`postgres/postgres`, etc.)
3. Detects Act event tables by schema shape (`stream`, `meta`, `version` columns)
4. Picks the best table per schema — prefers `public.events`, then largest by row count
5. Click a result to fill the connection form, then **Connect**

Connection names are derived from the discovered `schema.table` (e.g., `act.wolfdesk`).

### Manual connection

| Field    | Default     |
|----------|-------------|
| Host     | `localhost` |
| Port     | `5432`      |
| Database | `postgres`  |
| User     | `postgres`  |
| Password | `postgres`  |
| Schema   | `public`    |
| Table    | `events`    |

## Features

### Views

- **Event Log** — reverse-chronological event list with filters (stream regex, event name pills, time range presets, correlation ID), infinite scroll pagination, expandable JSON detail panels
- **Timeline** — SVG time-axis visualization with stream swimlanes, colored event dots, hover tooltips, zoom/pan, and density heatmap for large datasets
- **Stream Inspector** — sortable/filterable stream list with event counts, versions, and expandable detail panels
- **Correlation Explorer** — trace a correlation ID across its full event chain:
  - Waterfall view with causation indentation, color-coded by stream, gap detection for reaction latency
  - DAG graph with directed arrows showing event causation
  - Metadata sidebar with actor, duration, streams touched, and event type breakdown
- **Processing Monitor** — real-time drain pipeline health:
  - Overview cards (total streams, healthy, blocked, leased, lagging)
  - Blocked streams with expandable error details and retry counts
  - Active leases with countdown timers
  - Watermark histogram showing gap distribution across streams

### Navigation

- Cross-view linking: click any stream name or correlation ID to navigate to its tab
- Back/forward history with dropdown showing meaningful captions
- URL-synced filters for shareable views

### Live Mode

- Global polling: Off / 5s / 10s / 30s with pulsing indicator
- All views update in real time
- Automatic data reset on DB changes (handles `store().seed()` gracefully)

### Core

- Auto-discovery of PostgreSQL servers and Act event stores across ports and schemas
- Connection manager with save/switch between multiple named connections
- Stats bar with total events, unique streams, event types, and time span
- Dark theme with JetBrains Mono font

## Architecture

```
packages/inspector/
├── src/
│   ├── server/
│   │   ├── server.ts    # tRPC standalone server (port 4001)
│   │   └── router.ts    # tRPC procedures
│   └── client/
│       ├── App.tsx      # Root with navigation history
│       ├── trpc.ts      # tRPC client
│       ├── stores/      # URL-synced filter state
│       ├── components/  # Header, TabNav, ConnectDialog, ScanDialog, FilterBar, StatsBar, EventRow, JsonViewer, Logo
│       └── views/       # EventLog, Timeline, Streams, Correlation, Monitor
├── public/              # favicon.svg
├── index.html
├── vite.config.ts
└── tsconfig.json
```

### Server procedures

| Procedure | Type | Description |
|-----------|------|-------------|
| `discover` | mutation | Scan host ports for PG servers, find Act event tables |
| `connect` | mutation | Initialize PostgresStore connection |
| `disconnect` | mutation | Close current connection |
| `status` | query | Connection health check |
| `query` | query | Event queries with full filter support |
| `stats` | query | Aggregate counts for current filters |
| `eventNames` | query | Distinct event names for filter dropdown |
| `streams` | query | Stream list with event counts and versions |
| `streamMeta` | query | Stream processing metadata from `_streams` table |
| `drainStatus` | query | Drain pipeline health: aggregates, blocked streams, leases, watermark histogram |

- **Event data**: flows through Act's `Store.query()` interface
- **Processing metadata**: direct PG access to the `_streams` table via `pg.Client`
- **Store management**: own `PostgresStore` instance (not the Act singleton) — enables reconnecting
- **Read-only**: no mutations, no replays — pure inspection
