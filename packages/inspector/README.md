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

### Views (tab navigation: Log | Timeline | Streams | Correlation | Monitor)

- **Event Log** — reverse-chronological event list with filters (stream regex, event name pills, time range presets, correlation ID), infinite scroll pagination, expandable JSON detail panels. Stream and correlation columns with icon links to navigate to their respective tabs.
- **Timeline** — SVG time-axis visualization with stream swimlanes, colored event dots, hover tooltips with event data, zoom/pan (mouse wheel + drag), density heatmap for large datasets. Click event dot to open detail dialog with stream/correlation navigation links.
- **Stream Inspector** — sortable/filterable stream list (events, version, last event, name). Click to open detail panel with compact expanded events.
- **Correlation Explorer** — trace a correlation ID across its full event chain:
  - **Waterfall view**: time-axis bars with causation indentation, color-coded by stream, gap detection for reaction latency (>1s highlighted)
  - **DAG graph**: directed acyclic graph of event causation with colored nodes and directed arrows
  - **Metadata sidebar**: actor, total events, duration, streams touched (clickable), event type breakdown, selected event detail
- **Processing Monitor** — real-time drain pipeline health dashboard:
  - **Overview cards**: total streams, healthy, blocked, leased, lagging
  - **Blocked streams**: expandable error details, retry count, watermark gap, copy error
  - **Active leases**: lease holder, countdown timer, expiration status
  - **Watermark histogram**: gap distribution across streams (0, 1-10, 11-50, 51-100, 100+)
  - **Auto-refresh**: configurable polling (Off, 5s, 10s, 30s, 1m) with refresh indicator
  - **Tab badge**: red blocked count badge on Monitor tab

### Navigation

- **Cross-view linking**: stream names show Database icon, correlation IDs show GitBranch icon — click to navigate to their tab. Works in all views, dialogs, and sidebars.
- **Back/Forward**: browser-like navigation history with chevron buttons and dropdown showing full history with meaningful captions
- **Default time window**: last 1 hour on first load

### Core

- **Auto-Discovery** — scan a host for PG servers and Act stores across ports and schemas
- **Connection Manager** — save/switch between multiple named connections
- **Snapshot visibility** — `__snapshot__` events included in all queries
- **Stats Bar** — total events, unique streams, event types, time span
- **URL-Synced Filters** — shareable filtered views via URL parameters
- **Dark Theme** — JetBrains Mono font, zinc/emerald color palette

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
