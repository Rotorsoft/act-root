import { type Client, createClient } from "@libsql/client";
import type {
  BlockedLease,
  Committed,
  EventMeta,
  Lease,
  Message,
  Query,
  QueryStatsOptions,
  QueryStreams,
  QueryStreamsResult,
  Schemas,
  Store,
  StreamFilter,
  StreamPosition,
  StreamStats,
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
 * **`Store.notify` is intentionally not implemented.** The notify hook is
 * a cross-process wake-up signal that lets a horizontally-scaled Act
 * deployment wake `settle()` immediately on remote commits. SQLite is
 * single-node by design — there is no remote writer to be notified of —
 * so the {@link Act} orchestrator falls back to the existing
 * debounce/poll path, which is correct for this topology.
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
        leased_until TEXT,
        priority INTEGER NOT NULL DEFAULT 0
      )
    `);
    // Migration for tables created before priority lanes (ACT-102).
    // libSQL surfaces "duplicate column" as an error, hence the
    // try/swallow — this mirrors PG's `ADD COLUMN IF NOT EXISTS`.
    try {
      await this.client.execute(
        "ALTER TABLE streams ADD COLUMN priority INTEGER NOT NULL DEFAULT 0"
      );
    } catch {
      // already present
    }
    await this.client.execute(
      "CREATE INDEX IF NOT EXISTS idx_streams_claim ON streams(blocked, priority DESC, at)"
    );
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

  // --- subscribe: idempotent INSERT OR IGNORE (= PG ON CONFLICT DO NOTHING)
  //     plus a UPDATE pass to keep the *max* priority across reactions
  //     targeting the same stream (ACT-102). Operator overrides go
  //     through `prioritize()` instead.
  async subscribe(
    streams: Array<{ stream: string; source?: string; priority?: number }>
  ) {
    const tx = await this.client.transaction("write");
    try {
      let subscribed = 0;
      for (const { stream, source, priority = 0 } of streams) {
        const inserted = await tx.execute({
          sql: "INSERT OR IGNORE INTO streams (stream, source, priority) VALUES (?, ?, ?)",
          args: [stream, source ?? null, priority],
        });
        if (inserted.rowsAffected > 0) {
          subscribed++;
        } else if (priority > 0) {
          await tx.execute({
            sql: "UPDATE streams SET priority = ? WHERE stream = ? AND priority < ?",
            args: [priority, stream, priority],
          });
        }
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
        sql: `SELECT stream, source, at, priority FROM streams
              WHERE blocked = 0 AND (leased_until IS NULL OR leased_until <= ?)
              ORDER BY priority DESC, at ASC`,
        args: [now],
      });

      const candidates: {
        stream: string;
        source: string | undefined;
        at: number;
        priority: number;
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
          candidates.push({
            stream,
            source: source ?? undefined,
            at,
            priority: Number(row.priority),
          });
        }
      }

      // Dual frontier: lagging (priority DESC, watermark ASC — ACT-102)
      // + leading (newest first). The candidates list arrives sorted
      // by `priority DESC, at ASC` from the SELECT above, so the
      // `slice(0, lagging)` already does the right thing.
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
  async block(leases: BlockedLease[]) {
    const tx = await this.client.transaction("write");
    try {
      const result: BlockedLease[] = [];
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

  /**
   * Translate a {@link StreamFilter} to a SQLite `WHERE` clause fragment
   * plus positional args. Returns `"1"` (always true) when empty so
   * callers can compose it unconditionally.
   */
  private _filterClause(filter: StreamFilter): {
    clause: string;
    args: unknown[];
  } {
    const conditions: string[] = [];
    const args: unknown[] = [];
    if (filter.stream !== undefined) {
      if (filter.stream_exact) {
        conditions.push("stream = ?");
        args.push(filter.stream);
      } else {
        conditions.push("stream LIKE ?");
        args.push(streamPatternToLike(filter.stream));
      }
    }
    if (filter.source !== undefined) {
      conditions.push("source IS NOT NULL");
      if (filter.source_exact) {
        conditions.push("source = ?");
        args.push(filter.source);
      } else {
        conditions.push("source LIKE ?");
        args.push(streamPatternToLike(filter.source));
      }
    }
    if (filter.blocked !== undefined) {
      conditions.push("blocked = ?");
      args.push(filter.blocked ? 1 : 0);
    }
    return { clause: conditions.length ? conditions.join(" AND ") : "1", args };
  }

  // --- reset: transactional, accepts names or filter ---
  async reset(input: string[] | StreamFilter) {
    const setClause = `SET at = -1, retry = 0, blocked = 0, error = '',
                          leased_by = NULL, leased_until = NULL`;
    const tx = await this.client.transaction("write");
    try {
      let count = 0;
      if (Array.isArray(input)) {
        for (const stream of input) {
          const r = await tx.execute({
            sql: `UPDATE streams ${setClause} WHERE stream = ?`,
            args: [stream],
          });
          count += r.rowsAffected;
        }
      } else {
        const { clause, args } = this._filterClause(input);
        const r = await tx.execute({
          sql: `UPDATE streams ${setClause} WHERE ${clause}`,
          args: args as any[],
        });
        count = r.rowsAffected;
      }
      await tx.commit();
      return count;
    } catch (e) {
      await tx.rollback();
      throw e;
    }
  }

  // --- unblock: clear blocked + retry + lease without touching watermark ---
  // `retry = -1` so claim's post-bump returns retry=0 (first attempt),
  // matching the InMemoryStore convention.
  async unblock(input: string[] | StreamFilter) {
    const setClause = `SET retry = -1, blocked = 0, error = '',
                          leased_by = NULL, leased_until = NULL`;
    const tx = await this.client.transaction("write");
    try {
      let count = 0;
      if (Array.isArray(input)) {
        for (const stream of input) {
          const r = await tx.execute({
            sql: `UPDATE streams ${setClause}
                  WHERE stream = ? AND blocked = 1`,
            args: [stream],
          });
          count += r.rowsAffected;
        }
      } else {
        // Filter form: force blocked = true regardless of what the
        // caller passed.
        const { clause, args } = this._filterClause({
          ...input,
          blocked: true,
        });
        const r = await tx.execute({
          sql: `UPDATE streams ${setClause} WHERE ${clause}`,
          args: args as any[],
        });
        count = r.rowsAffected;
      }
      await tx.commit();
      return count;
    } catch (e) {
      await tx.rollback();
      throw e;
    }
  }

  // --- query_streams: read-only introspection with filters ---
  async query_streams(
    callback: (position: StreamPosition) => void,
    query?: QueryStreams
  ): Promise<QueryStreamsResult> {
    const limit = query?.limit ?? 100;
    let sql =
      "SELECT stream, source, at, retry, blocked, error, leased_by, leased_until, priority FROM streams WHERE 1=1";
    const args: unknown[] = [];

    if (query?.stream !== undefined) {
      if (query.stream_exact) {
        sql += " AND stream = ?";
        args.push(query.stream);
      } else {
        sql += " AND stream LIKE ?";
        args.push(streamPatternToLike(query.stream));
      }
    }
    if (query?.source !== undefined) {
      sql += " AND source IS NOT NULL";
      if (query.source_exact) {
        sql += " AND source = ?";
        args.push(query.source);
      } else {
        sql += " AND source LIKE ?";
        args.push(streamPatternToLike(query.source));
      }
    }
    if (query?.blocked !== undefined) {
      sql += " AND blocked = ?";
      args.push(query.blocked ? 1 : 0);
    }
    if (query?.after !== undefined) {
      sql += " AND stream > ?";
      args.push(query.after);
    }
    sql += " ORDER BY stream LIMIT ?";
    args.push(limit);

    const [streamsResult, maxResult] = await Promise.all([
      this.client.execute({ sql, args: args as any[] }),
      this.client.execute("SELECT COALESCE(MAX(id), -1) AS m FROM events"),
    ]);

    let count = 0;
    for (const row of streamsResult.rows) {
      const leased_until = row.leased_until as string | null;
      callback({
        stream: row.stream as string,
        source: (row.source as string | null) ?? undefined,
        at: Number(row.at),
        retry: Number(row.retry),
        blocked: Number(row.blocked) === 1,
        error: row.error as string,
        priority: Number(row.priority),
        leased_by: (row.leased_by as string | null) ?? undefined,
        leased_until: leased_until ? new Date(leased_until) : undefined,
      });
      count++;
    }

    return { maxEventId: Number(maxResult.rows[0].m), count };
  }

  /**
   * Per-stream aggregated stats — see {@link Store.query_stats}.
   *
   * **Slice scaffolding (ACT-639 slice 1+2):** stub. Real implementation
   * lands in slice 4 of #639 (`ROW_NUMBER()` window function for heads,
   * `GROUP BY` with `json_group_object` for full-scan path). Throws here
   * so the interface is satisfied but accidental callers get a clear
   * error message until the impl lands.
   */
  async query_stats<E extends Schemas>(
    _input: string[] | StreamFilter,
    _options?: QueryStatsOptions<E>
  ): Promise<Map<string, StreamStats<E>>> {
    throw new Error(
      "SqliteStore.query_stats not implemented yet — see ACT-639 slice 4"
    );
  }

  // --- prioritize: bulk priority update with filter (ACT-102) ---
  async prioritize(filter: StreamFilter, priority: number): Promise<number> {
    const { clause, args: filterArgs } = this._filterClause(filter);
    // libSQL `?` placeholders are positional and NOT reusable, so we
    // bind `priority` twice: once for SET, once for the no-op skip
    // in WHERE.
    const sql = `UPDATE streams SET priority = ?
                 WHERE priority <> ? AND ${clause}`;
    const result = await this.client.execute({
      sql,
      args: [priority, priority, ...filterArgs] as any[],
    });
    return result.rowsAffected;
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
