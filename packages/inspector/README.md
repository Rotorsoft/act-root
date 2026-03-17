# Act Inspector

Event sourcing observatory for the Act framework. Connect to any Act PostgreSQL store and inspect, query, and visualize events.

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

Fill in the connection fields directly:

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

### Views (tab navigation: Log | Timeline | Streams)

- **Event Log** — reverse-chronological event list with filters (stream regex, event name pills, time range presets, correlation ID), infinite scroll pagination, expandable JSON detail panels
- **Timeline** — SVG time-axis visualization with stream swimlanes, colored event dots, hover tooltips, density heatmap mode for large datasets (>500 events)
- **Stream Inspector** — sortable/filterable stream list with health badges (healthy/blocked/leased/retry), click to open detail panel with:
  - Processing metadata from the `_streams` table (watermark, retry, blocked, lease info)
  - Full event history for the stream
  - State evolution diffs between consecutive events
  - "Open in Log" quick action

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
│   │   ├── server.ts    # Express + tRPC standalone server
│   │   └── router.ts    # tRPC procedures (discover, connect, query, stats, eventNames, streams, streamMeta)
│   └── client/
│       ├── App.tsx
│       ├── trpc.ts
│       ├── stores/      # URL-synced filter state
│       ├── components/  # Header, TabNav, ConnectDialog, ScanDialog, FilterBar, StatsBar, EventRow, JsonViewer, Logo
│       └── views/       # EventLog, Timeline, Streams
├── index.html
├── vite.config.ts
└── tsconfig.json
```

- **Server**: manages its own `PostgresStore` instance directly (not the Act singleton) — enables reconnecting to different stores. Event data via Act's `Store.query()`, stream processing metadata via direct PG access to the `_streams` table.
- **Client**: React 19 + Vite + Tailwind CSS v4 + tRPC React Query + D3 scales for timeline
- **Read-only**: no mutations, no replays — pure inspection
