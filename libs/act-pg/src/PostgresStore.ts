import type {
  Committed,
  EventMeta,
  Lease,
  Logger,
  Message,
  Query,
  Schemas,
  Store,
} from "@rotorsoft/act";
import { ConcurrencyError, SNAP_EVENT, log } from "@rotorsoft/act";
import pg from "pg";
import { dateReviver } from "./utils.js";
const logger: Logger = log();

const { Pool, types } = pg;
types.setTypeParser(types.builtins.JSONB, (val) =>
  JSON.parse(val, dateReviver)
);

type Config = Readonly<{ schema: string; table: string }> & pg.PoolConfig;

const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
function assertSafeIdentifier(value: string, label: string) {
  if (!SAFE_IDENTIFIER.test(value))
    throw new Error(`Unsafe SQL identifier for ${label}: "${value}"`);
}

const DEFAULT_CONFIG: Config = {
  host: "localhost",
  port: 5432,
  database: "postgres",
  user: "postgres",
  password: "postgres",
  schema: "public",
  table: "events",
};

/**
 * Production-ready PostgreSQL event store implementation.
 *
 * PostgresStore provides persistent, scalable event storage using PostgreSQL.
 * It implements the full {@link Store} interface with production-grade features:
 *
 * **Features:**
 * - Persistent event storage with ACID guarantees
 * - Optimistic concurrency control via version numbers
 * - Distributed stream processing with leasing
 * - Snapshot support for performance optimization
 * - Connection pooling for scalability
 * - Automatic table and index creation
 *
 * **Database Schema:**
 * - Events table: Stores all committed events
 * - Streams table: Tracks stream metadata and leases
 * - Indexes on stream, version, and timestamps for fast queries
 *
 * @example Basic setup
 * ```typescript
 * import { store } from "@rotorsoft/act";
 * import { PostgresStore } from "@rotorsoft/act-pg";
 *
 * store(new PostgresStore({
 *   host: "localhost",
 *   port: 5432,
 *   database: "myapp",
 *   user: "postgres",
 *   password: "secret"
 * }));
 *
 * const app = act()
 *   .withState(Counter)
 *   .build();
 * ```
 *
 * @example With custom schema and table
 * ```typescript
 * import { PostgresStore } from "@rotorsoft/act-pg";
 *
 * const pgStore = new PostgresStore({
 *   host: process.env.DB_HOST || "localhost",
 *   port: parseInt(process.env.DB_PORT || "5432"),
 *   database: process.env.DB_NAME || "myapp",
 *   user: process.env.DB_USER || "postgres",
 *   password: process.env.DB_PASSWORD,
 *   schema: "events",      // Custom schema
 *   table: "act_events"    // Custom table name
 * });
 *
 * // Initialize tables
 * await pgStore.seed();
 * ```
 *
 * @example Connection pooling configuration
 * ```typescript
 * // PostgresStore uses node-postgres (pg) connection pooling
 * // Pool is created automatically with default settings
 * // For custom pool config, use environment variables:
 * //   PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD
 * //   PGMAXCONNECTIONS, PGIDLETIMEOUT, etc.
 *
 * const pgStore = new PostgresStore({
 *   host: "db.example.com",
 *   port: 5432,
 *   database: "production",
 *   user: "app_user",
 *   password: process.env.DB_PASSWORD
 * });
 * ```
 *
 * @example Multi-tenant setup
 * ```typescript
 * // Use separate schemas per tenant
 * const tenants = ["tenant1", "tenant2", "tenant3"];
 *
 * for (const tenant of tenants) {
 *   const tenantStore = new PostgresStore({
 *     host: "localhost",
 *     database: "multitenant",
 *     schema: tenant,        // Each tenant gets own schema
 *     table: "events"
 *   });
 *   await tenantStore.seed();
 * }
 * ```
 *
 * @example Querying PostgreSQL directly
 * ```typescript
 * // For advanced queries, you can access pg client
 * const pgStore = new PostgresStore(config);
 * await pgStore.seed();
 *
 * // Use the store's query method for standard queries
 * await pgStore.query(
 *   (event) => console.log(event),
 *   { stream: "user-123", limit: 100 }
 * );
 * ```
 *
 * @see {@link Store} for the interface definition
 * @see {@link InMemoryStore} for development/testing
 * @see {@link store} for injecting stores
 * @see {@link https://node-postgres.com/ | node-postgres documentation}
 *
 * @category Adapters
 */
export class PostgresStore implements Store {
  private _pool;
  readonly config: Config;
  private _fqt: string;
  private _fqs: string;

