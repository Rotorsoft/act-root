# Draft notes — per-adapter store-operator audit

Pre-ticket notes for the store-health follow-up to #723. Captures the scope, audience, and per-adapter scenarios so the eventual ticket has a starting point. Not filed as a ticket until there's actual operator demand — these are observations, not commitments.

## Framing

`app.audit()` (filed as #723) answers **framework-aware** questions: "are events schema-broken, are streams close-able, what's the deprecated load, is anything blocked." It runs against the abstract `Store` interface and works on every adapter the same way.

This is a different audit, with a different audience and a different surface:

- **Audience:** the operator of the *backing store* (often a DBA, sometimes the SRE who owns the database service), not the operator of the *application*.
- **Question being answered:** "is the store itself healthy as a piece of infrastructure?" — fragmentation, bloat, lock contention, partition health, replication lag, disk pressure.
- **Per-adapter:** PG operators care about `pg_stat_user_indexes` + autovacuum lag + WAL bloat + partition counts. SQLite/libsql operators care about `dbstat` page density + WAL file size + integrity check + (for Turso) replica sync lag. InMemory has nothing meaningful here, possibly returns a "you're using InMemory in `NODE_ENV=production`" warning if relevant.
- **Why not in `Store`:** the `Store` port is the framework's read/write contract; it stays minimal. Health is *operator* surface specific to each implementation. Lives on the concrete adapter class (`PostgresStore.health()`, `SqliteStore.health()`), not on the `Store` interface.

## Common shape across adapters

```ts
interface HealthReport {
  adapter: string;            // "postgres" | "sqlite" | "in-memory"
  generatedAt: string;
  overall: "ok" | "warn" | "critical";
  findings: HealthFinding[];
}

interface HealthFinding {
  category: string;
  severity: "info" | "warn" | "critical";
  metric: string;
  value: number | string;
  threshold?: number;
  recommendation?: string;    // "VACUUM events", "ANALYZE", "rotate to next partition", etc.
}
```

Each adapter implements its own `health(options?)` method that returns this shape. The inspector surfaces it in a new "Store Health" tab once at least one adapter implements it.

## Scenarios — Postgres (`PostgresStore.health()`)

### Table bloat (dead tuples)
- **Signal:** `pg_stat_user_tables.n_dead_tup` / `n_live_tup` ratio above ~20%.
- **Likely cause:** autovacuum not keeping up with the write rate. Common after a bulk migration or a large `close()` cycle.
- **Recommendation:** manual `VACUUM events`; check autovacuum thresholds.
- **Sub-flavor:** events table specifically — even after `close()`/`truncate()`, dead tuples remain until VACUUM runs.

### Index bloat
- **Signal:** `pgstattuple_approx(index_oid).avg_leaf_density` below ~50%.
- **Likely cause:** random-id inserts on a B-tree from many `id` writes plus deletes from truncates.
- **Recommendation:** `REINDEX CONCURRENTLY events_pkey` etc.; consider `REINDEX TABLE events`.
- **Caveat:** `pgstattuple` needs the contrib module installed. Capability-gate the check.

### Autovacuum lag
- **Signal:** `pg_stat_user_tables.last_autovacuum` vs `now()`; events table never vacuumed despite `n_mod_since_analyze` high.
- **Likely cause:** autovacuum naptime too long for the workload, or the table missed its threshold.
- **Recommendation:** tune `autovacuum_vacuum_threshold` / `_scale_factor` for events.

### Sequence headroom (the boring one that eventually bites)
- **Signal:** `id` column hitting `bigint` max — astronomically distant for most workloads, but worth a sanity check for migrated stores or stores that bumped sequence values manually.
- **Recommendation:** if the sequence is on an `int` instead of `bigint`, plan a migration *now*.

### Partition health (post #675 ACT-1101)
- **Signal:** events table is partitioned but the operator hasn't rotated; oldest partition holds 80%+ of data; or new writes are still landing in the legacy default partition because the next partition wasn't created.
- **Recommendation:** rotate / create next partition / detach + archive oldest.
- **Sub-flavor:** per-partition row count → spot the hot partition.

### Connection pool & lock contention
- **Signal:** `pg_stat_activity` shows long-running queries holding locks on the events table; pool exhaustion via `pg_stat_database.numbackends` ≥ `max_connections * 0.85`.
- **Likely cause:** a runaway batch job, a slow projection rebuild blocking writes.
- **Recommendation:** kill the long query if safe; investigate origin.

### WAL bloat
- **Signal:** `pg_replication_slots` shows a slot far behind; `pg_wal` directory size growing unbounded.
- **Likely cause:** logical replication consumer down; physical replica lagging.
- **Recommendation:** revive the consumer; drop the slot if it's abandoned.

### Replica lag
- **Signal:** `pg_stat_replication.replay_lag` above N seconds.
- **Likely cause:** replica I/O saturated or apply process stuck.
- **Recommendation:** investigate; potentially fail over.

### Cache hit ratio (shared_buffers)
- **Signal:** `pg_stat_database.blks_hit` / (`blks_hit + blks_read`) below ~99%.
- **Likely cause:** working set exceeds `shared_buffers`.
- **Recommendation:** bump `shared_buffers`; review queries that scan large ranges.

### Cross-process notify health
- **Signal:** `pg_stat_activity.query` shows `LISTEN` consumers per channel; count vs expected app instance count.
- **Useful for:** confirming the lane PR's cross-process notify wiring is intact; spotting dead listeners.

### Unused indexes
- **Signal:** `pg_stat_user_indexes.idx_scan = 0` on an index that's been around for > 30 days.
- **Recommendation:** drop the index, save the write amplification + disk space.
- **Caveat:** be careful with indexes used only at app startup or by rare queries.

## Scenarios — SQLite / libsql (`SqliteStore.health()`)

### Page-level fragmentation
- **Signal:** `dbstat` virtual table — `pageno` density, `payload` per page, free pages.
- **Likely cause:** many deletes from truncates without `VACUUM` (or `PRAGMA auto_vacuum=FULL` not set at create time).
- **Recommendation:** `VACUUM` the database (rewrites the file compactly).
- **Caveat:** `dbstat` requires SQLite compiled with `SQLITE_ENABLE_DBSTAT_VTAB`. Capability-gate.

### Free-list density
- **Signal:** `PRAGMA freelist_count` / total page count above a threshold (~20%).
- **Likely cause:** deletions outpacing inserts on the events table.
- **Recommendation:** `VACUUM` or enable `auto_vacuum=INCREMENTAL`.

### WAL file size
- **Signal:** wal file on disk much larger than the main database.
- **Likely cause:** long-running readers preventing checkpoint; or `wal_autocheckpoint` disabled.
- **Recommendation:** force `PRAGMA wal_checkpoint(TRUNCATE)`; check for orphan reader connections.

### Integrity-check signals
- **Signal:** `PRAGMA integrity_check` returns anything other than `ok`.
- **Likely cause:** disk corruption, ungraceful shutdown, version skew.
- **Recommendation:** investigate immediately. This one is "critical" by default — never warn-only.

### Database file size vs logical size
- **Signal:** file size on disk much larger than `(used_pages * page_size)`.
- **Likely cause:** lots of free pages from past deletions.
- **Recommendation:** `VACUUM` reclaims; alternatively enable `auto_vacuum=FULL` and continue.

### Turso / libsql remote-specific
- **Signal:** replica sync lag from the embedded replica's metadata.
- **Recommendation:** investigate connectivity / quota.
- **Caveat:** only applies when the libsql client is in replica mode. Probably opt-in capability.

## Scenarios — InMemory (`InMemoryStore.health()`)

Probably opt-out (returns `null` or a stub report). Two soft scenarios worth flagging if implemented:

- **`NODE_ENV=production` misconfiguration:** running InMemory in production is almost always a deployment mistake. Surface as a `warn`.
- **Heap usage:** if the store holds millions of events in process memory, surface `process.memoryUsage().heapUsed` and recommend switching adapters.

Both are courtesy warnings, not core scenarios.

## Cross-adapter scenarios

These apply regardless of backing store:

- **Adapter version vs runtime version mismatch.** The adapter package's published version vs the framework's version it was built against. Surfaces when an operator pins `@rotorsoft/act-pg` to an older version than `@rotorsoft/act`. Catchable via package.json read at startup.
- **Disk space remaining at the volume level.** Universal "you have 2 GB left and the events table is growing at 50 MB/day" warning. Not adapter-specific but adapter-visible: each adapter knows its own data file or table path.
- **Backup recency.** If the operator wires the inspector's `backup` mutation into a cron, surface "last backup was N days ago" against a configured threshold. Probably stored as inspector state, not store state.

## Open design questions

- **Where does the inspector surface this?** Probably a "Store Health" tab parallel to "Schema Evolution." Renders the `HealthReport` grouped by category, with severity-based coloring (red for critical, amber for warn, muted for ok). Per-adapter implementations populate via existing `currentStore.health()` (the inspector already has a typed `Store` reference).
- **Capability gating.** Some checks need extensions (`pgstattuple`, `dbstat`). Adapter's `health()` should report which checks ran and which were skipped due to missing privileges or extensions. `HealthFinding` could have a `skipped: true` flag.
- **Privileges.** A low-privilege app DB user often can't read `pg_stat_*`. Should the health check fail gracefully or surface a "can't check, needs `pg_monitor` role" finding? Latter — never silent skips.
- **Cost.** Some PG checks are cheap (one query against `pg_stat_user_tables`); some are expensive (`pgstattuple` does table scans). Audit options should let operators opt into the expensive ones. Default to the cheap subset.
- **Caching.** Most health metrics don't change second-to-second. Cache the report for N minutes; inspector exposes a refresh button.
- **Read replicas.** If the operator runs `health()` against a read replica, some metrics report the replica's state, not the primary. Worth documenting.

## What would the actual ticket look like

Three-phase delivery:

1. **Shape** — define the `HealthReport` interface in `libs/act/src/types/health.ts` (or co-located with `Store`). Concrete adapters implement on their own class, not on the `Store` interface — because Act core shouldn't know what `pg_stat` is.
2. **PG implementation** — `PostgresStore.health()` covering the cheap subset (table size, dead tuple ratio, autovacuum age, sequence headroom, basic pool stats). Document optional checks gated on extensions.
3. **SQLite implementation** — `SqliteStore.health()` covering `PRAGMA integrity_check`, free-list, WAL size, page count. `dbstat` opt-in.

Inspector tab follows once at least PG ships.

Probably 2-3 days for shape + PG; another day for SQLite; another for the inspector tab. Reasonable scope for milestone 1.1 or later — not blocking 1.0.

## What this is NOT

- Not a database monitoring product. Datadog, Grafana, pgwatch already do the deep-dive. This is the *framework-adjacent* slice: "is the store in a state that affects Act's operations?"
- Not a substitute for the existing DBA toolset. An operator who runs `pgwatch` doesn't need most of this. The audit is for application teams who don't have a dedicated DBA and want a "good-enough" health signal from inside their stack.
- Not for auto-remediation. Same discipline as `app.audit()`: surface findings, recommend actions, never execute them.

## Naming options

- `PostgresStore.health()` / `SqliteStore.health()` — direct, methods on the concrete class.
- `auditStore(store): HealthReport` — utility export from `@rotorsoft/act-pg` and `@rotorsoft/act-sqlite`. Slightly more functional, no method coupling to the store class.
- `PostgresHealth.check(store)` — class-based, room for stateful checks (e.g., caching) but more ceremony.

Leaning toward `auditStore(store)` exported from each adapter — keeps the `Store` instance lean, makes it easy for the inspector to import the right one based on the connected adapter type.
