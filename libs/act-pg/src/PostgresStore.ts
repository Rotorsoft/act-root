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
  leaseMillis: number;
}>;

const DEFAULT_CONFIG: Config = {
  host: "localhost",
  port: 5432,
  database: "postgres",
  user: "postgres",
  password: "postgres",
  schema: "public",
  table: "events",
  leaseMillis: 30_000,
};

/**
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

  /**
   * Create a new PostgresStore instance.
   * @param config Partial configuration (host, port, user, password, schema, table, etc.)
   */
  constructor(config: Partial<Config> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this._pool = new Pool(this.config);
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
        `CREATE TABLE IF NOT EXISTS "${this.config.schema}"."${this.config.table}" (
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
        ON "${this.config.schema}"."${this.config.table}" (stream COLLATE pg_catalog."default", version);`
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS "${this.config.table}_name_ix" 
        ON "${this.config.schema}"."${this.config.table}" (name COLLATE pg_catalog."default");`
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS "${this.config.table}_created_id_ix" 
        ON "${this.config.schema}"."${this.config.table}" (created, id);`
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS "${this.config.table}_correlation_ix" 
        ON "${this.config.schema}"."${this.config.table}" ((meta ->> 'correlation') COLLATE pg_catalog."default");`
      );

      // Streams table
      await client.query(
        `CREATE TABLE IF NOT EXISTS "${this.config.schema}"."${this.config.table}_streams" (
          stream varchar(100) COLLATE pg_catalog."default" PRIMARY KEY,
          at int NOT NULL DEFAULT -1,
          retry smallint NOT NULL DEFAULT 0,
          blocked boolean NOT NULL DEFAULT false,
          leased_at int,
          leased_by uuid,
          leased_until timestamptz
        ) TABLESPACE pg_default;`
      );

      // Index for fetching streams
      await client.query(
        `CREATE INDEX IF NOT EXISTS "${this.config.table}_streams_fetch_ix" 
        ON "${this.config.schema}"."${this.config.table}_streams" (blocked, at);`
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
          EXECUTE 'DROP TABLE IF EXISTS "${this.config.schema}"."${this.config.table}"';
          EXECUTE 'DROP TABLE IF EXISTS "${this.config.schema}"."${this.config.table}_streams"';
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
   * @param withSnaps (Optional) If true, includes only events after the last snapshot
   * @returns The number of events found
   *
   * @example
   * await store.query((event) => console.log(event), { stream: "A" });
   */
  async query<E extends Schemas>(
    callback: (event: Committed<E, keyof E>) => void,
    query?: Query,
    withSnaps = false
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
    } = query || {};

    let sql = `SELECT * FROM "${this.config.schema}"."${this.config.table}" WHERE`;
    const values: any[] = [];

    if (withSnaps)
      sql = sql.concat(
        ` id>=COALESCE((SELECT id
            FROM "${this.config.schema}"."${this.config.table}"
            WHERE stream='${stream}' AND name='${SNAP_EVENT}'
            ORDER BY id DESC LIMIT 1), 0)
            AND stream='${stream}'`
      );
    else if (query) {
      if (typeof after !== "undefined") {
        values.push(after);
        sql = sql.concat(" id>$1");
      } else sql = sql.concat(" id>-1");
      if (stream) {
        values.push(stream);
        sql = sql.concat(` AND stream=$${values.length}`);
      }
      if (names && names.length) {
        values.push(names);
        sql = sql.concat(` AND name = ANY($${values.length})`);
      }
      if (before) {
        values.push(before);
        sql = sql.concat(` AND id<$${values.length}`);
      }
      if (created_after) {
        values.push(created_after.toISOString());
        sql = sql.concat(` AND created>$${values.length}`);
      }
      if (created_before) {
        values.push(created_before.toISOString());
        sql = sql.concat(` AND created<$${values.length}`);
      }
      if (correlation) {
        values.push(correlation);
        sql = sql.concat(` AND meta->>'correlation'=$${values.length}`);
      }
    }
    sql = sql.concat(` ORDER BY id ${backward ? "DESC" : "ASC"}`);
    if (limit) {
      values.push(limit);
      sql = sql.concat(` LIMIT $${values.length}`);
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
    const client = await this._pool.connect();
    let version = -1;
    try {
      await client.query("BEGIN");

      const last = await client.query<Committed<E, keyof E>>(
        `SELECT version
        FROM "${this.config.schema}"."${this.config.table}"
        WHERE stream=$1 ORDER BY version DESC LIMIT 1`,
        [stream]
      );
      version = last.rowCount ? last.rows[0].version : -1;
      if (expectedVersion && version !== expectedVersion)
        throw new ConcurrencyError(
          version,
          msgs as unknown as Message<Schemas, string>[],
          expectedVersion
        );

      const committed = await Promise.all(
        msgs.map(async ({ name, data }) => {
          version++;
          const sql = `
          INSERT INTO "${this.config.schema}"."${this.config.table}"(name, data, stream, version, meta) 
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
   * Fetch a batch of events and streams for processing (drain cycle).
   *
   * @param limit The maximum number of events to fetch
   * @returns An object with arrays of streams and events
   */
  async fetch<E extends Schemas>(limit: number) {
    const { rows } = await this._pool.query<{ stream: string; at: number }>(
      `
      SELECT stream, at
      FROM "${this.config.schema}"."${this.config.table}_streams"
      WHERE blocked=false
      ORDER BY at ASC
      LIMIT $1::integer
      `,
      [limit]
    );

    const after = rows.length
      ? rows.reduce((min, r) => Math.min(min, r.at), Number.MAX_SAFE_INTEGER)
      : -1;

    const events: Committed<E, keyof E>[] = [];
    await this.query<E>((e) => e.name !== SNAP_EVENT && events.push(e), {
      after,
      limit,
    });
    return { streams: rows.map(({ stream }) => stream), events };
  }

  /**
   * Lease streams for reaction processing, marking them as in-progress.
   *
   * @param leases Array of lease objects (stream, at, etc.)
   * @returns Array of leased objects with updated lease info
   */
  async lease(leases: Lease[]) {
    const { by, at } = leases.at(0)!;
    const streams = leases.map(({ stream }) => stream);
    const client = await this._pool.connect();

    try {
      await client.query("BEGIN");
      // insert new streams
      await client.query(
        `
        INSERT INTO "${this.config.schema}"."${this.config.table}_streams" (stream)
        SELECT UNNEST($1::text[])
        ON CONFLICT (stream) DO NOTHING
        `,
        [streams]
      );
      // set leases
      const { rows } = await client.query<{
        stream: string;
        leased_at: number;
        retry: number;
      }>(
        `
        WITH free AS (
          SELECT * FROM "${this.config.schema}"."${this.config.table}_streams" 
          WHERE stream = ANY($1::text[]) AND (leased_by IS NULL OR leased_until <= NOW())
          FOR UPDATE
        )
        UPDATE "${this.config.schema}"."${this.config.table}_streams" U
        SET
          leased_by = $2::uuid,
          leased_at = $3::integer,
          leased_until = NOW() + ($4::integer || ' milliseconds')::interval
        FROM free
        WHERE U.stream = free.stream
        RETURNING U.stream, U.leased_at, U.retry
        `,
        [streams, by, at, this.config.leaseMillis]
      );
      await client.query("COMMIT");

      return rows.map(({ stream, leased_at, retry }) => ({
        stream,
        by,
        at: leased_at,
        retry,
        block: false,
      }));
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Acknowledge and release leases after processing, updating stream positions.
   *
   * @param leases Array of lease objects to acknowledge
   * @returns Promise that resolves when leases are acknowledged
   */
  async ack(leases: Lease[]) {
    const client = await this._pool.connect();

    try {
      await client.query("BEGIN");
      for (const { stream, by, at, retry, block } of leases) {
        await client.query(
          `UPDATE "${this.config.schema}"."${this.config.table}_streams"
          SET
            at = $3::integer,
            retry = $4::integer,
            blocked = $5::boolean,
            leased_by = NULL,
            leased_at = NULL,
            leased_until = NULL
          WHERE
            stream = $1::text
            AND leased_by = $2::uuid`,
          [stream, by, at, retry, block]
        );
      }
      await client.query("COMMIT");
    } catch {
      // leased_until fallback
      await client.query("ROLLBACK").catch(() => {});
    } finally {
      client.release();
    }
  }
}