  /**
   * Create a new PostgresStore instance.
   * @param config Partial configuration (host, port, user, password, schema, table, etc.)
   */
  constructor(config: Partial<Config> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    assertSafeIdentifier(this.config.schema, "schema");
    assertSafeIdentifier(this.config.table, "table");
    const { schema: _, table: __, ...poolConfig } = this.config;
    this._pool = new Pool(poolConfig);
    this._fqt = `"${this.config.schema}"."${this.config.table}"`;
    this._fqs = `"${this.config.schema}"."${this.config.table}_streams"`;
  }

  /**
   * Dispose of the store and close all database connections.
   * @returns Promise that resolves when all connections are closed
   */
  async dispose() {
    await this._pool.end();
  }

  /**
   * Seed the database with required tables, indexes, and schema for event storage.
   * @returns Promise that resolves when seeding is complete
   * @throws Error if seeding fails
   */
  async seed() {
    const client = await this._pool.connect();

    try {
      await client.query("BEGIN");

      // Create schema
      await client.query(
        `CREATE SCHEMA IF NOT EXISTS "${this.config.schema}";`
      );

      // Events table
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${this._fqt} (
          id serial PRIMARY KEY,
          name varchar(100) COLLATE pg_catalog."default" NOT NULL,
          data jsonb,
          stream varchar(100) COLLATE pg_catalog."default" NOT NULL,
          version int NOT NULL,
          created timestamptz NOT NULL DEFAULT now(),
          meta jsonb
        ) TABLESPACE pg_default;`
      );

      // Indexes on events
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS "${this.config.table}_stream_ix" 
        ON ${this._fqt} (stream COLLATE pg_catalog."default", version);`
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS "${this.config.table}_name_ix" 
        ON ${this._fqt} (name COLLATE pg_catalog."default");`
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS "${this.config.table}_created_id_ix" 
        ON ${this._fqt} (created, id);`
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS "${this.config.table}_correlation_ix" 
        ON ${this._fqt} ((meta ->> 'correlation') COLLATE pg_catalog."default");`
      );

      // Streams table
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${this._fqs} (
          stream varchar(100) COLLATE pg_catalog."default" PRIMARY KEY,
          source varchar(100) COLLATE pg_catalog."default",
          at int NOT NULL DEFAULT -1,
          retry smallint NOT NULL DEFAULT 0,
          blocked boolean NOT NULL DEFAULT false,
          error text,
          leased_at int,
          leased_by text,
          leased_until timestamptz
        ) TABLESPACE pg_default;`
      );

      // Index for fetching streams
      await client.query(
        `CREATE INDEX IF NOT EXISTS "${this.config.table}_streams_fetch_ix" 
        ON ${this._fqs} (blocked, at);`
      );

      await client.query("COMMIT");
      logger.info(
        `Seeded schema "${this.config.schema}" with table "${this.config.table}"`
      );
    } catch (error) {
      await client.query("ROLLBACK");
      logger.error(error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Drop all tables and schema created by the store (for testing or cleanup).
   * @returns Promise that resolves when the schema is dropped
   */
  async drop() {
    await this._pool.query(
      `
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.schemata
          WHERE schema_name = '${this.config.schema}'
        ) THEN
          EXECUTE 'DROP TABLE IF EXISTS ${this._fqt}';
          EXECUTE 'DROP TABLE IF EXISTS ${this._fqs}';
          IF '${this.config.schema}' <> 'public' THEN
            EXECUTE 'DROP SCHEMA "${this.config.schema}" CASCADE';
          END IF;
        END IF;
      END
      $$;
    `
    );
  }

  /**
   * Query events from the store, optionally filtered by stream, event name, time, etc.
   *
   * @param callback Function called for each event found
   * @param query (Optional) Query filter (stream, names, before, after, etc.)
   * @returns The number of events found
   *
   * @example
   * await store.query((event) => console.log(event), { stream: "A" });
   */
  async query<E extends Schemas>(
    callback: (event: Committed<E, keyof E>) => void,
    query?: Query
  ) {
    const {
      stream,
      names,
      before,
      after,
      limit,
      created_before,
      created_after,
      backward,
      correlation,
      with_snaps = false,
    } = query || {};

    let sql = `SELECT * FROM ${this._fqt}`;
    const conditions: string[] = [];
    const values: any[] = [];

    if (query) {
      if (typeof after !== "undefined") {
        values.push(after);
        conditions.push(`id>$${values.length}`);
      } else {
        conditions.push("id>-1");
      }
      if (stream) {
        values.push(stream);
        conditions.push(`stream ~ $${values.length}`);
      }
      if (names && names.length) {
        values.push(names);
        conditions.push(`name = ANY($${values.length})`);
      }
      if (before) {
        values.push(before);
        conditions.push(`id<$${values.length}`);
      }
      if (created_after) {
        values.push(created_after.toISOString());
        conditions.push(`created>$${values.length}`);
      }
      if (created_before) {
        values.push(created_before.toISOString());
        conditions.push(`created<$${values.length}`);
      }
      if (correlation) {
        values.push(correlation);
        conditions.push(`meta->>'correlation'=$${values.length}`);
      }
      if (!with_snaps) {
        conditions.push(`name <> '${SNAP_EVENT}'`);
      }
    }
    if (conditions.length) {
      sql += " WHERE " + conditions.join(" AND ");
    }
    sql += ` ORDER BY id ${backward ? "DESC" : "ASC"}`;
    if (limit) {
      values.push(limit);
      sql += ` LIMIT $${values.length}`;
    }

    const result = await this._pool.query<Committed<E, keyof E>>(sql, values);
    for (const row of result.rows) callback(row);

    return result.rowCount ?? 0;
  }

  /**
   * Commit new events to the store for a given stream, with concurrency control.
   *
   * @param stream The stream name
   * @param msgs Array of messages (event name and data)
   * @param meta Event metadata (correlation, causation, etc.)
   * @param expectedVersion (Optional) Expected stream version for concurrency control
   * @returns Array of committed events
   * @throws ConcurrencyError if the expected version does not match
   */
  async commit<E extends Schemas>(
    stream: string,
    msgs: Message<E, keyof E>[],
    meta: EventMeta,
    expectedVersion?: number
  ) {
    if (msgs.length === 0) return [];
    const client = await this._pool.connect();
    let version = -1;
    try {
      await client.query("BEGIN");

      const last = await client.query<Committed<E, keyof E>>(
        `SELECT version
        FROM ${this._fqt}
        WHERE stream=$1 ORDER BY version DESC LIMIT 1`,
        [stream]
      );
      version = last.rowCount ? last.rows[0].version : -1;
      if (typeof expectedVersion === "number" && version !== expectedVersion)
        throw new ConcurrencyError(
          stream,
          version,
          msgs as unknown as Message<Schemas, string>[],
          expectedVersion
        );

      const committed: Committed<E, keyof E>[] = [];
      for (const { name, data } of msgs) {
        version++;
        const sql = `
          INSERT INTO ${this._fqt}(name, data, stream, version, meta)
          VALUES($1, $2, $3, $4, $5) RETURNING *`;
        const vals = [name, data, stream, version, meta];
        const { rows } = await client.query<Committed<E, keyof E>>(sql, vals);
        committed.push(rows.at(0)!);
      }

      await client
        .query(
          `
            NOTIFY "${this.config.table}", '${JSON.stringify({
              operation: "INSERT",
              id: committed[0].name,
              position: committed[0].id,
            })}';
            COMMIT;
            `
        )
        .catch((error) => {
          logger.error(error);
          throw new ConcurrencyError(
            stream,
            version,
            msgs as unknown as Message<Schemas, string>[],
            expectedVersion || -1
          );
        });
      return committed;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Atomically discovers and leases streams for reaction processing.
   *
   * Uses `FOR UPDATE SKIP LOCKED` to implement zero-contention competing consumers:
   * - Workers never block each other — locked rows are silently skipped
   * - Discovery and locking happen in a single atomic transaction
   * - No wasted polls — every returned stream is exclusively owned
   *
   * @param lagging - Max streams from lagging frontier (ascending watermark)
   * @param leading - Max streams from leading frontier (descending watermark)
   * @param by - Lease holder identifier (UUID)
   * @param millis - Lease duration in milliseconds
   * @returns Leased streams with metadata
   */
  async claim(
    lagging: number,
    leading: number,
    by: string,
    millis: number
  ): Promise<Lease[]> {
    const client = await this._pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{
        stream: string;
        source: string | null;
        at: number;
        retry: number;
        lagging: boolean;
      }>(
        `
        WITH
        available AS (
          SELECT stream, source, at
          FROM ${this._fqs} s
          WHERE blocked = false
            AND (leased_by IS NULL OR leased_until <= NOW())
            AND (s.at < 0 OR EXISTS (
              SELECT 1 FROM ${this._fqt} e
              WHERE e.id > s.at
                AND e.name <> '${SNAP_EVENT}'
                AND (s.source IS NULL OR e.stream = COALESCE(s.source, s.stream))
              LIMIT 1
            ))
          FOR UPDATE SKIP LOCKED
        ),
        lag AS (
          SELECT stream, source, at, TRUE AS lagging
          FROM available
          ORDER BY at ASC
          LIMIT $1
        ),
        lead AS (
          SELECT stream, source, at, FALSE AS lagging
          FROM available
          ORDER BY at DESC
          LIMIT $2
        ),
        combined AS (
          SELECT DISTINCT ON (stream) stream, source, at, lagging
          FROM (SELECT * FROM lag UNION ALL SELECT * FROM lead) t
          ORDER BY stream, at
        )
        UPDATE ${this._fqs} s
        SET
          leased_by = $3,
          leased_until = NOW() + ($4::integer || ' milliseconds')::interval,
          retry = s.retry + 1
        FROM combined c
        WHERE s.stream = c.stream
        RETURNING s.stream, s.source, s.at, s.retry, c.lagging
        `,
        [lagging, leading, by, millis]
      );
      await client.query("COMMIT");

      return rows.map(({ stream, source, at, retry, lagging }) => ({
        stream,
        source: source ?? undefined,
        at,
        by,
        retry,
        lagging,
      }));
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      logger.error(error);
      return [];
    } finally {
      client.release();
    }
  }

  /**
   * Registers streams for event processing.
   * Upserts stream entries so they become visible to claim().
   * Also returns the current max watermark across all subscriptions.
   * @param streams - Streams to register with optional source.
   * @returns subscribed count and current max watermark.
   */
  async subscribe(
    streams: Array<{ stream: string; source?: string }>
  ): Promise<{ subscribed: number; watermark: number }> {
    const client = await this._pool.connect();
    try {
      await client.query("BEGIN");
      let subscribed = 0;
      if (streams.length) {
        const { rowCount } = await client.query(
          `
          INSERT INTO ${this._fqs} (stream, source)
          SELECT s->>'stream', s->>'source'
          FROM jsonb_array_elements($1::jsonb) AS s
          ON CONFLICT (stream) DO NOTHING
          `,
          [JSON.stringify(streams)]
        );
        subscribed = rowCount ?? 0;
      }
      const { rows } = await client.query<{ max: number | null }>(
        `SELECT COALESCE(MAX(at), -1) AS max FROM ${this._fqs}`
      );
      await client.query("COMMIT");
      return { subscribed, watermark: rows[0]?.max ?? -1 };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      logger.error(error);
      return { subscribed: 0, watermark: -1 };
    } finally {
      client.release();
    }
  }

  /**
   * Acknowledge and release leases after processing, updating stream positions.
   *
   * @param leases - Leases to acknowledge, including last processed watermark and lease holder.
   * @returns Acked leases.
   */
  async ack(leases: Lease[]): Promise<Lease[]> {
    const client = await this._pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{
        stream: string;
        source: string | null;
        at: number;
        retry: number;
        lagging: boolean;
      }>(
        `
      WITH input AS (
        SELECT * FROM jsonb_to_recordset($1::jsonb)
        AS x(stream text, by text, at int, lagging boolean)
      )
      UPDATE ${this._fqs} AS s
      SET
        at = i.at,
        retry = -1,
        leased_by = NULL,
        leased_at = NULL,
        leased_until = NULL
      FROM input i
      WHERE s.stream = i.stream AND s.leased_by = i.by
      RETURNING s.stream, s.source, s.at, s.retry, i.lagging
      `,
        [JSON.stringify(leases)]
      );
      await client.query("COMMIT");

      return rows.map((row) => ({
        stream: row.stream,
        source: row.source ?? undefined,
        at: row.at,
        by: "",
        retry: row.retry,
        lagging: row.lagging,
      }));
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      logger.error(error);
      return [];
    } finally {
      client.release();
    }
  }

  /**
   * Block a stream for processing after failing to process and reaching max retries with blocking enabled.
   * @param leases - Leases to block, including lease holder and last error message.
   * @returns Blocked leases.
   */
  async block(
    leases: Array<Lease & { error: string }>
  ): Promise<(Lease & { error: string })[]> {
    const client = await this._pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{
        stream: string;
        source: string | null;
        at: number;
        by: string;
        retry: number;
        lagging: boolean;
        error: string;
      }>(
        `
      WITH input AS (
        SELECT * FROM jsonb_to_recordset($1::jsonb)
        AS x(stream text, by text, error text, lagging boolean)
      )
      UPDATE ${this._fqs} AS s
      SET blocked = true, error = i.error
      FROM input i
      WHERE s.stream = i.stream AND s.leased_by = i.by AND s.blocked = false
      RETURNING s.stream, s.source, s.at, i.by, s.retry, s.error, i.lagging
      `,
        [JSON.stringify(leases)]
      );
      await client.query("COMMIT");

      return rows.map((row) => ({
        stream: row.stream,
        source: row.source ?? undefined,
        at: row.at,
        by: row.by,
        retry: row.retry,
        lagging: row.lagging,
        error: row.error,
      }));
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      logger.error(error);
      return [];
    } finally {
      client.release();
    }
  }
}
