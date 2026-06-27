import { randomUUID } from "node:crypto";
import type {
  BlockedLease,
  Committed,
  EventMeta,
  Lease,
  Logger,
  Message,
  NotifyDisposer,
  Query,
  QueryStatsOptions,
  QueryStreams,
  QueryStreamsResult,
  Schema,
  Schemas,
  Store,
  StoreNotification,
  StreamFilter,
  StreamPosition,
  StreamStats,
} from "@rotorsoft/act";
import {
  ConcurrencyError,
  log,
  SNAP_EVENT,
  StoreError,
  TOMBSTONE_EVENT,
} from "@rotorsoft/act";
import {
  decrypt,
  type Encryption,
  encrypt,
  makeKeyResolver,
} from "@rotorsoft/act-crypto";
import pg from "pg";
import { dateReviver } from "./utils.js";

const logger: Logger = log();

const { Pool, types } = pg;
types.setTypeParser(types.builtins.JSONB, (val) =>
  JSON.parse(val, dateReviver)
);

type Config = Readonly<{
  schema: string;
  table: string;
  /**
   * Opt in to cross-process commit notifications via `LISTEN`/`NOTIFY`.
   * Optional — defaults to `false` so existing callers keep their
   * current behavior. Setting it to `true` is the only behavior change
   * an upgrading deployment needs to make to enable cross-process
   * reaction wakeup.
   *
   * When `true`:
   * - `commit()` issues `pg_notify` after each successful insert.
   * - `notify(handler)` checks out a dedicated long-lived `LISTEN`
   *   client from the pool and delivers cross-process notifications.
   *
   * When `false` (default):
   * - `commit()` skips the notify SQL entirely — zero per-write
   *   overhead.
   * - The `notify` method is **not present on the instance**, so the
   *   orchestrator's `if (store.notify)` auto-wire short-circuits and
   *   no LISTEN client is allocated.
   *
   * Single-instance deployments should leave this off. Multi-process
   * deployments that need sub-poll reaction latency turn it on
   * **on every store instance** (writers and listeners both).
   */
  notify?: boolean;
  /**
   * Adapter-layer envelope encryption for the `events.pii` column.
   * Optional — when present, every non-null PII payload is encrypted
   * before INSERT and decrypted on every read; when absent, the
   * column is stored and read as plaintext (the framework's default
   * behavior).
   *
   * Cipher and wire format come from `@rotorsoft/act-crypto`:
   * AES-256-GCM with a versioned base64-framed envelope. The
   * jsonb column distinguishes encrypted from plaintext rows by
   * type — encrypted writes land as JSONB strings, plaintext writes
   * as JSONB objects — so existing data continues to read through
   * transparently after enabling encryption on new commits.
   *
   * `forget_pii` semantics are unchanged: the column is set to
   * `NULL` regardless of whether the prior value was plaintext or
   * ciphertext.
   *
   * Encryption at rest at the **storage** layer (`pgcrypto`, RDS
   * TDE, Cloud SQL TDE) composes orthogonally — defense in depth
   * without coordination. See `docs/docs/guides/pii-encryption-at-rest.md`
   * for the full decision matrix.
   */
  pii_encryption?: Encryption;
}> &
  pg.PoolConfig;

const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

// PostgreSQL SQLSTATE for `unique_violation` — surfaces when a concurrent
// commit beats us between the version SELECT and the INSERT, hitting the
// unique index on (stream, version). Stable across PG versions per the
// SQL standard. See: https://www.postgresql.org/docs/current/errcodes-appendix.html
const PG_UNIQUE_VIOLATION = "23505";

// Channel-name prefix for cross-process commit notifications. The
// effective channel is namespaced per `(schema, table)` so two
// PostgresStores pointed at distinct event tables in the same database
// don't cross-talk. PG channel names are case-folded unless quoted; we
// stick to lowercase identifiers so a future `LISTEN act_commit_*` from
// any client (psql, scripts, alternative consumers) matches without
// surprises.
const NOTIFY_CHANNEL_PREFIX = "act_commit";

