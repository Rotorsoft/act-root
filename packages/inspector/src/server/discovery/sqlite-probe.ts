/**
 * SQLite discovery probe (ACT-1122).
 *
 * Scans a directory for files matching a glob (default
 * `\.(db|sqlite|sqlite3)$`) and verifies each one is an Act SQLite
 * store by reading its schema.
 *
 * Read-only **in behavior** — the probe only issues `SELECT` and
 * `PRAGMA` reads, never `INSERT` / `UPDATE` / `DELETE` / DDL. We do
 * not pass `?mode=ro` on the libsql URL because `@libsql/client`
 * rejects unsupported URL params; SQLite may still touch `-wal` /
 * `-shm` sidecar files when opening a database in WAL mode, but the
 * database content itself is never modified by this code path.
 *
 * The "Act shape" check looks for both `events` and `streams` tables
 * and the canonical column set on `events` (`stream`, `version`,
 * `meta`). Any failure — missing tables, wrong columns, locked file,
 * permission error — drops the file silently from the result.
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@libsql/client";
import type { DiscoveredSqliteStore, SqliteDiscoveryInput } from "./types.js";

const DEFAULT_FILE_PATTERN = /\.(db|sqlite|sqlite3)$/i;
const REQUIRED_TABLES = ["events", "streams"] as const;
const REQUIRED_EVENT_COLUMNS = ["stream", "version", "meta"] as const;

/** Probe a single file. Returns the discovery row or null. */
export async function probeSqliteFile(
  file: string
): Promise<DiscoveredSqliteStore | null> {
  const client = createClient({ url: `file:${file}` });
  try {
    const tablesResult = await client.execute(
      `SELECT name FROM sqlite_master
       WHERE type='table' AND name IN ('events', 'streams')`
    );
    const presentTables = new Set(tablesResult.rows.map((r) => String(r.name)));
    for (const required of REQUIRED_TABLES) {
      if (!presentTables.has(required)) return null;
    }

    const colResult = await client.execute("PRAGMA table_info(events)");
    const presentCols = new Set(colResult.rows.map((r) => String(r.name)));
    for (const required of REQUIRED_EVENT_COLUMNS) {
      if (!presentCols.has(required)) return null;
    }

    const countResult = await client.execute(
      "SELECT COUNT(*) AS c FROM events"
    );
    const eventCount = Number(countResult.rows[0]?.c ?? 0);

    return {
      kind: "sqlite",
      file,
      table: "events",
      eventCount,
    };
  } catch {
    return null;
  } finally {
    client.close();
  }
}

/**
 * Scan a directory for Act SQLite files.
 *
 * Returns one row per file that passes the schema probe. Empty result
 * on missing / unreadable directory or no matching files.
 */
export async function discoverSqlite(
  input: SqliteDiscoveryInput
): Promise<DiscoveredSqliteStore[]> {
  const { dir, glob } = input;
  let pattern: RegExp;
  try {
    pattern = glob ? new RegExp(glob) : DEFAULT_FILE_PATTERN;
  } catch {
    // Invalid user-supplied regex — bail with an empty result rather
    // than throwing into the tRPC error wrapper.
    return [];
  }

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    // Directory doesn't exist, permission denied, or it's a file —
    // all of which collapse to "no SQLite stores here."
    return [];
  }

  const candidates = entries.filter((name) => pattern.test(name));
  const results = await Promise.all(
    candidates.map((name) => probeSqliteFile(path.join(dir, name)))
  );
  return results.filter((r): r is DiscoveredSqliteStore => r !== null);
}
