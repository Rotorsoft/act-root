import { createClient, type Client } from "@libsql/client";
import type {
  Committed,
  EventMeta,
  Lease,
  Message,
  Query,
  Schemas,
  Store,
} from "@rotorsoft/act";

/**
 * SQLite store configuration
 */
export interface SqliteConfig {
  /** Path to the SQLite database file (default: ":memory:") */
  url: string;
  /** Auth token for libSQL server connections (optional) */
  authToken?: string;
}

const DEFAULT_CONFIG: SqliteConfig = {
  url: "file::memory:",
};

/** Translate a stream filter (regex-shaped or plain substring) into a
 *  SQL LIKE pattern. Honors `^` / `$` anchors and converts `.*` → `%`,
 *  `.` → `_`. Unanchored input gets `%` wildcards on both sides.
 *
 *  Examples:
 *  - `^abc$`  → `abc`        (exact)
 *  - `^abc.*` → `abc%`       (starts-with)
 *  - `.*abc$` → `%abc`       (ends-with)
 *  - `abc`    → `%abc%`      (contains)
 *  - `a.c`    → `%a_c%`      (single-char wildcard, contains)
 *
 *  @internal exported for testing
 */
export function streamPatternToLike(input: string): string {
  let s = input;
  const start = s.startsWith("^");
  const end = s.endsWith("$");
  if (start) s = s.slice(1);
  if (end) s = s.slice(0, -1);
  s = s.replace(/\.\*/g, "%").replace(/\./g, "_");
  const out = (start ? "" : "%") + s + (end ? "" : "%");
  // Collapse adjacent `%` — e.g. `^a.*` would otherwise yield `a%%`.
  // Same matching semantics, cleaner output.
  return out.replace(/%+/g, "%");
}

/**
 * SQLite event store adapter for [@rotorsoft/act](https://www.npmjs.com/package/@rotorsoft/act).
 *
 * Provides persistent event storage using SQLite via `@libsql/client`.
 * All write operations use transactions for ACID guarantees.
 * Since SQLite serializes writes at the database level, the concurrency
 * model is equivalent to PostgreSQL's `FOR UPDATE SKIP LOCKED` for
 * single-server deployments.
 *
 * @example
 * ```typescript
 * import { store } from "@rotorsoft/act";
 * import { SqliteStore } from "@rotorsoft/act-sqlite";
 *
 * store(new SqliteStore({ url: "file:myapp.db" }));
 * await store().seed();
 * ```
 */
export class SqliteStore implements Store {
  private client: Client;

  constructor(config: Partial<SqliteConfig> = {}) {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    this.client = createClient({
      url: cfg.url,
      authToken: cfg.authToken,
    });
  }