function notify_channel(schema: string, table: string): string {
  return `${NOTIFY_CHANNEL_PREFIX}_${schema}_${table}`;
}
function assert_safe_identifier(value: string, label: string) {
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
  notify: false,
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
   * Per-instance writer identifier embedded in every NOTIFY payload. The
   * `notify()` LISTEN handler skips payloads where `by === this._by`,
   * giving the `"notified"` lifecycle event a clean cross-process
   * semantic — local commits never echo back through this channel.
   */
  private readonly _by: string = randomUUID();
  /**
   * Effective NOTIFY channel for this store. Computed from `(schema,
   * table)` at construction so multiple stores in the same database
   * stay isolated.
   */
  private readonly _channel: string;
  /** Active LISTEN client (one per `notify()` subscription). */
  private _listen_client: pg.PoolClient | undefined;
  /**
   * Notification listener attached to the active LISTEN client. Tracked
   * separately so the re-subscribe / dispose paths can detach it before
   * destroying the client — without this, a pool that reused the
   * connection would re-fire the stale handler.
   */
  private _listen_handler: ((msg: pg.Notification) => void) | undefined;
  /**
   * Cross-process commit subscription. **Present only when
   * `config.notify === true`** — the orchestrator's auto-wire path
   * checks `if (store.notify)`, so omitting the method keeps
   * single-instance deployments free of any LISTEN/NOTIFY overhead
   * (no dedicated client, no per-commit `pg_notify`).
   *
   * @see {@link Config.notify} for the rationale and the multi-process
   *   contract.
   */
  notify?: (
    handler: (notification: StoreNotification) => void
  ) => Promise<NotifyDisposer>;

  /**
   * Memoized key resolver for the optional `pii_encryption` envelope.
   * Initialized in the constructor when encryption is configured;
   * `undefined` otherwise. The resolver caches the operator's key on
   * first use — rotation means restarting the store with a fresh
   * provider.
   */
  private readonly _resolve_pii_key: (() => Promise<Buffer>) | undefined;

  /**
   * Create a new PostgresStore instance.
   * @param config Partial configuration (host, port, user, password, schema, table, etc.)
   */
  constructor(config: Partial<Config> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    assert_safe_identifier(this.config.schema, "schema");
    assert_safe_identifier(this.config.table, "table");
    const {
      schema: _,
      table: __,
      pii_encryption: ___,
      ...poolConfig
    } = this.config;
    this._pool = new Pool(poolConfig);
    this._fqt = `"${this.config.schema}"."${this.config.table}"`;
    this._fqs = `"${this.config.schema}"."${this.config.table}_streams"`;
    this._channel = notify_channel(this.config.schema, this.config.table);
    // Attach the notify subscriber only when the user opted in. With
    // notify off, `this.notify` is `undefined`, the orchestrator skips
    // its auto-wire, and no LISTEN client is ever allocated.
    if (this.config.notify) {
      this.notify = this._subscribe_notifications.bind(this);
    }
    this._resolve_pii_key = this.config.pii_encryption
      ? makeKeyResolver(this.config.pii_encryption)
      : undefined;
  }

  /**
   * Dispose of the store and close all database connections.
   * Releases any active LISTEN client first so the pool can drain cleanly.
   * @returns Promise that resolves when all connections are closed
   */
  async dispose() {
    await this._teardown_listen();
    await this._pool.end();
  }

  /**
   * Tear down the active LISTEN subscription if any: detach the
   * notification listener, run UNLISTEN, and destroy the dedicated
   * client (do not return it to the pool — its listener is removed but
   * destroying belt-and-braces guards against any future change in
   * pg-pool semantics that could re-issue a half-clean client).
   */
  private async _teardown_listen() {
    if (!this._listen_client) return;
    // _listen_handler is set in lockstep with _listen_client in notify(),
    // so if the client is present, the handler is too.
    this._listen_client.removeListener("notification", this._listen_handler!);
    this._listen_handler = undefined;
    try {
      await this._listen_client.query(`UNLISTEN ${this._channel}`);
    } catch {
      // best-effort — pool end (or destroy) tears the connection down
    }
    this._listen_client.release(true);
    this._listen_client = undefined;
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
          meta jsonb,
          pii jsonb
        ) TABLESPACE pg_default;`
      );
      // Migration for tables created before pii_isolation (#870).
      // Variable-length encoding skips NULL columns entirely, so events
      // without sensitive declarations pay zero extra bytes on disk.
      await client.query(
        `ALTER TABLE ${this._fqt} ADD COLUMN IF NOT EXISTS pii jsonb;`
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
      // Partial index over snapshot rows only, so the with_snaps "resume
      // at the latest snapshot" floor (MAX(id) WHERE stream=? AND
      // name='__snapshot__') is an O(log) lookup and costs nothing for
      // streams that have no snapshot (the index has no rows for them).
      await client.query(
        `CREATE INDEX IF NOT EXISTS "${this.config.table}_snapshot_ix"
        ON ${this._fqt} (stream COLLATE pg_catalog."default", id)
        WHERE name = '${SNAP_EVENT}';`
      );

      // Streams table
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${this._fqs} (
          stream varchar(100) COLLATE pg_catalog."default" PRIMARY KEY,
          source varchar(100) COLLATE pg_catalog."default",
          at int NOT NULL DEFAULT -1,
          retry smallint NOT NULL DEFAULT -1,
          blocked boolean NOT NULL DEFAULT false,
          error text,
          leased_by text,
          leased_until timestamptz,
          priority int NOT NULL DEFAULT 0,
          lane text NOT NULL DEFAULT 'default'
        ) TABLESPACE pg_default;`
      );
      // Migration for tables created before priority lanes (ACT-102).
      // `ADD COLUMN IF NOT EXISTS` is a no-op when the column is
      // already present, so this is safe on every seed call.
      await client.query(
        `ALTER TABLE ${this._fqs}
         ADD COLUMN IF NOT EXISTS priority int NOT NULL DEFAULT 0;`
      );
      // Migration for tables created before drain lanes (ACT-1103).
      await client.query(
        `ALTER TABLE ${this._fqs}
         ADD COLUMN IF NOT EXISTS lane text NOT NULL DEFAULT 'default';`
      );

      // Composite index for `claim()` — `(blocked, priority DESC, at)`
      // matches the lagging-frontier ORDER BY exactly so the planner
      // can serve the lag CTE from the index without a sort. The
      // `_streams_fetch_ix` index is dropped because the new one
      // supersedes it (`(blocked, at)` is a prefix of the new key
      // when the planner reads `priority` as fixed).
      await client.query(
        `DROP INDEX IF EXISTS "${this.config.schema}"."${this.config.table}_streams_fetch_ix"`
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS "${this.config.table}_streams_claim_ix"
        ON ${this._fqs} (blocked, priority DESC, at);`
      );
      // Lane filter index (ACT-1103).
      await client.query(
        `CREATE INDEX IF NOT EXISTS "${this.config.table}_streams_lane_ix"
        ON ${this._fqs} (lane);`
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
      } else if (with_snaps && query.stream_exact && stream) {
        // Resume at the latest snapshot for this stream so pre-snapshot
        // events aren't scanned. No snapshot → MAX is NULL → -1 → full
        // stream. An explicit `after` (above) wins.
        values.push(stream);
        conditions.push(
          `id >= (SELECT COALESCE(MAX(id), -1) FROM ${this._fqt} WHERE stream=$${values.length} AND name='${SNAP_EVENT}')`
        );
      } else {
        conditions.push("id>-1");
      }
      if (stream) {
        values.push(stream);
        conditions.push(
          query.stream_exact
            ? `stream = $${values.length}`
            : `stream ~ $${values.length}`
        );
      }
      if (names?.length) {
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
    for (const row of result.rows) {
      // Decrypt the pii column when encryption is configured and the
      // stored value is a string (encrypted writes land as JSONB
      // strings; plaintext rows land as JSONB objects, including
      // legacy data committed before encryption was enabled). The
      // type-based discriminator means mixed-data rollouts read
      // through transparently. The cast is local — `Committed.pii`
      // is `readonly` on the public type, but rows materialized from
      // the driver are mutable in-flight before they cross back to
      // the framework.
      if (this._resolve_pii_key && typeof row.pii === "string") {
        const decrypted = await decrypt(row.pii, this._resolve_pii_key);
        (row as { pii: unknown }).pii = decrypted;
      }
      await Promise.resolve(callback(row));
    }

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
      for (const { name, data, pii } of msgs) {
        version++;
        const sql = `
          INSERT INTO ${this._fqt}(name, data, pii, stream, version, meta)
          VALUES($1, $2, $3, $4, $5, $6) RETURNING *`;
        // Encrypt the pii payload when encryption is configured and
        // there's anything to encrypt — `null` passes through verbatim
        // so `forget_pii` semantics survive intact (a NULL stays NULL).
        // Encrypted output is `JSON.stringify`-ed so the bare base64
        // string lands in jsonb as a JSON string literal — the pg
        // driver doesn't auto-wrap raw strings before they hit jsonb,
        // and a bare token like `AQAB...` isn't valid JSON on its own.
        const pii_for_write =
          this._resolve_pii_key && pii != null
            ? JSON.stringify(await encrypt(pii, this._resolve_pii_key))
            : (pii ?? null);
        const vals = [name, data, pii_for_write, stream, version, meta];
        try {
          const { rows } = await client.query<Committed<E, keyof E>>(sql, vals);
          const row = rows.at(0)!;
          // Decrypt before handing back to the caller — the committed
          // event the framework returns must carry the cleartext payload
          // (the reducer chain runs against `event.pii`). The encrypted
          // value only lives at rest in the column; never in memory past
          // this point. Same cast rationale as the query path.
          if (this._resolve_pii_key && typeof row.pii === "string") {
            const decrypted = await decrypt(row.pii, this._resolve_pii_key);
            (row as { pii: unknown }).pii = decrypted;
          }
          committed.push(row);
        } catch (error) {
          // PG unique-violation on (stream, version) — a concurrent commit
          // beat us between the version SELECT and this INSERT. Surface as
          // ConcurrencyError so callers retry on the framework signal
          // instead of an adapter-specific error.
          if ((error as { code?: string })?.code === PG_UNIQUE_VIOLATION) {
            throw new ConcurrencyError(
              stream,
              version - 1,
              msgs as unknown as Message<Schemas, string>[],
              expectedVersion ?? -1
            );
          }
          throw error;
        }
      }

      // One NOTIFY per commit transaction, payload carries the full event
      // batch so listeners reason about atomic groups (matches reaction
      // semantics in the rest of the framework). `by` lets other
      // PostgresStore instances self-filter their own writes — see
      // `_subscribe_notifications()`. PG NOTIFY payloads cap at 8000
      // bytes; for typical commits (1–10 events) this is comfortably
      // under, and the polling fallback path handles the rare overflow
      // case correctly. Skipped entirely when `config.notify === false`
      // (the default) so single-instance deployments pay zero
      // per-write overhead.
      if (this.config.notify) {
        const payload = JSON.stringify({
          stream,
          events: committed.map((c) => ({ id: c.id, name: c.name as string })),
          by: this._by,
        });
        await client.query(`SELECT pg_notify($1, $2)`, [
          this._channel,
          payload,
        ]);
      }

      await client.query("COMMIT");
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
    millis: number,
    lane?: string
  ): Promise<Lease[]> {
    const client = await this._pool.connect();
    try {
      await client.query("BEGIN");
      const lane_clause = lane !== undefined ? `AND s.lane = $5` : "";
      const params: unknown[] =
        lane !== undefined
          ? [lagging, leading, by, millis, lane]
          : [lagging, leading, by, millis];
      const { rows } = await client.query<{
        stream: string;
        source: string | null;
        at: number;
        retry: number;
        lagging: boolean;
        lane: string;
      }>(
        `
        WITH
        available AS (
          SELECT stream, source, at, priority, lane
          FROM ${this._fqs} s
          WHERE blocked = false
            ${lane_clause}
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
        -- Priority lanes (ACT-102): higher priority first, then
        -- lagging-watermark order. With everyone at priority=0 the
        -- ORDER BY collapses to plain at ASC so existing workloads
        -- see no behavior change.
        lag AS (
          SELECT stream, source, at, lane, TRUE AS lagging
          FROM available
          ORDER BY priority DESC, at ASC
          LIMIT $1
        ),
        lead AS (
          SELECT stream, source, at, lane, FALSE AS lagging
          FROM available
          ORDER BY at DESC
          LIMIT $2
        ),
        combined AS (
          SELECT DISTINCT ON (stream) stream, source, at, lane, lagging
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
        RETURNING s.stream, s.source, s.at, s.retry, c.lagging, s.lane
        `,
        params
      );
      await client.query("COMMIT");

      return rows.map(({ stream, source, at, retry, lagging, lane }) => ({
        stream,
        source: source ?? undefined,
        at,
        by,
        retry,
        lagging,
        lane,
      }));
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw new StoreError("claim", { cause: error });
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
    streams: Array<{
      stream: string;
      source?: string;
      priority?: number;
      lane?: string;
    }>
  ): Promise<{ subscribed: number; watermark: number }> {
    const client = await this._pool.connect();
    try {
      await client.query("BEGIN");
      let subscribed = 0;
      if (streams.length) {
        // Three statements to keep `subscribed` meaning "newly
        // registered streams" (not "rows touched"):
        //  1. INSERT ... ON CONFLICT DO NOTHING — rowCount = inserts.
        //  2. UPDATE priority on the existing rows whose new value is
        //     higher than the stored one (ACT-102: keep the max so the
        //     highest-priority registered reaction wins). Operator
        //     overrides (which may *decrease*) go through `prioritize()`.
        //  3. UPDATE lane unconditionally — current subscribe wins (ACT-1103).
        const { rowCount: inserted } = await client.query(
          `
          INSERT INTO ${this._fqs} (stream, source, priority, lane, retry)
          SELECT s->>'stream',
                 s->>'source',
                 COALESCE((s->>'priority')::int, 0),
                 COALESCE(s->>'lane', 'default'),
                 -1
          FROM jsonb_array_elements($1::jsonb) AS s
          ON CONFLICT (stream) DO NOTHING
          `,
          [JSON.stringify(streams)]
        );
        subscribed = inserted ?? 0;
        await client.query(
          `
          UPDATE ${this._fqs} t
          SET priority = COALESCE((s->>'priority')::int, 0)
          FROM jsonb_array_elements($1::jsonb) AS s
          WHERE t.stream = s->>'stream'
            AND COALESCE((s->>'priority')::int, 0) > t.priority
          `,
          [JSON.stringify(streams)]
        );
        await client.query(
          `
          UPDATE ${this._fqs} t
          SET lane = COALESCE(s->>'lane', 'default')
          FROM jsonb_array_elements($1::jsonb) AS s
          WHERE t.stream = s->>'stream'
            AND t.lane <> COALESCE(s->>'lane', 'default')
          `,
          [JSON.stringify(streams)]
        );
      }
      const { rows } = await client.query<{ max: number | null }>(
        `SELECT COALESCE(MAX(at), -1) AS max FROM ${this._fqs}`
      );
      await client.query("COMMIT");
      return { subscribed, watermark: rows[0]?.max ?? -1 };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw new StoreError("subscribe", { cause: error });
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
        by: string;
        retry: number;
        lagging: boolean;
        lane: string;
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
        leased_until = NULL
      FROM input i
      WHERE s.stream = i.stream AND s.leased_by = i.by
      RETURNING s.stream, s.source, s.at, i.by, s.retry, i.lagging, s.lane
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
        lane: row.lane,
      }));
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw new StoreError("ack", { cause: error });
    } finally {
      client.release();
    }
  }

  /**
   * Block a stream for processing after failing to process and reaching max retries with blocking enabled.
   * @param leases - Leases to block, including lease holder and last error message.
   * @returns Blocked leases.
   */
  async block(leases: BlockedLease[]): Promise<BlockedLease[]> {
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
        lane: string;
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
      RETURNING s.stream, s.source, s.at, i.by, s.retry, s.error, i.lagging, s.lane
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
        lane: row.lane,
      }));
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw new StoreError("block", { cause: error });
    } finally {
      client.release();
    }
  }

  /**
   * Reset watermarks for the given streams to -1, clearing retry, blocked,
   * error, and lease state so they can be replayed from the beginning.
   * @param streams - Stream names to reset.
   * @returns Count of streams that were actually reset.
   */
  /**
   * Translate a {@link StreamFilter} to a `WHERE` clause fragment and
   * the corresponding parameter values. The fragment never starts with
   * `WHERE` — callers compose it with any other predicates they need.
   * Returns an always-true clause (`true`) when the filter is empty.
   */
  private _filter_clause(
    filter: StreamFilter,
    start: number
  ): { clause: string; values: unknown[] } {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (filter.stream !== undefined) {
      values.push(filter.stream);
      conditions.push(
        filter.stream_exact
          ? `stream = $${start + values.length - 1}`
          : `stream ~ $${start + values.length - 1}`
      );
    }
    if (filter.source !== undefined) {
      conditions.push(`source IS NOT NULL`);
      values.push(filter.source);
      conditions.push(
        filter.source_exact
          ? `source = $${start + values.length - 1}`
          : `source ~ $${start + values.length - 1}`
      );
    }
    if (filter.blocked !== undefined) {
      values.push(filter.blocked);
      conditions.push(`blocked = $${start + values.length - 1}`);
    }
    if (filter.lane !== undefined) {
      values.push(filter.lane);
      conditions.push(`lane = $${start + values.length - 1}`);
    }
    return {
      clause: conditions.length ? conditions.join(" AND ") : "TRUE",
      values,
    };
  }

  async reset(input: string[] | StreamFilter): Promise<number> {
    const set_clause = `SET at = -1, retry = -1, blocked = false, error = NULL,
                          leased_by = NULL, leased_until = NULL`;
    if (Array.isArray(input)) {
      if (!input.length) return 0;
      const { rowCount } = await this._pool.query(
        `UPDATE ${this._fqs} ${set_clause} WHERE stream = ANY($1)`,
        [input]
      );
      return rowCount ?? 0;
    }
    const { clause, values } = this._filter_clause(input, 1);
    const { rowCount } = await this._pool.query(
      `UPDATE ${this._fqs} ${set_clause} WHERE ${clause}`,
      values
    );
    return rowCount ?? 0;
  }

  /**
   * Clear blocked flag (and retry / error / lease state) on streams
   * without touching the `at` watermark. `blocked = true` is always
   * applied, so the return count reflects only streams that were
   * actually flipped — already-unblocked rows, unknown streams, and
   * filter matches that aren't blocked are silently skipped.
   *
   * `retry = -1` matches the InMemoryStore convention: claim() bumps
   * retry on every acquisition, so storing -1 means the first claim
   * after unblock returns retry=0 ("first attempt"). Storing 0 would
   * mis-report the post-recovery attempt as a continuation of the
   * failed sequence. See {@link Store.unblock}.
   *
   * @returns Count of streams that were actually flipped (were blocked).
   */
  async unblock(input: string[] | StreamFilter): Promise<number> {
    const set_clause = `SET retry = -1, blocked = false, error = NULL,
                          leased_by = NULL, leased_until = NULL`;
    if (Array.isArray(input)) {
      if (!input.length) return 0;
      const { rowCount } = await this._pool.query(
        `UPDATE ${this._fqs} ${set_clause}
         WHERE stream = ANY($1) AND blocked = true`,
        [input]
      );
      return rowCount ?? 0;
    }
    // Filter form: force `blocked = true` regardless of what the
    // caller passed — there is no use case for "unblock unblocked
    // streams." A no-op overlay is the right shape here.
    const { clause, values } = this._filter_clause(
      { ...input, blocked: true },
      1
    );
    const { rowCount } = await this._pool.query(
      `UPDATE ${this._fqs} ${set_clause} WHERE ${clause}`,
      values
    );
    return rowCount ?? 0;
  }

  /**
   * Bulk-update priority of streams matching `filter` (ACT-102).
   *
   * Filter semantics mirror {@link query_streams}: regex on `stream` /
   * `source` by default, exact match with the `_exact` flags,
   * `blocked` restricts to blocked or unblocked rows. Empty filter
   * (`{}`) updates every registered stream.
   *
   * Unlike {@link subscribe} (which keeps `max()` of registered
   * priorities), this sets the priority outright — operator override
   * for the build-time scheduling policy.
   *
   * @returns Count of streams whose priority changed.
   */
  async prioritize(filter: StreamFilter, priority: number): Promise<number> {
    const { clause, values } = this._filter_clause(filter, 2);
    const sql = `UPDATE ${this._fqs} SET priority = $1
                 WHERE priority <> $1 AND ${clause}`;
    const { rowCount } = await this._pool.query(sql, [priority, ...values]);
    return rowCount ?? 0;
  }

  /**
   * Streams subscription positions to a callback, ordered by stream name,
   * along with the highest event id in the store.
   *
   * Filters (`stream`, `source`, `blocked`, `after`, `limit`) are applied
   * server-side. `stream`/`source` are regex by default (`~`), or exact
   * with `*_exact: true` — same convention as {@link Store.query}.
   *
   * @returns `maxEventId` and the `count` of positions emitted.
   */
  async query_streams(
    callback: (position: StreamPosition) => void,
    query?: QueryStreams
  ): Promise<QueryStreamsResult> {
    const limit = query?.limit ?? 100;
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (query?.stream !== undefined) {
      values.push(query.stream);
      conditions.push(
        query.stream_exact
          ? `stream = $${values.length}`
          : `stream ~ $${values.length}`
      );
    }
    if (query?.source !== undefined) {
      conditions.push(`source IS NOT NULL`);
      values.push(query.source);
      conditions.push(
        query.source_exact
          ? `source = $${values.length}`
          : `source ~ $${values.length}`
      );
    }
    if (query?.source_matches !== undefined && query.source_matches.length) {
      // Reverse-match narrowing: the inverse of the `source` filter.
      // The stored `source` is treated as the regex pattern, and a row
      // qualifies when any supplied candidate name matches it (`n ~ source`).
      // A NULL/empty source has no source constraint — it consumes from
      // every stream, so it always qualifies. Composes (AND) with others.
      values.push(query.source_matches);
      conditions.push(
        `(source IS NULL OR source = '' OR EXISTS (
          SELECT 1 FROM unnest($${values.length}::text[]) AS n WHERE n ~ source
        ))`
      );
    }
    if (query?.blocked !== undefined) {
      values.push(query.blocked);
      conditions.push(`blocked = $${values.length}`);
    }
    if (query?.lane !== undefined) {
      values.push(query.lane);
      conditions.push(`lane = $${values.length}`);
    }
    if (query?.after !== undefined) {
      values.push(query.after);
      conditions.push(`stream > $${values.length}`);
    }
    let sql = `SELECT stream, source, at, retry, blocked, error, leased_by, leased_until, priority, lane FROM ${this._fqs}`;
    if (conditions.length) sql += " WHERE " + conditions.join(" AND ");
    values.push(limit);
    sql += ` ORDER BY stream LIMIT $${values.length}`;

    const client = await this._pool.connect();
    try {
      const [streamsResult, maxResult] = await Promise.all([
        client.query<{
          stream: string;
          source: string | null;
          at: number;
          retry: number;
          blocked: boolean;
          error: string | null;
          leased_by: string | null;
          leased_until: Date | null;
          priority: number;
          lane: string;
        }>(sql, values),
        client.query<{ m: number | null }>(
          `SELECT COALESCE(MAX(id), -1) AS m FROM ${this._fqt}`
        ),
      ]);

      let count = 0;
      for (const row of streamsResult.rows) {
        callback({
          stream: row.stream,
          source: row.source ?? undefined,
          at: row.at,
          retry: row.retry,
          blocked: row.blocked,
          error: row.error ?? "",
          priority: row.priority,
          leased_by: row.leased_by ?? undefined,
          leased_until: row.leased_until ?? undefined,
          lane: row.lane,
        });
        count++;
      }

      return { maxEventId: Number(maxResult.rows[0].m), count };
    } finally {
      client.release();
    }
  }

  /**
   * Per-stream aggregated stats — see {@link Store.query_stats}.
   *
   * Two code paths chosen by the requested stats:
   *
   * - **Heads-only path** (no `count`, no `names`): one or two
   *   `SELECT DISTINCT ON (stream) ... ORDER BY stream, version DESC|ASC`
   *   queries, executed in parallel when `tail: true`. The
   *   `(stream, version)` unique index gives index-only access — K rows
   *   touched per query (K = matched streams), not N (events).
   *   Ordering by `version` (not `id`) is equivalent within a stream
   *   (versions are monotonic per stream and events are committed
   *   sequentially) and is the column actually indexed.
   *
   * - **Full-scan path** (`count` or `names` set): one CTE materializes
   *   the filtered events, then `GROUP BY stream, name` →
   *   `jsonb_object_agg(name, n)` for the `names` map plus per-stream
   *   `COUNT(*)` for `count`. Heads (and `tails` when requested) come
   *   from `DISTINCT ON` over the same CTE — they ride free on the
   *   already-paid scan.
   *
   * The stream universe is derived from the events table: filter form
   * matches event-bearing streams (not subscription rows). When the
   * filter sets `source` or `blocked`, the events table is joined
   * against the streams subscription table since those concepts only
   * exist for subscribed streams.
   */
  async query_stats<E extends Schemas>(
    input: string[] | Pick<StreamFilter, "stream" | "stream_exact">,
    options?: QueryStatsOptions<E>
  ): Promise<Map<string, StreamStats<E>>> {
    const exclude = options?.exclude ?? [];
    const want_tail = options?.tail ?? false;
    const want_count = options?.count ?? false;
    const want_names = options?.names ?? false;
    const before = options?.before;
    const after = options?.after;
    const stats_limit = options?.limit;
    const full_scan = want_count || want_names;

    // Empty array short-circuit — saves a round trip on a no-op.
    if (Array.isArray(input) && input.length === 0) {
      return new Map<string, StreamStats<E>>();
    }

    // Build WHERE clause + parameter list. Subscription-level filters
    // (source, blocked) are intentionally not accepted — events live in
    // the events table; subscription state in the streams table. For
    // "stats for blocked subscriptions" callers compose with
    // query_streams. So no JOIN here.
    const where: string[] = [];
    const params: unknown[] = [];

    if (Array.isArray(input)) {
      params.push(input);
      where.push(`e.stream = ANY($${params.length})`);
    } else if (input.stream !== undefined) {
      params.push(input.stream);
      where.push(
        input.stream_exact
          ? `e.stream = $${params.length}`
          : `e.stream ~ $${params.length}`
      );
    }
    if (exclude.length) {
      params.push(exclude);
      where.push(`e.name <> ALL($${params.length})`);
    }
    if (before !== undefined) {
      params.push(before);
      where.push(`e.id < $${params.length}`);
    }
    if (after !== undefined) {
      // Keyset pagination cursor — exclusive on stream name. Results are
      // ordered by stream ascending so callers chain
      // `[...map.keys()].at(-1)` as the next cursor.
      params.push(after);
      where.push(`e.stream > $${params.length}`);
    }

    const from_clause = `${this._fqt} e`;
    // Always emit a WHERE clause — `WHERE TRUE` short-circuits the
    // empty-filter case without a conditional branch on the generation
    // side. PG optimizes the trivial predicate out.
    const where_clause = `WHERE ${where.length ? where.join(" AND ") : "TRUE"}`;

    return full_scan
      ? this._query_stats_full_scan<E>(
          from_clause,
          where_clause,
          params,
          want_tail,
          want_count,
          want_names,
          stats_limit
        )
      : this._query_stats_heads_only<E>(
          from_clause,
          where_clause,
          params,
          want_tail,
          stats_limit
        );
  }

  /**
   * Cheap path: index-only DISTINCT ON for the head per stream, plus an
   * optional second query (in parallel) for the tail. K rows touched
   * per query, not N events.
   */
  private async _query_stats_heads_only<E extends Schemas>(
    from_clause: string,
    where_clause: string,
    params: unknown[],
    want_tail: boolean,
    stats_limit?: number
  ): Promise<Map<string, StreamStats<E>>> {
    const cols = `e.id, e.stream, e.version, e.name, e.data, e.created, e.meta`;
    // `DISTINCT ON (e.stream) ... ORDER BY e.stream` already yields one row
    // per stream in stream-name order, so a trailing LIMIT caps the number
    // of streams returned. The head and tail queries share the same
    // ordering, so the same LIMIT selects the identical first-N streams.
    const limit_clause =
      stats_limit !== undefined ? ` LIMIT ${stats_limit}` : "";
    const head_sql = `SELECT DISTINCT ON (e.stream) ${cols} FROM ${from_clause} ${where_clause} ORDER BY e.stream, e.version DESC${limit_clause}`;
    const tail_sql = want_tail
      ? `SELECT DISTINCT ON (e.stream) ${cols} FROM ${from_clause} ${where_clause} ORDER BY e.stream, e.version ASC${limit_clause}`
      : null;

    const [headRes, tailRes] = await Promise.all([
      this._pool.query<Committed<E, keyof E>>(head_sql, params),
      tail_sql
        ? this._pool.query<Committed<E, keyof E>>(tail_sql, params)
        : Promise.resolve(null),
    ]);

    const out = new Map<string, StreamStats<E>>();
    for (const row of headRes.rows) {
      out.set(row.stream, { head: row });
    }
    if (tailRes) {
      for (const row of tailRes.rows) {
        // Head and tail share the same WHERE, so any stream returning a
        // tail must also have returned a head — no null check needed.
        (
          out.get(row.stream) as {
            head: Committed<E, keyof E>;
            tail?: Committed<E, keyof E>;
          }
        ).tail = row;
      }
    }
    return out;
  }

  /**
   * Full-scan path: one CTE-based query computes the per-stream
   * `COUNT(*)` and `jsonb_object_agg(name, n)` map alongside the head
   * (and tail when requested). All extras share the single events scan.
   */
  private async _query_stats_full_scan<E extends Schemas>(
    from_clause: string,
    where_clause: string,
    params: unknown[],
    want_tail: boolean,
    want_count: boolean,
    want_names: boolean,
    stats_limit?: number
  ): Promise<Map<string, StreamStats<E>>> {
    const tail_cte = want_tail
      ? `, tails AS (SELECT DISTINCT ON (stream) * FROM ef ORDER BY stream, version ASC)`
      : "";
    const tail_join = want_tail
      ? `LEFT JOIN tails t ON t.stream = h.stream`
      : "";
    const tail_cols = want_tail
      ? `, t.id AS t_id, t.stream AS t_stream, t.version AS t_version,
           t.name AS t_name, t.data AS t_data, t.created AS t_created, t.meta AS t_meta`
      : "";

    const sql = `
      WITH ef AS (
        SELECT e.id, e.stream, e.version, e.name, e.data, e.created, e.meta
        FROM ${from_clause}
        ${where_clause}
      ),
      agg AS (
        SELECT stream,
               SUM(n)::int AS cnt,
               jsonb_object_agg(name, n) AS names
        FROM (
          SELECT stream, name, COUNT(*)::int AS n
          FROM ef
          GROUP BY stream, name
        ) t
        GROUP BY stream
      ),
      heads AS (
        SELECT DISTINCT ON (stream) * FROM ef ORDER BY stream, version DESC
      )
      ${tail_cte}
      SELECT
        h.id, h.stream, h.version, h.name, h.data, h.created, h.meta,
        a.cnt AS agg_count,
        a.names AS agg_names
        ${tail_cols}
      FROM heads h
      LEFT JOIN agg a ON a.stream = h.stream
      ${tail_join}
      ORDER BY h.stream
      ${stats_limit !== undefined ? `LIMIT ${stats_limit}` : ""}
    `;

    const res = await this._pool.query<
      Committed<E, keyof E> & {
        agg_count: number;
        agg_names: Record<string, number> | null;
        t_id?: number;
        t_stream?: string;
        t_version?: number;
        t_name?: string;
        t_data?: object;
        t_created?: Date;
        t_meta?: object;
      }
    >(sql, params);

    const out = new Map<string, StreamStats<E>>();
    for (const row of res.rows) {
      const stats: {
        head: Committed<E, keyof E>;
        tail?: Committed<E, keyof E>;
        count?: number;
        names?: Record<string, number>;
      } = {
        head: {
          id: row.id,
          stream: row.stream,
          version: row.version,
          name: row.name,
          data: row.data,
          created: row.created,
          meta: row.meta,
        } as Committed<E, keyof E>,
      };
      if (want_tail && row.t_id !== undefined && row.t_id !== null) {
        stats.tail = {
          id: row.t_id,
          stream: row.t_stream,
          version: row.t_version,
          name: row.t_name,
          data: row.t_data,
          created: row.t_created,
          meta: row.t_meta,
        } as unknown as Committed<E, keyof E>;
      }
      if (want_count) stats.count = row.agg_count;
      // `agg_names` is non-null when this row exists: heads and agg are
      // both built from the same `ef` CTE, so any stream in heads has
      // at least one matching event and `jsonb_object_agg` returns an
      // object (never null) for that group.
      if (want_names) stats.names = row.agg_names as Record<string, number>;
      out.set(row.stream, stats as StreamStats<E>);
    }
    return out;
  }

  /**
   * Implementation of the optional `Store.notify` hook. Bound onto
   * `this.notify` in the constructor when `config.notify === true`,
   * left detached otherwise — see {@link Config.notify}.
   *
   * Checks out a dedicated long-lived client from the pool, runs
   * `LISTEN act_commit_<schema>_<table>`, and parses each incoming
   * notification payload. The handler is invoked exactly once per
   * **remote** commit — payloads originating from this same store
   * instance (matched by the per-instance `_by` UUID) are silently
   * skipped, giving callers a clean cross-process semantic.
   *
   * Multiple subscriptions on the same store instance are not supported —
   * this method releases any prior LISTEN client before opening a new one.
   * The returned disposer cleanly UNLISTENs and releases the dedicated
   * client; pool disposal also tears the subscription down as a safety
   * net.
   *
   * @param handler Called for each cross-process commit notification.
   * @returns Disposer that releases the LISTEN client.
   */
  private async _subscribe_notifications(
    handler: (notification: StoreNotification) => void
  ): Promise<NotifyDisposer> {
    // Close any prior subscription so callers don't silently double-listen.
    await this._teardown_listen();

    const client = await this._pool.connect();
    const on_notification = (msg: pg.Notification) => {
      // Channel filter: this client only `LISTEN`s on `this._channel`,
      // but pg-pool can in theory deliver buffered notifications when a
      // connection is reused — guard rather than trust.
      if (msg.channel !== this._channel) return;
      if (!msg.payload) return;
      let parsed: {
        stream?: unknown;
        events?: unknown;
        by?: unknown;
      };
      try {
        parsed = JSON.parse(msg.payload);
      } catch (err) {
        // A malformed payload is a bug somewhere upstream — log and skip
        // instead of tearing down the listener.
        logger.error(
          { err, payload: msg.payload },
          "act_commit: malformed payload, skipping"
        );
        return;
      }
      // Self-filter: skip notifications that originated from this same
      // store instance. This is what gives `notified` its cross-process
      // semantic — local commits already arm the drain via `do()`.
      if (parsed.by === this._by) return;
      if (typeof parsed.stream !== "string" || !Array.isArray(parsed.events)) {
        logger.error(
          { payload: msg.payload },
          "act_commit: payload missing required fields, skipping"
        );
        return;
      }
      const events: Array<{ id: number; name: string }> = [];
      for (const raw of parsed.events) {
        if (
          raw &&
          typeof raw === "object" &&
          typeof (raw as { id?: unknown }).id === "number" &&
          typeof (raw as { name?: unknown }).name === "string"
        ) {
          events.push({
            id: (raw as { id: number }).id,
            name: (raw as { name: string }).name,
          });
        }
      }
      if (events.length === 0) return;
      // Adapter-level robustness: a throwing handler must not tear
      // down the dedicated LISTEN client. The orchestrator wraps its
      // own `notified` emit + drain wakeup separately
      // (`Act._wire_notify`) — defense in depth, with each layer
      // protecting its own resources. Direct callers of
      // `store.notify(handler)` (tests, custom integrations) inherit
      // the adapter wrap.
      try {
        handler({ stream: parsed.stream, events });
      } catch (err) {
        logger.error(err, "act_commit: handler threw, listener preserved");
      }
    };
    client.on("notification", on_notification);
    try {
      await client.query(`LISTEN ${this._channel}`);
    } catch (err) {
      client.removeListener("notification", on_notification);
      client.release(true);
      throw err;
    }
    this._listen_client = client;
    this._listen_handler = on_notification;

    return async () => {
      // No-op when this disposer is stale (a later notify() call already
      // tore the subscription down).
      if (this._listen_client !== client) return;
      await this._teardown_listen();
    };
  }

  /**
   * Atomically truncates streams and seeds each with a snapshot or tombstone.
   * @param targets - Streams to truncate with optional snapshot state and meta.
   * @returns Map keyed by stream name, each entry with `deleted` count and `committed` event.
   */
  async truncate(
    targets: Array<{
      stream: string;
      snapshot?: Schema;
      meta?: EventMeta;
    }>
  ): Promise<
    Map<
      string,
      { deleted: number; committed: Committed<Schemas, keyof Schemas> }
    >
  > {
    if (!targets.length) return new Map();
    const streams = targets.map((t) => t.stream);
    const client = await this._pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM ${this._fqs} WHERE stream = ANY($1)`, [
        streams,
      ]);
      const result = new Map<
        string,
        { deleted: number; committed: Committed<Schemas, keyof Schemas> }
      >();
      for (const { stream, snapshot, meta } of targets) {
        const { rowCount } = await client.query(
          `DELETE FROM ${this._fqt} WHERE stream = $1`,
          [stream]
        );
        const name = snapshot !== undefined ? SNAP_EVENT : TOMBSTONE_EVENT;
        const { rows } = await client.query(
          `INSERT INTO ${this._fqt}(name, data, stream, version, created, meta)
           VALUES($1, $2, $3, 0, now(), $4) RETURNING *`,
          [
            name,
            snapshot ?? {},
            stream,
            meta ?? { correlation: "", causation: {} },
          ]
        );
        result.set(stream, {
          deleted: rowCount ?? 0,
          committed: rows[0] as Committed<Schemas, keyof Schemas>,
        });
      }
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Atomically wipe-and-rebuild the store inside a single
   * `BEGIN`/`COMMIT` transaction.
   *
   * On any throw inside the driver the transaction rolls back and the
   * store ends byte-for-byte unchanged. `TRUNCATE ... RESTART
   * IDENTITY CASCADE` wipes events + resets the serial sequence to 1;
   * the streams table is cleared in the same statement via
   * `CASCADE`-like `DELETE`. Events are inserted one at a time with
   * explicit columns (skipping `id`) so the serial assigns dense ids
   * from 1. `created` is preserved verbatim from the source.
   */
  async restore(
    driver: (
      callback: (event: Committed<Schemas, keyof Schemas>) => Promise<number>
    ) => Promise<void>
  ): Promise<void> {
    const client = await this._pool.connect();
    try {
      await client.query("BEGIN");
      // RESTART IDENTITY resets the id sequence; CASCADE handles any
      // future FK refs (none today, but cheap insurance).
      await client.query(
        `TRUNCATE TABLE ${this._fqt} RESTART IDENTITY CASCADE`
      );
      await client.query(`TRUNCATE TABLE ${this._fqs}`);
      await driver(async (event) => {
        // Restore mirrors commit: encrypt the pii payload when
        // encryption is configured. The source iterator yields
        // plaintext events (restore is the rebuild path — the driver
        // already presents data in the framework's native shape),
        // so this is symmetric with the commit-path call above —
        // including the JSON.stringify wrapper that turns the bare
        // base64 string into a jsonb-acceptable JSON string literal.
        const pii_for_write =
          this._resolve_pii_key && event.pii != null
            ? JSON.stringify(await encrypt(event.pii, this._resolve_pii_key))
            : (event.pii ?? null);
        const { rows } = await client.query<{ id: number }>(
          `INSERT INTO ${this._fqt}(name, data, pii, stream, version, created, meta)
           VALUES($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [
            event.name,
            event.data,
            pii_for_write,
            event.stream,
            event.version,
            event.created,
            event.meta,
          ]
        );
        return rows[0]!.id;
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Wipe the sensitive-data payload for every event on the stream — the
   * physical-erasure side of the sensitive-data epic (#566). Sets
   * `events.pii` to `NULL` for the stream's events; `events.data` and
   * the rest of the row are never touched.
   *
   * Row-level locks (no table lock), bounded by events-per-stream.
   * Idempotent — a second call on an already-wiped stream returns `0`.
   *
   * Disk reclamation is autovacuum-driven; for strict-deletion
   * jurisdictions the production checklist documents `VACUUM FULL` as
   * the operator step.
   *
   * @param stream Target stream
   * @returns Count of events whose `pii` was set to `NULL`
   */
  async forget_pii(stream: string): Promise<number> {
    const r = await this._pool.query(
      `UPDATE ${this._fqt} SET pii = NULL WHERE stream = $1 AND pii IS NOT NULL`,
      [stream]
    );
    return r.rowCount ?? 0;
  }
}
