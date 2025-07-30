import type {
  Committed,
  EventMeta,
  Lease,
  Message,
  Query,
  Schemas,
  Store,
} from "@rotorsoft/act";
import { ConcurrencyError, SNAP_EVENT, logger } from "@rotorsoft/act";
import pg from "pg";
import { dateReviver } from "./utils.js";

const { Pool, types } = pg;
types.setTypeParser(types.builtins.JSONB, (val) =>
  JSON.parse(val, dateReviver)
);

type Config = Readonly<{
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  schema: string;
  table: string;
}>;

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
 * @category Adapters
 * @see Store
 *
 * PostgresStore is a production-ready event store adapter for Act, using PostgreSQL as the backend.
 *
 * - Supports event sourcing, leasing, snapshots, and concurrency control.
 * - Designed for high-throughput, scalable, and reliable event storage.
 * - Implements the Act Store interface.
 *
 * @example
 * import { PostgresStore } from "@act/pg";
 * const store = new PostgresStore({ schema: "my_schema", table: "events" });
 * await store.seed();
 *
 * @see https://github.com/rotorsoft/act-root
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
    this._pool = new Pool(this.config);
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
      logger.error("Failed to seed store:", error);
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

      const committed = await Promise.all(
        msgs.map(async ({ name, data }) => {
          version++;
          const sql = `
          INSERT INTO ${this._fqt}(name, data, stream, version, meta) 
          VALUES($1, $2, $3, $4, $5) RETURNING *`;
          const vals = [name, data, stream, version, meta];
          const { rows } = await client.query<Committed<E, keyof E>>(sql, vals);
          return rows.at(0)!;
        })
      );

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
   * Polls the store for unblocked streams needing processing, ordered by lease watermark ascending.
   * @param lagging - Max number of streams to poll in ascending order.
   * @param leading - Max number of streams to poll in descending order.
   * @returns The polled streams.
   */
  async poll(lagging: number, leading: number) {
    const { rows } = await this._pool.query<{
      stream: string;
      at: number;
      source: string;
    }>(
      `
      WITH
      lag AS (
        SELECT stream, at, source
        FROM ${this._fqs}
        WHERE blocked = false AND (leased_by IS NULL OR leased_until <= NOW())
        ORDER BY at ASC
        LIMIT $1
      ),
      lead AS (
        SELECT stream, at, source
        FROM ${this._fqs}
        WHERE blocked = false AND (leased_by IS NULL OR leased_until <= NOW())
        ORDER BY at DESC
        LIMIT $2
      ),
      combined AS (
        SELECT * FROM lag
        UNION ALL
        SELECT * FROM lead
      )
      SELECT DISTINCT ON (stream) stream, at, source
      FROM combined
      ORDER BY stream, at;
      `,
      [lagging, leading]
    );
    return rows;
  }

  /**
   * Lease streams for reaction processing, marking them as in-progress.
   *
   * @param leases - Lease requests for streams, including end-of-lease watermark, lease holder, and source stream.
   * @param millis - Lease duration in milliseconds.
   * @returns Array of leased objects with updated lease info
   */
  async lease(leases: Lease[], millis: number): Promise<Lease[]> {
    const client = await this._pool.connect();
    try {
      await client.query("BEGIN");
      // insert new streams
      await client.query(
        `
        INSERT INTO ${this._fqs} (stream, source)
        SELECT lease->>'stream', lease->>'source'
        FROM jsonb_array_elements($1::jsonb) AS lease
        ON CONFLICT (stream) DO NOTHING
        `,
        [JSON.stringify(leases)]
      );
      // set leases
      const { rows } = await client.query<{
        stream: string;
        source: string | null;
        leased_at: number;
        leased_by: string;
        leased_until: number;
        retry: number;
      }>(
        `
      WITH input AS (
        SELECT * FROM jsonb_to_recordset($1::jsonb)
        AS x(stream text, at int, by text)
      ), free AS (
        SELECT s.stream FROM ${this._fqs} s
        JOIN input i ON s.stream = i.stream
        WHERE s.leased_by IS NULL OR s.leased_until <= NOW()
        FOR UPDATE
      )
      UPDATE ${this._fqs} s
      SET
        leased_by = i.by,
        leased_at = i.at,
        leased_until = NOW() + ($2::integer || ' milliseconds')::interval,
        retry = CASE WHEN $2::integer > 0 THEN s.retry + 1 ELSE s.retry END
      FROM input i, free f
      WHERE s.stream = f.stream AND s.stream = i.stream
      RETURNING s.stream, s.source, s.leased_at, s.leased_by, s.leased_until, s.retry
      `,
        [JSON.stringify(leases), millis]
      );
      await client.query("COMMIT");

      return rows.map(
        ({ stream, source, leased_at, leased_by, leased_until, retry }) => ({
          stream,
          source: source ?? undefined,
          at: leased_at,
          by: leased_by,
          until: new Date(leased_until),
          retry,
        })
      );
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      logger.error(error);
      return [];
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
      }>(
        `
      WITH input AS (
        SELECT * FROM jsonb_to_recordset($1::jsonb)
        AS x(stream text, by text, at int)
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
      RETURNING s.stream, s.source, s.at, s.retry
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
        error: string;
      }>(
        `
      WITH input AS (
        SELECT * FROM jsonb_to_recordset($1::jsonb)
        AS x(stream text, by text, error text)
      )
      UPDATE ${this._fqs} AS s
      SET blocked = true, error = i.error
      FROM input i
      WHERE s.stream = i.stream AND s.leased_by = i.by AND s.blocked = false
      RETURNING s.stream, s.source, s.at, i.by, s.retry, s.error
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
