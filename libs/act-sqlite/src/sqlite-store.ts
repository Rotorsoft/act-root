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
        priority INTEGER NOT NULL DEFAULT 0,
        lane TEXT NOT NULL DEFAULT 'default'
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
    // Migration for tables created before drain lanes (ACT-1103).
    try {
      await this.client.execute(
        "ALTER TABLE streams ADD COLUMN lane TEXT NOT NULL DEFAULT 'default'"
      );
    } catch {
      // already present
    }
    await this.client.execute(
      "CREATE INDEX IF NOT EXISTS idx_streams_claim ON streams(blocked, priority DESC, at)"
    );
    // Lane filter index (ACT-1103).
    await this.client.execute(
      "CREATE INDEX IF NOT EXISTS idx_streams_lane ON streams(lane)"
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
      await Promise.resolve(
        callback({
          id: Number(row.id),
          stream: row.stream as string,
          version: Number(row.version),
          created: new Date(row.created as string),
          name: row.name as string,
          data: JSON.parse(row.data as string),
          meta: JSON.parse(row.meta as string),
        })
      );
      count++;
    }

    return count;
  }

  // --- subscribe: idempotent INSERT OR IGNORE (= PG ON CONFLICT DO NOTHING)
  //     plus a UPDATE pass to keep the *max* priority across reactions
  //     targeting the same stream (ACT-102). Operator overrides go
  //     through `prioritize()` instead.
  async subscribe(
    streams: Array<{
      stream: string;
      source?: string;
      priority?: number;
      lane?: string;
    }>
  ) {
    const tx = await this.client.transaction("write");
    try {
      let subscribed = 0;
      for (const {
        stream,
        source,
        priority = 0,
        lane = "default",
      } of streams) {
        const inserted = await tx.execute({
          sql: "INSERT OR IGNORE INTO streams (stream, source, priority, lane) VALUES (?, ?, ?, ?)",
          args: [stream, source ?? null, priority, lane],
        });
        if (inserted.rowsAffected > 0) {
          subscribed++;
        } else {
          if (priority > 0) {
            await tx.execute({
              sql: "UPDATE streams SET priority = ? WHERE stream = ? AND priority < ?",
              args: [priority, stream, priority],
            });
          }
          // ACT-1103: current subscribe wins on lane.
          await tx.execute({
            sql: "UPDATE streams SET lane = ? WHERE stream = ? AND lane <> ?",
            args: [lane, stream, lane],
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
  async claim(
    lagging: number,
    leading: number,
    by: string,
    millis: number,
    lane?: string
  ) {
    const tx = await this.client.transaction("write");
    try {
      const now = new Date().toISOString();

      const laneClause = lane !== undefined ? " AND lane = ?" : "";
      const result = await tx.execute({
        sql: `SELECT stream, source, at, priority, lane FROM streams
              WHERE blocked = 0 AND (leased_until IS NULL OR leased_until <= ?)${laneClause}
              ORDER BY priority DESC, at ASC`,
        args: lane !== undefined ? [now, lane] : [now],
      });

      const candidates: {
        stream: string;
        source: string | undefined;
        at: number;
        priority: number;
        lane: string;
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
            lane: row.lane as string,
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
          lane: row.lane,
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
    if (filter.lane !== undefined) {
      conditions.push("lane = ?");
      args.push(filter.lane);
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
      "SELECT stream, source, at, retry, blocked, error, leased_by, leased_until, priority, lane FROM streams WHERE 1=1";
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
    if (query?.lane !== undefined) {
      sql += " AND lane = ?";
      args.push(query.lane);
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
        lane: row.lane as string,
      });
      count++;
    }

    return { maxEventId: Number(maxResult.rows[0].m), count };
  }

  /**
   * Per-stream aggregated stats — see {@link Store.query_stats}.
   *
   * Two code paths (mirrors the PostgresStore strategy):
   *
   * - **Heads-only path** (no `count`, no `names`): one or two queries
   *   using `ROW_NUMBER() OVER (PARTITION BY stream ORDER BY version
   *   DESC|ASC)` (SQLite lacks PG's `DISTINCT ON`). Window function +
   *   `WHERE rn = 1` materializes the head (or tail) per stream from
   *   the `(stream, version)` unique index. Parallel `Promise.all` when
   *   tail is requested.
   *
   * - **Full-scan path** (`count` or `names` set): one CTE materializes
   *   the filtered events, then `GROUP BY stream, name` →
   *   `json_group_object(name, n)` for the names map plus `SUM(n)` for
   *   count. Heads (and tails when requested) come from the same scan.
   *
   * SQLite specifics:
   * - `data` and `meta` are stored as TEXT (JSON-encoded); the reader
   *   JSON-parses them when materializing the {@link Committed} rows.
   * - `blocked` is stored as 0/1 integer; the filter converts.
   * - Array input expands to a placeholder list (`IN (?, ?, ...)`)
   *   since SQLite has no native array type.
   */
  async query_stats<E extends Schemas>(
    input: string[] | Pick<StreamFilter, "stream" | "stream_exact">,
    options?: QueryStatsOptions<E>
  ): Promise<Map<string, StreamStats<E>>> {
    const exclude = options?.exclude ?? [];
    const wantTail = options?.tail ?? false;
    const wantCount = options?.count ?? false;
    const wantNames = options?.names ?? false;
    const before = options?.before;
    const fullScan = wantCount || wantNames;

    if (Array.isArray(input) && input.length === 0) {
      return new Map<string, StreamStats<E>>();
    }

    // Build WHERE clause + positional args. Subscription-level filters
    // (source, blocked) are intentionally not accepted — events live in
    // the events table; subscription state in the streams table. For
    // "stats for blocked subscriptions" callers compose with
    // query_streams. So no JOIN here.
    const where: string[] = [];
    const args: unknown[] = [];

    if (Array.isArray(input)) {
      const placeholders = input.map(() => "?").join(",");
      where.push(`e.stream IN (${placeholders})`);
      args.push(...input);
    } else if (input.stream !== undefined) {
      if (input.stream_exact) {
        where.push(`e.stream = ?`);
        args.push(input.stream);
      } else {
        where.push(`e.stream LIKE ?`);
        args.push(streamPatternToLike(input.stream));
      }
    }
    if (exclude.length) {
      const placeholders = exclude.map(() => "?").join(",");
      where.push(`e.name NOT IN (${placeholders})`);
      args.push(...exclude);
    }
    if (before !== undefined) {
      where.push(`e.id < ?`);
      args.push(before);
    }

    const fromClause = `events e`;
    // Always emit a WHERE clause — `WHERE 1=1` short-circuits the
    // empty-filter case without a conditional branch on the generation
    // side. SQLite optimizes the trivial predicate out.
    const whereClause = `WHERE ${where.length ? where.join(" AND ") : "1=1"}`;

    return fullScan
      ? this._queryStatsFullScan<E>(
          fromClause,
          whereClause,
          args,
          wantTail,
          wantCount,
          wantNames
        )
      : this._queryStatsHeadsOnly<E>(fromClause, whereClause, args, wantTail);
  }

  /**
   * Cheap path — head (and optional tail) via ROW_NUMBER() over the
   * `(stream, version)` unique index. Parallel queries when tail set.
   */
  private async _queryStatsHeadsOnly<E extends Schemas>(
    fromClause: string,
    whereClause: string,
    args: unknown[],
    wantTail: boolean
  ): Promise<Map<string, StreamStats<E>>> {
    const cols = `e.id, e.stream, e.version, e.name, e.data, e.created, e.meta`;
    const headSql = `SELECT * FROM (
      SELECT ${cols}, ROW_NUMBER() OVER (PARTITION BY e.stream ORDER BY e.version DESC) AS rn
      FROM ${fromClause}
      ${whereClause}
    ) WHERE rn = 1`;
    const tailSql = wantTail
      ? `SELECT * FROM (
          SELECT ${cols}, ROW_NUMBER() OVER (PARTITION BY e.stream ORDER BY e.version ASC) AS rn
          FROM ${fromClause}
          ${whereClause}
        ) WHERE rn = 1`
      : null;

    const [headRes, tailRes] = await Promise.all([
      this.client.execute({ sql: headSql, args: args as any[] }),
      tailSql
        ? this.client.execute({ sql: tailSql, args: args as any[] })
        : null,
    ]);

    const toCommitted = (row: Record<string, unknown>): Committed<E, keyof E> =>
      ({
        id: Number(row.id),
        stream: row.stream as string,
        version: Number(row.version),
        name: row.name as string,
        data: JSON.parse(row.data as string),
        meta: JSON.parse(row.meta as string),
        created: new Date(row.created as string),
      }) as Committed<E, keyof E>;

    const out = new Map<string, StreamStats<E>>();
    for (const row of headRes.rows) {
      out.set(row.stream as string, {
        head: toCommitted(row as Record<string, unknown>),
      });
    }
    if (tailRes) {
      for (const row of tailRes.rows) {
        // Head and tail share the same WHERE, so any stream returning
        // a tail must also have returned a head — no null check needed.
        (
          out.get(row.stream as string) as {
            head: Committed<E, keyof E>;
            tail?: Committed<E, keyof E>;
          }
        ).tail = toCommitted(row as Record<string, unknown>);
      }
    }
    return out;
  }

  /**
   * Full-scan path — one CTE-based query with per-stream `COUNT(*)` and
   * `json_group_object(name, n)`. Heads (and optional tails) ride free
   * on the same scan.
   */
  private async _queryStatsFullScan<E extends Schemas>(
    fromClause: string,
    whereClause: string,
    args: unknown[],
    wantTail: boolean,
    wantCount: boolean,
    wantNames: boolean
  ): Promise<Map<string, StreamStats<E>>> {
    const tailCte = wantTail
      ? `, tails AS (
          SELECT * FROM (
            SELECT *, ROW_NUMBER() OVER (PARTITION BY stream ORDER BY version ASC) AS rn FROM ef
          ) WHERE rn = 1
        )`
      : "";
    const tailJoin = wantTail ? `LEFT JOIN tails t ON t.stream = h.stream` : "";
    const tailCols = wantTail
      ? `, t.id AS t_id, t.stream AS t_stream, t.version AS t_version,
           t.name AS t_name, t.data AS t_data, t.created AS t_created, t.meta AS t_meta`
      : "";

    const sql = `
      WITH ef AS (
        SELECT e.id, e.stream, e.version, e.name, e.data, e.created, e.meta
        FROM ${fromClause}
        ${whereClause}
      ),
      agg AS (
        SELECT stream,
               SUM(n) AS cnt,
               json_group_object(name, n) AS names
        FROM (
          SELECT stream, name, COUNT(*) AS n
          FROM ef
          GROUP BY stream, name
        )
        GROUP BY stream
      ),
      heads AS (
        SELECT * FROM (
          SELECT *, ROW_NUMBER() OVER (PARTITION BY stream ORDER BY version DESC) AS rn FROM ef
        ) WHERE rn = 1
      )
      ${tailCte}
      SELECT
        h.id, h.stream, h.version, h.name, h.data, h.created, h.meta,
        a.cnt AS agg_count,
        a.names AS agg_names
        ${tailCols}
      FROM heads h
      LEFT JOIN agg a ON a.stream = h.stream
      ${tailJoin}
    `;

    const res = await this.client.execute({ sql, args: args as any[] });

    const toCommitted = (
      id: unknown,
      stream: unknown,
      version: unknown,
      name: unknown,
      data: unknown,
      meta: unknown,
      created: unknown
    ): Committed<E, keyof E> =>
      ({
        id: Number(id),
        stream: stream as string,
        version: Number(version),
        name: name as string,
        data: JSON.parse(data as string),
        meta: JSON.parse(meta as string),
        created: new Date(created as string),
      }) as Committed<E, keyof E>;

    const out = new Map<string, StreamStats<E>>();
    for (const row of res.rows) {
      const r = row as unknown as Record<string, unknown>;
      const stats: {
        head: Committed<E, keyof E>;
        tail?: Committed<E, keyof E>;
        count?: number;
        names?: Record<string, number>;
      } = {
        head: toCommitted(
          r.id,
          r.stream,
          r.version,
          r.name,
          r.data,
          r.meta,
          r.created
        ),
      };
      if (wantTail && r.t_id !== null && r.t_id !== undefined) {
        stats.tail = toCommitted(
          r.t_id,
          r.t_stream,
          r.t_version,
          r.t_name,
          r.t_data,
          r.t_meta,
          r.t_created
        );
      }
      if (wantCount) stats.count = Number(r.agg_count);
      // `agg_names` is non-null when this row exists: heads and agg are
      // both built from the same `ef` CTE, so any stream in heads has
      // at least one matching event and `json_group_object` returns a
      // JSON string (never null) for that group.
      if (wantNames) stats.names = JSON.parse(r.agg_names as string);
      out.set(r.stream as string, stats as StreamStats<E>);
    }
    return out;
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

  /**
   * Atomically wipe-and-rebuild the store inside a single libsql
   * `write` transaction.
   *
   * On any throw inside the driver the transaction rolls back and the
   * store is byte-for-byte unchanged. `DELETE FROM events` + `DELETE
   * FROM streams` wipe both tables; `DELETE FROM sqlite_sequence
   * WHERE name = 'events'` resets the autoincrement counter so the
   * new sequence is dense from 1. `created` is preserved verbatim
   * from the source.
   */
  async restore(
    driver: (
      callback: (event: Committed<Schemas, keyof Schemas>) => Promise<number>
    ) => Promise<void>
  ): Promise<void> {
    const tx = await this.client.transaction("write");
    try {
      await tx.execute("DELETE FROM events");
      await tx.execute("DELETE FROM streams");
      // Reset the autoincrement counter so the new sequence is dense
      // from 1. `DELETE FROM sqlite_sequence WHERE name = '?'` is the
      // canonical SQLite reset; safe even if the row doesn't exist.
      await tx.execute("DELETE FROM sqlite_sequence WHERE name = 'events'");
      await driver(async (event) => {
        const ins = await tx.execute({
          sql: "INSERT INTO events (stream, version, name, data, meta, created) VALUES (?, ?, ?, ?, ?, ?)",
          args: [
            event.stream,
            event.version,
            event.name,
            JSON.stringify(event.data),
            JSON.stringify(event.meta),
            event.created.toISOString(),
          ],
        });
        return Number(ins.lastInsertRowid);
      });
      await tx.commit();
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }
}
