import { createConnection, type Socket } from "node:net";
import type { Committed, Schemas, Store, StreamPosition } from "@rotorsoft/act";
import { PostgresStore } from "@rotorsoft/act-pg";
import { initTRPC } from "@trpc/server";
import pg from "pg";
import { z } from "zod";

const t = initTRPC.create();

/**
 * Write-mutation gate (#698). Mutating procedures that change adapter
 * state — currently just `prioritize` — refuse to run unless this is
 * explicitly opted into via `ACT_INSPECTOR_WRITE=1`. The legacy
 * `backup` / `restore` mutations predate the gate and aren't covered;
 * they're guarded by their UI flow (explicit click + confirm) rather
 * than by env.
 *
 * Default off keeps the inspector safe to point at production from a
 * laptop. A misclick in the dashboard can no longer reorder live
 * priorities unless an operator has consciously set the env var.
 */
const writeEnabled = process.env.ACT_INSPECTOR_WRITE === "1";

/**
 * In-memory audit log (#698). Records each successful mutation so an
 * operator can answer "who set priority=10 on which streams ten minutes
 * ago?" without persistent storage. Bounded to keep memory usage flat;
 * older entries fall off as new ones land. Cleared on process restart.
 */
type AuditEntry = {
  readonly timestamp: string;
  readonly action: "prioritize";
  readonly filter: Record<string, unknown>;
  readonly priority: number;
  readonly affected: number;
};
const AUDIT_CAPACITY = 100;
const auditLog: AuditEntry[] = [];
const recordAudit = (entry: AuditEntry): void => {
  auditLog.push(entry);
  if (auditLog.length > AUDIT_CAPACITY)
    auditLog.splice(0, auditLog.length - AUDIT_CAPACITY);
};

/** Loosely-typed committed event for inspector queries */
type AnyEvent = Committed<Schemas, string>;

/** Collect events into an array */
const collect =
  (target: AnyEvent[]) =>
  (event: AnyEvent): void => {
    target.push(event);
  };

/** Parse optional ISO string to Date */
const toDate = (iso: string | undefined): Date | undefined =>
  iso ? new Date(iso) : undefined;

/** Managed store instance — not the singleton, so we can reconnect */
let currentStore: Store | null = null;
let currentConfig: {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  schema: string;
  table: string;
} | null = null;

function getStore(): Store {
  if (!currentStore) throw new Error("Not connected to a store");
  return currentStore;
}

/** Drain all subscription positions from the store via query_streams pagination. */
async function loadAllStreamPositions(): Promise<{
  positions: StreamPosition[];
  maxEventId: number;
}> {
  const s = getStore();
  const pageSize = 1000;
  const fetchPage = async (after?: string) => {
    const page: StreamPosition[] = [];
    const result = await s.query_streams((p) => page.push(p), {
      after,
      limit: pageSize,
    });
    return { page, maxEventId: result.maxEventId };
  };

  const positions: StreamPosition[] = [];
  let { page, maxEventId } = await fetchPage();
  positions.push(...page);
  while (page.length === pageSize) {
    ({ page, maxEventId } = await fetchPage(page[page.length - 1].stream));
    positions.push(...page);
  }
  return { positions, maxEventId };
}

// --- Discovery ---

/** PG port range to scan: 5430–5480 */
const PORT_RANGE_START = 5430;
const PORT_RANGE_END = 5480;

/** Common credential combos to try */
const COMMON_CREDS = [
  { user: "postgres", password: "postgres" },
  { user: "postgres", password: "" },
  { user: "postgres", password: "password" },
  { user: "root", password: "root" },
  { user: "admin", password: "admin" },
];

/** One discovered store per port — the best candidate */
type DiscoveredStore = {
  host: string;
  port: number;
  user: string;
  database: string;
  schema: string;
  table: string;
  eventCount: number;
};

