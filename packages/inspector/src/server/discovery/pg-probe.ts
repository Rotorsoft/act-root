/**
 * Postgres discovery probe (ACT-1122).
 *
 * Lifted verbatim from the original inline `router.ts` discover block —
 * port range scan in parallel, credential walk per open port, schema
 * walk per database. No behavior change versus master; the only
 * difference is the response carries an explicit `kind: "pg"` tag now
 * so the UI can differentiate PG and SQLite discovery rows.
 */
import { createConnection, type Socket } from "node:net";
import pg from "pg";
import type { DiscoveredPgStore, PgDiscoveryInput } from "./types.js";

/** Default PG port range to scan (5430–5480). */
export const PG_PORT_RANGE_START = 5430;
export const PG_PORT_RANGE_END = 5480;

/** Common credential combos tried in order against each open port. */
const COMMON_CREDS: ReadonlyArray<{ user: string; password: string }> = [
  { user: "postgres", password: "postgres" },
  { user: "postgres", password: "" },
  { user: "postgres", password: "password" },
  { user: "root", password: "root" },
  { user: "admin", password: "admin" },
];

/** Check if a TCP port is open with a short timeout. */
function probePort(
  host: string,
  port: number,
  timeout_ms = 500
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket: Socket = createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeout_ms);
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

/** Try to authenticate with a PG server using the given credentials. */
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

/** Find the best Act-shaped event table per schema in a given database. */
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

/**
 * Scan a host's PG port range for Act event stores.
 *
 * Returns one row per `(port, database, schema)` triple that has an
 * Act-shaped table with at least one row. Empty result on no open
 * ports / no matching credentials / no Act tables.
 */
export async function discoverPg(
  input: PgDiscoveryInput
): Promise<DiscoveredPgStore[]> {
  const { host, portFrom, portTo } = input;
  const ports = Array.from(
    { length: portTo - portFrom + 1 },
    (_, i) => portFrom + i
  );
  const portResults = await Promise.all(
    ports.map(async (port) => ({ port, open: await probePort(host, port) }))
  );
  const openPorts = portResults.filter((r) => r.open).map((r) => r.port);

  if (openPorts.length === 0) return [];

  const stores: DiscoveredPgStore[] = [];
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
        for (const row of dbResult.rows) {
          const tables = await findEventTables(
            { host, port, user: creds.user, password: creds.password },
            row.datname
          );
          for (const t of tables) {
            stores.push({
              kind: "pg",
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

      // Working creds found — move on to the next port.
      break;
    }
  }

  return stores;
}