  async seed() {
    await this.client.execute("PRAGMA journal_mode=WAL");
    await this.client.execute(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stream TEXT NOT NULL,
        version INTEGER NOT NULL,
        name TEXT NOT NULL,
        data TEXT NOT NULL,
        meta TEXT NOT NULL,
        created TEXT NOT NULL,
        UNIQUE(stream, version)
      )
    `);
    await this.client.execute(
      "CREATE INDEX IF NOT EXISTS idx_events_stream ON events(stream)"
    );
    await this.client.execute(
      "CREATE INDEX IF NOT EXISTS idx_events_name ON events(name)"
    );
    await this.client.execute(`
      CREATE TABLE IF NOT EXISTS streams (
        stream TEXT PRIMARY KEY,
        source TEXT,
        at INTEGER NOT NULL DEFAULT -1,
        retry INTEGER NOT NULL DEFAULT 0,
        blocked INTEGER NOT NULL DEFAULT 0,
        error TEXT NOT NULL DEFAULT '',
        leased_by TEXT,
        leased_until TEXT
      )
    `);
  }

  async drop() {
    await this.client.execute("DROP TABLE IF EXISTS events");
    await this.client.execute("DROP TABLE IF EXISTS streams");
  }

  async dispose() {
    await Promise.resolve();
    this.client.close();
  }

  // --- commit: transaction + optimistic concurrency ---
  async commit<E extends Schemas>(
    stream: string,
    msgs: Message<E, keyof E>[],
    meta: EventMeta,
    expectedVersion?: number
  ): Promise<Committed<E, keyof E>[]> {
    const tx = await this.client.transaction("write");
    try {
      const versionRow = await tx.execute({
        sql: "SELECT COALESCE(MAX(version), -1) as v FROM events WHERE stream = ?",
        args: [stream],
      });
      const currentVersion = Number(versionRow.rows[0].v);

      if (
        typeof expectedVersion === "number" &&
        currentVersion !== expectedVersion
      ) {
        const { ConcurrencyError } = await import("@rotorsoft/act");
        throw new ConcurrencyError(
          stream,
          currentVersion,
          msgs as Message<Schemas, keyof Schemas>[],
          expectedVersion
        );
      }

      const now = new Date().toISOString();
      const committed: Committed<E, keyof E>[] = [];
      let version = currentVersion + 1;

      for (const { name, data } of msgs) {
        const result = await tx.execute({
          sql: "INSERT INTO events (stream, version, name, data, meta, created) VALUES (?, ?, ?, ?, ?, ?)",
          args: [
            stream,
            version,
            name as string,
            JSON.stringify(data),
            JSON.stringify(meta),
            now,
          ],
        });
        committed.push({
          id: Number(result.lastInsertRowid),
          stream,
          version,
          created: new Date(now),
          name,
          data,
          meta,
        });
        version++;
      }

      await tx.commit();
      return committed;
    } catch (e) {
      await tx.rollback();
      throw e;
    }
  }

  // --- query: read-only, no transaction needed ---
  async query<E extends Schemas>(
    callback: (event: Committed<E, keyof E>) => void,
    query?: Query
  ): Promise<number> {
    let sql = "SELECT * FROM events WHERE 1=1";
    const args: unknown[] = [];

    if (query?.stream) {
      if (query.stream_exact) {
        sql += " AND stream = ?";
        args.push(query.stream);
      } else {
        sql += " AND stream LIKE ?";
        args.push(streamPatternToLike(query.stream));
      }
    }
    if (query?.names) {
      sql += ` AND name IN (${query.names.map(() => "?").join(",")})`;
      args.push(...query.names);
    }
    if ((query as any)?.correlation) {
      sql += " AND json_extract(meta, '$.correlation') = ?";
      args.push((query as any).correlation);
    }
    if (query?.after !== undefined) {
      sql += " AND id > ?";
      args.push(query.after);
    }
    if (query?.before !== undefined) {
      sql += " AND id < ?";
      args.push(query.before);
    }
    if (query?.created_after) {
      sql += " AND created > ?";
      args.push(query.created_after.toISOString());
    }
    if (query?.created_before) {
      sql += " AND created < ?";
      args.push(query.created_before.toISOString());
    }
    if (!query?.with_snaps) {
      sql += " AND name != '__snapshot__'";
    }

    sql += query?.backward ? " ORDER BY id DESC" : " ORDER BY id ASC";

    if (query?.limit) {
      sql += " LIMIT ?";
      args.push(query.limit);
    }

    const result = await this.client.execute({ sql, args: args as any[] });
    let count = 0;

    for (const row of result.rows) {
      callback({
        id: Number(row.id),
        stream: row.stream as string,
        version: Number(row.version),
        created: new Date(row.created as string),
        name: row.name as string,
        data: JSON.parse(row.data as string),
        meta: JSON.parse(row.meta as string),
      });
      count++;
    }

    return count;
  }

  // --- subscribe: idempotent INSERT OR IGNORE (= PG ON CONFLICT DO NOTHING) ---
  async subscribe(streams: Array<{ stream: string; source?: string }>) {
    const tx = await this.client.transaction("write");
    try {
      let subscribed = 0;
      for (const { stream, source } of streams) {
        const result = await tx.execute({
          sql: "INSERT OR IGNORE INTO streams (stream, source) VALUES (?, ?)",
          args: [stream, source ?? null],
        });
        if (result.rowsAffected > 0) subscribed++;
      }
      const wm = await tx.execute(
        "SELECT COALESCE(MAX(at), -1) as w FROM streams"
      );
      await tx.commit();
      return { subscribed, watermark: Number(wm.rows[0].w) };
    } catch (e) {
      await tx.rollback();
      throw e;
    }
  }

  // --- claim: write transaction (SQLite serializes writes = equivalent
  //     to PG FOR UPDATE SKIP LOCKED for single-server) ---
  async claim(lagging: number, leading: number, by: string, millis: number) {
    const tx = await this.client.transaction("write");
    try {
      const now = new Date().toISOString();

      const result = await tx.execute({
        sql: `SELECT stream, source, at FROM streams
              WHERE blocked = 0 AND (leased_until IS NULL OR leased_until <= ?)
              ORDER BY at ASC`,
        args: [now],
      });

      const candidates: {
        stream: string;
        source: string | undefined;
        at: number;
      }[] = [];
      for (const row of result.rows) {
        const stream = row.stream as string;
        const source = row.source as string | null;
        const at = Number(row.at);

        let hasEvents: boolean;
        if (source) {
          const check = await tx.execute({
            sql: `SELECT 1 FROM events WHERE id > ? AND name != '__snapshot__' AND stream LIKE ? LIMIT 1`,
            args: [at, streamPatternToLike(source)],
          });
          hasEvents = check.rows.length > 0;
        } else {
          const check = await tx.execute({
            sql: `SELECT 1 FROM events WHERE id > ? AND name != '__snapshot__' LIMIT 1`,
            args: [at],
          });
          hasEvents = check.rows.length > 0;
        }

        if (hasEvents) {
          candidates.push({ stream, source: source ?? undefined, at });
        }
      }

      // Dual frontier: lagging (oldest first) + leading (newest first)
      const lag = candidates.slice(0, lagging);
      const lead = [...candidates]
        .sort((a, b) => b.at - a.at)
        .slice(0, leading);
      const seen = new Set<string>();
      const combined = [...lag, ...lead].filter((p) => {
        if (seen.has(p.stream)) return false;
        seen.add(p.stream);
        return true;
      });

      const leases: Lease[] = [];
      const until = new Date(Date.now() + millis).toISOString();
      for (const row of combined) {
        await tx.execute({
          sql: "UPDATE streams SET leased_by = ?, leased_until = ?, retry = retry + 1 WHERE stream = ?",
          args: [by, until, row.stream],
        });
        leases.push({
          stream: row.stream,
          source: row.source,
          at: row.at,
          by,
          retry: 0,
          lagging: row.at < 0,
        });
      }

      await tx.commit();
      return leases;
    } catch (e) {
      await tx.rollback();
      throw e;
    }
  }

  // --- ack: transaction + ownership check (= PG WHERE leased_by) ---
  async ack(leases: Lease[]) {
    const tx = await this.client.transaction("write");
    try {
      const result: Lease[] = [];
      for (const l of leases) {
        const r = await tx.execute({
          sql: `UPDATE streams SET at = ?, leased_by = NULL, leased_until = NULL, retry = -1
                WHERE stream = ? AND leased_by = ?`,
          args: [l.at, l.stream, l.by],
        });
        if (r.rowsAffected > 0) result.push(l);
      }
      await tx.commit();
      return result;
    } catch (e) {
      await tx.rollback();
      throw e;
    }
  }

  // --- block: transaction + ownership + idempotent (= PG) ---
  async block(leases: Array<Lease & { error: string }>) {
    const tx = await this.client.transaction("write");
    try {
      const result: Array<Lease & { error: string }> = [];
      for (const l of leases) {
        const r = await tx.execute({
          sql: `UPDATE streams SET blocked = 1, error = ?
                WHERE stream = ? AND leased_by = ? AND blocked = 0`,
          args: [l.error, l.stream, l.by],
        });
        if (r.rowsAffected > 0) result.push(l);
      }
      await tx.commit();
      return result;
    } catch (e) {
      await tx.rollback();
      throw e;
    }
  }

  // --- reset: transactional ---
  async reset(streams: string[]) {
    const tx = await this.client.transaction("write");
    try {
      let count = 0;
      for (const stream of streams) {
        const r = await tx.execute({
          sql: `UPDATE streams SET at = -1, retry = 0, blocked = 0, error = '',
                leased_by = NULL, leased_until = NULL WHERE stream = ?`,
          args: [stream],
        });
        count += r.rowsAffected;
      }
      await tx.commit();
      return count;
    } catch (e) {
      await tx.rollback();
      throw e;
    }
  }

  // --- truncate: transactional delete + seed ---
  async truncate(
    targets: Array<{
      stream: string;
      snapshot?: Record<string, unknown>;
      meta?: EventMeta;
    }>
  ) {
    const result = new Map<
      string,
      { deleted: number; committed: Committed<Schemas, keyof Schemas> }
    >();

    const tx = await this.client.transaction("write");
    try {
      for (const { stream, snapshot, meta } of targets) {
        const countRow = await tx.execute({
          sql: "SELECT COUNT(*) as c FROM events WHERE stream = ?",
          args: [stream],
        });
        const deleted = Number(countRow.rows[0].c);
        await tx.execute({
          sql: "DELETE FROM events WHERE stream = ?",
          args: [stream],
        });
        await tx.execute({
          sql: "DELETE FROM streams WHERE stream = ?",
          args: [stream],
        });

        const eventName =
          snapshot !== undefined ? "__snapshot__" : "__tombstone__";
        const eventMeta = meta ?? { correlation: "", causation: {} };
        const now = new Date().toISOString();
        const ins = await tx.execute({
          sql: "INSERT INTO events (stream, version, name, data, meta, created) VALUES (?, 0, ?, ?, ?, ?)",
          args: [
            stream,
            eventName,
            JSON.stringify(snapshot ?? {}),
            JSON.stringify(eventMeta),
            now,
          ],
        });

        result.set(stream, {
          deleted,
          committed: {
            id: Number(ins.lastInsertRowid),
            stream,
            version: 0,
            created: new Date(now),
            name: eventName,
            data: snapshot ?? {},
            meta: eventMeta,
          },
        });
      }
      await tx.commit();
    } catch (e) {
      await tx.rollback();
      throw e;
    }

    return result;
  }
}
