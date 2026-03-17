import type { Committed, Schemas, Store } from "@rotorsoft/act";
import { PostgresStore } from "@rotorsoft/act-pg";
import { initTRPC } from "@trpc/server";
import { createConnection, type Socket } from "net";
import pg from "pg";
import { z } from "zod";

const t = initTRPC.create();

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

/** Get a raw pg client for streams table queries */
async function getStreamsClient(): Promise<{ client: pg.Client; fqs: string }> {
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
  const fqs = `"${currentConfig.schema}"."${currentConfig.table}_streams"`;
  return { client, fqs };
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
      })
    )
    .mutation(async ({ input }) => {
      try {
        if (currentStore) {
          await currentStore.dispose();
          currentStore = null;
        }
        const newStore = new PostgresStore(input);
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

  /** Get distinct stream names for filter suggestions */
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

      const events: AnyEvent[] = [];
      await s.query<Schemas>(collect(events), { with_snaps: true });

      const streamMap = new Map<
        string,
        { count: number; lastEvent: string; lastVersion: number }
      >();

      for (const e of events) {
        const existing = streamMap.get(e.stream);
        if (!existing || e.version > existing.lastVersion) {
          streamMap.set(e.stream, {
            count: (existing?.count ?? 0) + 1,
            lastEvent: String(e.created),
            lastVersion: e.version,
          });
        } else {
          existing.count++;
        }
      }

      return [...streamMap.entries()]
        .map(([stream, info]) => ({
          stream,
          eventCount: info.count,
          lastEvent: info.lastEvent,
          currentVersion: info.lastVersion,
        }))
        .sort((a, b) => b.eventCount - a.eventCount)
        .slice(0, input?.limit ?? 100);
    }),

  /** Get stream processing metadata from the streams table (PG-specific) */
  streamMeta: t.procedure.query(async () => {
    let pgClient: pg.Client | undefined;
    try {
      const { client, fqs } = await getStreamsClient();
      pgClient = client;
      const result = await client.query<{
        stream: string;
        source: string | null;
        at: number;
        retry: number;
        blocked: boolean;
        error: string | null;
        leased_at: number | null;
        leased_by: string | null;
        leased_until: string | null;
      }>(
        `SELECT stream, source, at, retry, blocked, error, leased_at, leased_by, leased_until FROM ${fqs} ORDER BY stream`
      );
      return result.rows;
    } catch {
      return [];
    } finally {
      if (pgClient) await pgClient.end();
    }
  }),
});

export type InspectorRouter = typeof inspectorRouter;
