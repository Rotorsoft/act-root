# Act Inspector

Event sourcing observatory for the Act framework. Connect to any Act PostgreSQL store and inspect, query, and visualize events in real time.

> Workspace package, not a published library. Run via `pnpm dev:inspector` from the monorepo root. PostgreSQL only — `SqliteStore` is not supported by the inspector.

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
| SSL      | `false`     |

When **SSL** is enabled, the connection uses `ssl: { rejectUnauthorized: false }` — suitable for self-signed certs on managed Postgres providers.

## Features

### Views

- **Event Log** — reverse-chronological event list with filters (stream regex, event name pills, time range presets, correlation ID), infinite scroll pagination, expandable JSON detail panels
- **Timeline** — SVG time-axis visualization with stream swimlanes, colored event dots, hover tooltips, zoom/pan, and density heatmap for large datasets
- **Stream Inspector** — sortable/filterable stream list with event counts, versions, scheduling priority (inline-editable when write mode is on), drain lane, age (relative-time on first commit), and last activity. Stale-stream filter (≥7/14/30/90 days) hides anything that's committed recently — the "which long-lived streams have gone quiet?" query reduces to one click.
- **Correlation Explorer** — trace a correlation ID across its full event chain:
  - Waterfall view with causation indentation, color-coded by stream, gap detection for reaction latency
  - DAG graph with directed arrows showing event causation
  - Metadata sidebar with actor, duration, streams touched, and event type breakdown
- **Processing Monitor** — real-time drain pipeline health:
  - Overview cards (total streams, healthy, blocked, leased, lagging)
  - Blocked streams with expandable error details and retry counts
  - Active leases with countdown timers
  - Watermark histogram showing gap distribution across streams
  - Priority + lane chip filters — click a chip to drill blocked/lease lists to that priority value or drain lane (ACT-102 + ACT-1103). Default priority `p=0` and `default` lane dim; non-default values pop in amber (priority) and violet (lane). Same hue convention as the drain trace and the Streams view, so "this lane" reads the same everywhere.
  - Recent-mutations panel — last 10 inspector-driven mutations with timestamp, target priority, affected count, and the raw filter. Pill at the panel header shows whether the server is running in `write` or `read-only` mode.