/** Check if a TCP port is open */
function probePort(
  host: string,
  port: number,
  timeoutMs = 500
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket: Socket = createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.on("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/** Try to authenticate with a PG server using given credentials */
async function tryConnect(
  host: string,
  port: number,
  user: string,
  password: string
): Promise<pg.Client | null> {
  const client = new pg.Client({
    host,
    port,
    user,
    password,
    database: "postgres",
    connectionTimeoutMillis: 2000,
  });
  try {
    await client.connect();
    return client;
  } catch {
    return null;
  }
}

/** Find the best Act event table per schema in a database (non-empty) */
async function findEventTables(
  config: { host: string; port: number; user: string; password: string },
  dbName: string
): Promise<{ schema: string; table: string; count: number }[]> {
  const client = new pg.Client({
    ...config,
    database: dbName,
    connectionTimeoutMillis: 2000,
  });
  try {
    await client.connect();
    // Find all Act-shaped tables, one best per schema
    const result = await client.query<{
      table_schema: string;
      table_name: string;
      row_estimate: string;
    }>(
      `SELECT DISTINCT ON (t.table_schema)
              t.table_schema, t.table_name,
              (SELECT reltuples::bigint FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = t.table_schema AND c.relname = t.table_name) AS row_estimate
       FROM information_schema.tables t
       WHERE t.table_type = 'BASE TABLE'
         AND t.table_schema NOT IN ('pg_catalog', 'information_schema')
         AND EXISTS (SELECT 1 FROM information_schema.columns c
           WHERE c.table_schema = t.table_schema AND c.table_name = t.table_name AND c.column_name = 'stream')
         AND EXISTS (SELECT 1 FROM information_schema.columns c
           WHERE c.table_schema = t.table_schema AND c.table_name = t.table_name AND c.column_name = 'meta')
         AND EXISTS (SELECT 1 FROM information_schema.columns c
           WHERE c.table_schema = t.table_schema AND c.table_name = t.table_name AND c.column_name = 'version')
       ORDER BY t.table_schema,
         (t.table_name = 'events') DESC,
         row_estimate DESC NULLS LAST`
    );

    // Filter out truly empty tables — reltuples can be -1 (no stats) or 0
    const tables: { schema: string; table: string; count: number }[] = [];
    for (const r of result.rows) {
      const estimate = Number(r.row_estimate);
      if (estimate > 0) {
        tables.push({
          schema: r.table_schema,
          table: r.table_name,
          count: estimate,
        });
      } else {
        // Stats not gathered or zero — check for actual rows
        const check = await client.query(
          `SELECT EXISTS (SELECT 1 FROM "${r.table_schema}"."${r.table_name}" LIMIT 1) AS has_rows`
        );
        if (check.rows[0]?.has_rows) {
          tables.push({
            schema: r.table_schema,
            table: r.table_name,
            count: 0,
          });
        }
      }
    }
    return tables;
  } catch {
    return [];
  } finally {
    await client.end();
  }
}

/** Full discovery: scan ports, try credentials, pick best Act store per port */
async function discover(
  host: string,
  portFrom: number,
  portTo: number
): Promise<DiscoveredStore[]> {
  // 1. Scan port range in parallel
  const ports = Array.from(
    { length: portTo - portFrom + 1 },
    (_, i) => portFrom + i
  );
  const portResults = await Promise.all(
    ports.map(async (port) => ({ port, open: await probePort(host, port) }))
  );
  const openPorts = portResults.filter((r) => r.open).map((r) => r.port);

  if (openPorts.length === 0) return [];

  // 2. For each open port, try credential combos and find best table
  const stores: DiscoveredStore[] = [];

  for (const port of openPorts) {
    for (const creds of COMMON_CREDS) {
      const client = await tryConnect(host, port, creds.user, creds.password);
      if (!client) continue;

      try {
        const dbResult = await client.query<{ datname: string }>(
          `SELECT datname FROM pg_database
           WHERE datistemplate = false AND datallowconn = true
           ORDER BY datname`
        );

        // Find best table per schema across all databases on this port
        for (const row of dbResult.rows) {
          const tables = await findEventTables(
            { host, port, user: creds.user, password: creds.password },
            row.datname
          );
          for (const t of tables) {
            stores.push({
              host,
              port,
              user: creds.user,
              database: row.datname,
              schema: t.schema,
              table: t.table,
              eventCount: t.count,
            });
          }
        }
      } finally {
        await client.end();
      }

      // Found working creds for this port, move to next port
      break;
    }
  }

  return stores;
}

/** CSV column order for backup/restore */
const CSV_COLUMNS = [
  "id",
  "name",
  "data",
  "stream",
  "version",
  "created",
  "meta",
] as const;

/** Escape a value for CSV (RFC 4180) */
function csvEscape(value: string): string {
  if (value.includes('"') || value.includes(",") || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Parse a CSV line respecting quoted fields */
function csvParseLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

/** Get a raw pg client for direct queries */
async function getRawClient(): Promise<pg.Client> {
  if (!currentConfig) throw new Error("Not connected to a store");
  const client = new pg.Client({
    host: currentConfig.host,
    port: currentConfig.port,
    database: currentConfig.database,
    user: currentConfig.user,
    password: currentConfig.password,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  return client;
}

export const inspectorRouter = t.router({
  /** Scan host for PG servers and discover Act event stores */
  discover: t.procedure
    .input(
      z.object({
        host: z.string().default("localhost"),
        portFrom: z.number().min(1).max(65535).default(PORT_RANGE_START),
        portTo: z.number().min(1).max(65535).default(PORT_RANGE_END),
      })
    )
    .mutation(async ({ input }) => {
      try {
        const stores = await discover(input.host, input.portFrom, input.portTo);
        return { ok: true as const, stores };
      } catch (err) {
        throw new Error(
          `Discovery failed: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err }
        );
      }
    }),

  /** Initialize a PostgresStore connection */
  connect: t.procedure
    .input(
      z.object({
        host: z.string().default("localhost"),
        port: z.number().default(5432),
        database: z.string().default("postgres"),
        user: z.string().default("postgres"),
        password: z.string().default("postgres"),
        schema: z.string().default("public"),
        table: z.string().default("events"),
        ssl: z.boolean().default(false),
      })
    )
    .mutation(async ({ input }) => {
      try {
        if (currentStore) {
          await currentStore.dispose();
          currentStore = null;
        }
        const { ssl, ...pgConfig } = input;
        const storeConfig = ssl
          ? { ...pgConfig, ssl: { rejectUnauthorized: false } }
          : pgConfig;
        const newStore = new PostgresStore(storeConfig);
        // Test the connection
        await newStore.query<Schemas>(() => {}, { limit: 1 });
        currentStore = newStore;
        currentConfig = input;
        return { ok: true as const, config: { ...input, password: "***" } };
      } catch (err) {
        currentStore = null;
        currentConfig = null;
        throw new Error(
          `Connection failed: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err }
        );
      }
    }),

  /** Disconnect from current store */
  disconnect: t.procedure.mutation(async () => {
    if (currentStore) {
      await currentStore.dispose();
      currentStore = null;
      currentConfig = null;
    }
    return { ok: true as const };
  }),

  /** Check connection status */
  status: t.procedure.query(() => ({ connected: currentStore !== null })),

  /** Query events using the Store interface */
  query: t.procedure
    .input(
      z.object({
        stream: z.string().optional(),
        names: z.string().array().optional(),
        before: z.number().optional(),
        after: z.number().optional(),
        limit: z.number().min(1).max(500).default(50),
        created_before: z.string().optional(),
        created_after: z.string().optional(),
        backward: z.boolean().optional(),
        correlation: z.string().optional(),
      })
    )
    .query(async ({ input }) => {
      const s = getStore();

      const events: AnyEvent[] = [];
      await s.query<Schemas>(collect(events), {
        ...input,
        created_before: toDate(input.created_before),
        created_after: toDate(input.created_after),
        with_snaps: true,
      });

      return { events };
    }),

  /** Get aggregate stats for current filters */
  stats: t.procedure
    .input(
      z.object({
        stream: z.string().optional(),
        names: z.string().array().optional(),
        created_before: z.string().optional(),
        created_after: z.string().optional(),
        correlation: z.string().optional(),
      })
    )
    .query(async ({ input }) => {
      const s = getStore();

      const events: AnyEvent[] = [];
      await s.query<Schemas>(collect(events), {
        ...input,
        created_before: toDate(input.created_before),
        created_after: toDate(input.created_after),
        with_snaps: true,
      });

      const streams = new Set<string>();
      const names = new Set<string>();
      let minTime: Date | undefined;
      let maxTime: Date | undefined;

      for (const e of events) {
        streams.add(e.stream);
        names.add(String(e.name));
        const created =
          e.created instanceof Date ? e.created : new Date(String(e.created));
        if (!minTime || created < minTime) minTime = created;
        if (!maxTime || created > maxTime) maxTime = created;
      }

      return {
        totalEvents: events.length,
        uniqueStreams: streams.size,
        uniqueEventNames: names.size,
        timeSpan:
          minTime && maxTime
            ? { from: minTime.toISOString(), to: maxTime.toISOString() }
            : null,
      };
    }),

  /** Get distinct event names for filter dropdown */
  eventNames: t.procedure.query(async () => {
    const s = getStore();

    const events: AnyEvent[] = [];
    await s.query<Schemas>(collect(events), { with_snaps: true });

    const names = new Set<string>();
    for (const e of events) names.add(String(e.name));
    return [...names].sort();
  }),

  /** Get distinct stream names with per-stream metadata for the streams view.
   *
   * Backed by `Store.query_stats` (ACT-639): one round trip per adapter,
   * returns per-stream aggregates instead of streaming every event row over
   * the wire. For a store with 1M events / 10K streams this is ~100×
   * less data transferred than the previous full-event-scan path.
   *
   * `names: true` is requested so the response also includes a per-stream
   * event-name → count map, surfaced as `nameCounts` for future UI uses
   * (schema-evolution view, drill-through to legacy-event filters).
   * Sorting + limit stay client-side (the DB returns all matched streams).
   */
  streams: t.procedure
    .input(
      z
        .object({
          limit: z.number().min(1).max(1000).default(100),
        })
        .optional()
    )
    .query(async ({ input }) => {
      const s = getStore();
      const stats = await s.query_stats<Schemas>(
        {},
        { count: true, names: true, tail: true }
      );
      return [...stats.entries()]
        .map(([stream, { head, tail, count, names }]) => ({
          stream,
          eventCount: count ?? 0,
          lastEvent: String(head.created),
          // Earliest event id + created (ACT-639 tail opt-in). Lets the
          // Streams view render an "age" column and filter for stale
          // streams that haven't committed in N days. `tail` is always
          // present in this response because the query requested it.
          firstEvent: tail ? String(tail.created) : null,
          currentVersion: head.version,
          isClosed: head.name === "__tombstone__",
          nameCounts: names ?? {},
        }))
        .sort((a, b) => b.eventCount - a.eventCount)
        .slice(0, input?.limit ?? 100);
    }),

  /**
   * Full per-stream stats for the detail panel (#698). Fetched on
   * demand when the operator opens a stream in the Streams view —
   * cheaper than including head + tail Committed bodies in the
   * page-wide `streams` query, which would 100× the payload for the
   * common "scan the list" case.
   *
   * Returns the head + tail Committed events (id, name, version,
   * created) plus the per-stream event-name → count map and the
   * total event count.
   */
  streamStats: t.procedure
    .input(z.object({ stream: z.string().min(1) }))
    .query(async ({ input }) => {
      const s = getStore();
      const stats = await s.query_stats<Schemas>([input.stream], {
        count: true,
        names: true,
        tail: true,
      });
      const entry = stats.get(input.stream);
      if (!entry) return null;
      const { head, tail, count, names } = entry;
      const project = (e: typeof head | undefined) =>
        e
          ? {
              id: e.id,
              name: String(e.name),
              version: e.version,
              created: String(e.created),
            }
          : null;
      return {
        head: project(head)!,
        // `tail` is opt-in on the query; query_stats({tail:true}) yields
        // it for every stream, but defensively guard for the empty case.
        tail: project(tail),
        eventCount: count ?? 0,
        nameCounts: names ?? {},
      };
    }),

  /** Get stream processing metadata from the streams table */
  streamMeta: t.procedure.query(async () => {
    try {
      const { positions } = await loadAllStreamPositions();
      return positions.map((p) => ({
        stream: p.stream,
        source: p.source ?? null,
        at: p.at,
        retry: p.retry,
        blocked: p.blocked,
        error: p.error || null,
        priority: p.priority,
        // ACT-1103: drain lane the stream is bound to. `undefined`
        // (the implicit "default" lane) surfaces as null for the UI;
        // the Streams view dims it so non-default lanes pop.
        lane: p.lane ?? null,
        leased_by: p.leased_by ?? null,
        leased_until: p.leased_until?.toISOString() ?? null,
      }));
    } catch {
      return [];
    }
  }),

  /** Get drain status: aggregate health + blocked streams + leases + watermark histogram */
  drainStatus: t.procedure.query(async () => {
    try {
      const { positions, maxEventId: rawMax } = await loadAllStreamPositions();
      const maxEventId = Math.max(0, rawMax);
      const now = new Date();

      // Aggregates
      let healthy = 0;
      let blocked = 0;
      let leased = 0;
      let lagging = 0;
      const blockedStreams: Array<{
        stream: string;
        source: string | null;
        error: string | null;
        retry: number;
        at: number;
        gap: number;
        priority: number;
        lane: string | null;
      }> = [];
      const activeLeases: Array<{
        stream: string;
        source: string | null;
        leased_by: string;
        leased_until: string;
        priority: number;
        lane: string | null;
      }> = [];
      const gaps: number[] = [];
      // Streams per priority lane — operators want a quick read of
      // "how many things are at priority > 0 right now."
      const priorityCounts = new Map<number, number>();
      // Streams per drain lane (ACT-1103). `undefined`/`"default"`
      // normalize to `"default"` so the histogram bucket renders one
      // consistent label.
      const laneCounts = new Map<string, number>();

      for (const p of positions) {
        const gap = Math.max(0, maxEventId - p.at);
        gaps.push(gap);
        priorityCounts.set(
          p.priority,
          (priorityCounts.get(p.priority) ?? 0) + 1
        );
        const laneKey = p.lane ?? "default";
        laneCounts.set(laneKey, (laneCounts.get(laneKey) ?? 0) + 1);

        if (p.blocked) {
          blocked++;
          blockedStreams.push({
            stream: p.stream,
            source: p.source ?? null,
            error: p.error || null,
            retry: p.retry,
            at: p.at,
            gap,
            priority: p.priority,
            lane: p.lane ?? null,
          });
        } else if (p.leased_by && p.leased_until && p.leased_until > now) {
          leased++;
          activeLeases.push({
            stream: p.stream,
            source: p.source ?? null,
            leased_by: p.leased_by,
            leased_until: p.leased_until.toISOString(),
            priority: p.priority,
            lane: p.lane ?? null,
          });
        } else if (gap > 10) {
          lagging++;
        } else {
          healthy++;
        }
      }

      // Watermark histogram
      const buckets = [
        { label: "0", min: 0, max: 0, count: 0 },
        { label: "1-10", min: 1, max: 10, count: 0 },
        { label: "11-50", min: 11, max: 50, count: 0 },
        { label: "51-100", min: 51, max: 100, count: 0 },
        { label: "100+", min: 101, max: Infinity, count: 0 },
      ];
      for (const gap of gaps) {
        for (const b of buckets) {
          if (gap >= b.min && gap <= b.max) {
            b.count++;
            break;
          }
        }
      }

      return {
        total: positions.length,
        healthy,
        blocked,
        leased,
        lagging,
        maxEventId,
        blockedStreams: blockedStreams.sort((a, b) => b.gap - a.gap),
        activeLeases,
        histogram: buckets,
        // Sorted highest-priority first so a UI can spot non-default
        // lanes at a glance.
        priorityCounts: [...priorityCounts.entries()]
          .sort((a, b) => b[0] - a[0])
          .map(([priority, count]) => ({ priority, count })),
        // Sorted by count desc so the busiest lane is the first chip.
        // Default lane sorts naturally alongside others — operators can
        // see "30 streams on writes, 5 on default" at a glance.
        laneCounts: [...laneCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([lane, count]) => ({ lane, count })),
        timestamp: new Date().toISOString(),
      };
    } catch {
      return {
        total: 0,
        healthy: 0,
        blocked: 0,
        leased: 0,
        lagging: 0,
        maxEventId: 0,
        blockedStreams: [],
        activeLeases: [],
        histogram: [],
        priorityCounts: [],
        laneCounts: [],
        timestamp: new Date().toISOString(),
      };
    }
  }),

  /** Export events as CSV rows */
  backup: t.procedure
    .input(
      z.object({
        stream: z.string().optional(),
        names: z.string().array().optional(),
        created_before: z.string().optional(),
        created_after: z.string().optional(),
        correlation: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const s = getStore();
      const events: AnyEvent[] = [];
      await s.query<Schemas>(collect(events), {
        ...input,
        created_before: toDate(input.created_before),
        created_after: toDate(input.created_after),
        with_snaps: true,
      });

      // Build CSV
      const header = CSV_COLUMNS.join(",");
      const rows = events.map((e) =>
        CSV_COLUMNS.map((col) => {
          const val = e[col];
          if (col === "data" || col === "meta")
            return csvEscape(JSON.stringify(val));
          if (val instanceof Date) return csvEscape(val.toISOString());
          return csvEscape(
            typeof val === "object" && val !== null
              ? JSON.stringify(val)
              : String(val)
          );
        }).join(",")
      );

      return { csv: [header, ...rows].join("\n"), count: events.length };
    }),

  /**
   * Inspector write-mode status (#698). Tells the UI whether mutation
   * controls should render. Read-only by default; flipped on via the
   * `ACT_INSPECTOR_WRITE=1` env var at server start. The flag is
   * server-static — the UI doesn't get to toggle it, so refresh of a
   * tab can't recover write access that the operator hasn't already
   * granted to the process.
   */
  writeMode: t.procedure.query(() => ({
    enabled: writeEnabled,
    reason: writeEnabled
      ? null
      : "Set ACT_INSPECTOR_WRITE=1 on the inspector server to enable mutations.",
  })),

  /**
   * Bulk-update the scheduling priority of streams matching a filter
   * (#698 / ACT-102). Wraps `Store.prioritize`. Filter shape mirrors
   * `query_streams` so the UI can preview affected counts via the
   * existing query before committing the mutation.
   *
   * Single-stream edits set `stream` + `stream_exact: true`; bulk
   * updates use regex with optional source / blocked / lane scoping.
   * Refuses to run when {@link writeEnabled} is false.
   */
  prioritize: t.procedure
    .input(
      z.object({
        priority: z.number().int(),
        filter: z
          .object({
            stream: z.string().optional(),
            stream_exact: z.boolean().optional(),
            source: z.string().optional(),
            source_exact: z.boolean().optional(),
            blocked: z.boolean().optional(),
            lane: z.string().optional(),
          })
          .default({}),
      })
    )
    .mutation(async ({ input }) => {
      if (!writeEnabled)
        throw new Error(
          "Inspector is in read-only mode. Set ACT_INSPECTOR_WRITE=1 on the server."
        );
      const s = getStore();
      const affected = await s.prioritize(input.filter, input.priority);
      recordAudit({
        timestamp: new Date().toISOString(),
        action: "prioritize",
        filter: input.filter,
        priority: input.priority,
        affected,
      });
      return { ok: true as const, affected };
    }),

  /** Last 100 mutations performed via the inspector (#698). */
  audit: t.procedure.query(() => ({
    entries: [...auditLog].reverse(),
    capacity: AUDIT_CAPACITY,
  })),

  /** Restore events from CSV — drops and re-seeds the store, inserts with sequential IDs */
  restore: t.procedure
    .input(z.object({ csv: z.string() }))
    .mutation(async ({ input }) => {
      if (!currentConfig) throw new Error("Not connected to a store");
      const fqt = `"${currentConfig.schema}"."${currentConfig.table}"`;
      const fqs = `"${currentConfig.schema}"."${currentConfig.table}_streams"`;

      // Parse CSV
      const lines = input.csv.split("\n").filter((l) => l.trim());
      if (lines.length < 2)
        throw new Error("CSV must have a header and at least one row");

      const headerFields = lines[0].split(",");
      const expectedHeader = CSV_COLUMNS.join(",");
      if (headerFields.join(",") !== expectedHeader)
        throw new Error(`Invalid CSV header. Expected: ${expectedHeader}`);

      const rows = lines.slice(1).map((line, lineIdx) => {
        const fields = csvParseLine(line);
        if (fields.length !== CSV_COLUMNS.length)
          throw new Error(
            `Row ${lineIdx + 1}: expected ${CSV_COLUMNS.length} fields, got ${fields.length}`
          );
        return {
          name: fields[1],
          data: JSON.parse(fields[2]),
          stream: fields[3],
          version: parseInt(fields[4], 10),
          created: fields[5],
          meta: JSON.parse(fields[6]),
        };
      });

      // Drop existing data and re-seed
      const client = await getRawClient();
      try {
        await client.query("BEGIN");

        // Truncate events and streams tables, reset sequence
        await client.query(`TRUNCATE TABLE ${fqt} RESTART IDENTITY CASCADE`);
        await client.query(`TRUNCATE TABLE ${fqs}`);

        // Insert events preserving original order (new sequential IDs from 1)
        for (const row of rows) {
          await client.query(
            `INSERT INTO ${fqt}(name, data, stream, version, created, meta)
             VALUES($1, $2, $3, $4, $5, $6)`,
            [row.name, row.data, row.stream, row.version, row.created, row.meta]
          );
        }

        await client.query("COMMIT");
        return { ok: true as const, count: rows.length };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw new Error(
          `Restore failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      } finally {
        await client.end();
      }
    }),
});

export type InspectorRouter = typeof inspectorRouter;