- **Schema Evolution** — answer the post-migration question "how big is the legacy event backlog on disk?":
  - Four headline cards (total events, deprecated events, distinct names, deprecated names).
  - Table of every event name on disk with status — `deprecated`, `current`, or `active`. Status derived from the `_v<digits>` convention (ACT-403): within a base group (`Foo`, `Foo_v2`, `Foo_v3`), the highest version is current, lower versions are deprecated, standalone groups are active. Deprecated rows pop with an amber-tinted background and point at their current-version sibling.
  - Sortable name/status/count columns; filter by free-text name or status; manual refresh button (the workspace aggregation is lazy-loaded, never silently polled).
  - Click any row → drill-through modal listing every stream that holds that event, with lane chip + priority chip + per-event count (sorted desc) + total events. Multi-select + two copy actions:
    - "Copy names" — newline-separated stream names.
    - "Copy app.close()" — ready-to-paste snippet you run from your own application code.
  - The modal **does not** close streams directly; the inspector has no Act orchestrator (it's a standalone tool pointed at a Postgres store) and can't safely run `app.close()`. The copy affordance is the honest middle ground — inspector surfaces the data, your app runs the close.
- **CSV** — browse a local `.csv` event dump without landing it in a store first. Browser file picker; bytes never leave the client, the parser is identical to `CsvFile`'s blob mode so any framework-emitted backup is readable. Same `EventRow` chrome as the Event Log, so rows from disk read identically to live events.
- **Restore** — toolbar wizard for moving events between any source and any target (the connected store, an uploaded CSV blob, a server-side CSV file, or per-call PG / SQLite credentials). Four steps — Source → Target → Options → Summary — with a dry-run preview that captures the first 50 post-transform events into an in-memory sink and opens a full-screen modal showing both counts and the sample event table. The configured target is never touched on a dry-run: no file written, no transaction opened. Migration overlay (transfer-time only): an ordered list of `{ pattern, replacement }` stream-rename rules — each fires in turn against the running output, so independent renames and chained refinement both work — plus a server-side file path to an `event_migrations` module for schema-guarded payload rewrites.

### Mutations (write mode)

The inspector is **read-only by default**. Mutating controls (the inline priority editor on the Streams view) render as display-only spans and surface the reason in their tooltip. To enable mutations, set:

```bash
ACT_INSPECTOR_WRITE=1 pnpm -F @rotorsoft/act-inspector dev:server
```

The flag is server-static — refreshing a tab doesn't reacquire write access, so a misclick in the dashboard can't reorder live priorities unless an operator has consciously enabled writes on the process. Every successful mutation lands an entry in the in-memory audit log on the Monitor view's right column (capacity 100, cleared on restart).

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
│       ├── components/  # Header, TabNav, ConnectDialog, ScanDialog, BackupRestore (restore wizard launcher), FilterBar, StatsBar, EventRow, EventTable, JsonViewer, Logo
│       └── views/       # EventLog, Timeline, Streams, Correlation, Monitor, SchemaEvolution, CsvViewer
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
| `streams` | query | Stream list with event counts, head + tail timestamps, and version |
| `streamStats` | query | Per-stream head + tail + count + name counts. Procedure also accepts an optional `before: <id>` for prefix-slice aggregation; the UI doesn't currently surface it |
| `streamMeta` | query | Subscription positions from the streams table — priority, lane, retry, lease holder |
| `drainStatus` | query | Drain pipeline health: aggregates, blocked streams, leases, watermark histogram, priority + lane counts |
| `schemaEvolution` | query | Workspace event-name rollup with deprecation status derived from the `_v<digits>` convention (ACT-403). Returns events + headline summary |
| `streamsForEvent` | query | Streams that hold at least one event of the given name — feeds the Schema Evolution drill-through modal |
| `writeMode` | query | `{ enabled, reason }` — reflects the `ACT_INSPECTOR_WRITE` env var |
| `prioritize` | mutation | Bulk-update stream priority via `Store.prioritize(filter, n)`. Filter shape mirrors `query_streams` (stream/source/lane/blocked). Refuses when read-only. |
| `audit` | query | Last 100 mutations performed via the inspector — in-memory ring buffer |
| `transfer` | mutation | Move events between any source and any target (ACT-1128 / #788). Source/target slots accept `current` (connected store), `upload`/`download` (browser CSV), `csv` (server-side file), and per-call `pg`/`sqlite` credentials. Subsumes the prior `backup` and `restore` mutations. `dry_run: true` swaps the configured target for an in-memory `PreviewSink` that collects the first 50 post-transform events — the response includes both the full `ScanResult` (counts) and `sample` (events). Migration overlay (ACT-1126): `stream_rename` accepts an ordered list of `{ pattern, replacement }` rules, applied via chained `String.prototype.replace` so independent and chained renames both work; `event_migrations_path` resolves a cwd-relative module path for schema-guarded payload rewrites |
| `restoreProgress` | subscription | SSE stream of `{ processed }` ticks fired by `scan`'s `on_progress` during an in-flight transfer — drives the reactive progress bar |

- **Event data**: flows through Act's `Store.query()` interface
- **Processing metadata**: flows through Act's `Store.query_streams()` interface — adapter-agnostic, no second connection
- **Transfer**: routes through `Act.restore(source, opts, sink?)` with the connected store wrapped in an empty Act via scoped ports — every transfer kind reuses the same `scan` validator and atomic sink driver, so PG ↔ SQLite ↔ CSV behave identically
- **Store management**: own `PostgresStore` / `SqliteStore` instance (not the Act singleton) — enables reconnecting
- **Mostly read-only**: every view above is non-destructive. The one mutating exception is `transfer` — when the target is `current`, the connected store is wiped and rewritten from the source. Other targets (`download`, `csv`, per-call `pg`/`sqlite`) leave the connected store untouched. The UI surfaces a dry-run preview before any destructive run.
