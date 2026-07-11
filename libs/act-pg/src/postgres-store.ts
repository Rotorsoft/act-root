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

/**
 * POSIX regex bracket expression matching any single reaction-`source`
 * metacharacter (`^ $ . * + ? ( ) [ ] { } | \`). A source that matches
 * none of these is a literal stream name, claimed by equality; one that
 * matches any is a pattern, claimed with `~`. Mirrors `is_literal_source`
 * in `@rotorsoft/act` so the SQL classification agrees with the core
 * helper. `]` leads and `\\` escapes the backslash; PG advanced regex
 * honors backslash escapes inside brackets.
 */
const SOURCE_METACHARACTER_CLASS = "[]^$.*+?()[{}|\\\\]";

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

// PG caps NOTIFY payloads at 8000 bytes — `pg_notify` raises
// "payload string too long" (SQLSTATE 54000) at or above the cap, and
// inside the commit transaction that error would abort the whole INSERT
// batch. `commit()` measures the serialized payload first and skips the
// NOTIFY when it would not fit: listeners fall back to the poll path, so
// delivery degrades to the next poll cycle but the commit never fails.
// See: https://www.postgresql.org/docs/current/sql-notify.html
const NOTIFY_MAX_PAYLOAD_BYTES = 8000;

// Capped exponential backoff for re-establishing the LISTEN subscription
// after the dedicated client emits `error` (backend restart, failover,
// network drop — #1189). Between attempts the store degrades to the poll
// path, so callers never miss events — they just fall back to the next
// drain cycle for cross-process wakeups until the LISTEN client is back.
const NOTIFY_RECONNECT_BASE_MS = 250;
const NOTIFY_RECONNECT_MAX_MS = 30_000;

// Keeps a destroyed LISTEN client from re-raising a late socket `error` as an
// uncaught exception. Attached to the dead client through `release(true)` so it
// is never listener-less during the reconnect backoff window (#1231).
const swallow_error = (): void => {};

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
  // Opinionated pool defaults (#1119). node-postgres ships `max: 10`
  // with no acquisition timeout and no statement timeout — a saturated
  // pool makes every caller hang indefinitely instead of failing with
  // a diagnosable error. Nearly every store method holds a client for
  // a multi-statement transaction, so multi-lane drains plus API
  // traffic can exhaust a 10-client pool quickly. All four values are
  // plain `pg.PoolConfig` fields — caller config overrides any of them
  // via the constructor spread.
  //
  // - `max: 20` — floor for the default lane's parallel handler budget
  //   (streamLimit 10, each commit holds a client) plus API commits,
  //   the optional LISTEN client, and headroom. Sizing rule in the
  //   README: Σ per-lane streamLimit + API concurrency + notify + 2–4.
  // - `connectionTimeoutMillis: 10_000` — fail acquisition fast (the
  //   pg default of 0 waits forever); surfaces as StoreError via
  //   `_client()` so operators see *which* operation starved.
  // - `idleTimeoutMillis: 30_000` — keep idle clients warm across
  //   drain cycles (cycleMs can exceed the pg default of 10s in
  //   low-traffic deployments) without pinning connections for long.
  // - `statement_timeout: 60_000` — per-statement (not per-transaction)
  //   ceiling; every statement the store issues (claim CTE, seed DDL,
  //   truncate, restore's per-event inserts) legitimately completes
  //   orders of magnitude faster, so 60s only fires on a wedged server
  //   or a lost lock instead of holding the client hostage.
  max: 20,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
  statement_timeout: 60_000,
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
 * // PostgresStore uses node-postgres (pg) connection pooling with
 * // opinionated defaults: max 20, connectionTimeoutMillis 10s,
 * // idleTimeoutMillis 30s, statement_timeout 60s. Any pg.PoolConfig
 * // field passed to the constructor overrides the default.
 *
 * const pgStore = new PostgresStore({
 *   host: "db.example.com",
 *   port: 5432,
 *   database: "production",
 *   user: "app_user",
 *   password: process.env.DB_PASSWORD,
 *   max: 40  // lanes × streamLimit + API concurrency + headroom
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
   * Error listener attached to the active LISTEN client. node-postgres
   * removes its idle-error guard on checkout, so a checked-out client
   * that emits `error` (backend restart, failover, network drop) with no
   * listener is an uncaught exception — a process crash (#1189). Tracked
   * alongside `_listen_handler` so teardown detaches it in lockstep.
   */
  private _listen_error_handler: ((err: Error) => void) | undefined;
  /**
   * The caller's notification handler for the active subscription, kept
   * so the self-healing reconnect path (#1189) can re-establish LISTEN
   * on a fresh client after the dedicated one emits `error`. Cleared by
   * `_teardown_listen`, which is what makes disposal cancel any pending
   * reconnect.
   */
  private _notify_handler:
    | ((notification: StoreNotification) => void)
    | undefined;
  /**
   * Pending reconnect timer, if a LISTEN client error scheduled one.
   * Tracked so `_teardown_listen` (and therefore `dispose()`) can cancel
   * it — a reconnect must never fire after teardown.
   */
  private _reconnect_timer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Consecutive reconnect attempts since the last healthy LISTEN, used to
   * grow the capped exponential backoff. Reset to 0 once a re-LISTEN
   * succeeds.
   */
  private _reconnect_attempts = 0;
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
   * Acquire a pooled client, translating acquisition failures into
   * {@link StoreError} with the calling operation as context. With the
   * default `connectionTimeoutMillis`, a saturated pool fails here
   * after 10s with `Store operation "<operation>" failed` (driver
   * error preserved as `cause`) instead of hanging indefinitely.
   * Every method that checks out a client routes through this helper.
   */
  private async _client(operation: string): Promise<pg.PoolClient> {
    try {
      return await this._pool.connect();
    } catch (error) {
      throw new StoreError(operation, { cause: error });
    }
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
   * Tear down the active LISTEN subscription if any: cancel any pending
   * reconnect, forget the caller's handler (so no reconnect can fire
   * after teardown), detach the notification + error listeners, run
   * UNLISTEN, and destroy the dedicated client (do not return it to the
   * pool — its listeners are removed but destroying belt-and-braces
   * guards against any future change in pg-pool semantics that could
   * re-issue a half-clean client).
   *
   * Clearing `_notify_handler` and the reconnect timer here is what makes
   * `dispose()` safe during a pending reconnect (#1189): a scheduled
   * `_reconnect` bails the moment it finds no handler.
   */
  private async _teardown_listen() {
    if (this._reconnect_timer) {
      clearTimeout(this._reconnect_timer);
      this._reconnect_timer = undefined;
    }
    this._notify_handler = undefined;
    this._reconnect_attempts = 0;
    if (!this._listen_client) return;
    // _listen_handler and _listen_error_handler are set in lockstep with
    // _listen_client in _open_listen, so if the client is present, both
    // handlers are too.
    this._listen_client.removeListener("notification", this._listen_handler!);
    this._listen_client.removeListener("error", this._listen_error_handler!);
    this._listen_handler = undefined;
    this._listen_error_handler = undefined;
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
    const client = await this._client("seed");

    try {
      await client.query("BEGIN");

      // Serialize concurrent cold boots. IF NOT EXISTS DDL is not
      // race-safe while the objects are first being created — two
      // connections creating the same table simultaneously can trip
      // catalog unique-key errors — so N workers booting an empty
      // schema at once serialize here instead. Transaction-scoped:
      // the lock releases at COMMIT/ROLLBACK, and steady-state
      // re-seeds pass through in microseconds.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `${this.config.schema}.${this.config.table}`,
      ]);

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
          retry int NOT NULL DEFAULT -1,
          blocked boolean NOT NULL DEFAULT false,
          error text,
          leased_by text,
          leased_until timestamptz,
          priority int NOT NULL DEFAULT 0,
          lane text NOT NULL DEFAULT 'default',
          deferred_at timestamptz
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
      // Migration for tables created before deferred reactions (#1090).
      await client.query(
        `ALTER TABLE ${this._fqs}
         ADD COLUMN IF NOT EXISTS deferred_at timestamptz;`
      );
      // Migration for tables created before the retry widening (#1190).
      // `claim()` increments `retry` on every acquisition and never
      // resets it for a zero-progress `blockOnError: false` stream, so a
      // poison stream marches the counter up without bound. The original
      // `smallint` column overflowed at 32768, throwing "smallint out of
      // range" and killing every claim in the lane. Widen to `int` so PG
      // matches the unbounded SQLite/InMemory adapters, preserving every
      // existing value (smallint ⊂ int). Guarded on the current type so
      // steady-state re-seeds skip the DDL — and its brief ACCESS
      // EXCLUSIVE lock — entirely once the column is already `integer`.
      await client.query(
        `DO $$
         BEGIN
           IF EXISTS (
             SELECT 1 FROM information_schema.columns
             WHERE table_schema = '${this.config.schema}'
               AND table_name = '${this.config.table}_streams'
               AND column_name = 'retry'
               AND data_type = 'smallint'
           ) THEN
             EXECUTE 'ALTER TABLE ${this._fqs} ALTER COLUMN retry TYPE integer';
           END IF;
         END
         $$;`
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
    // Serialize commit VISIBILITY, not just id assignment. `id` is a
    // serial: it is assigned at INSERT time but the row appears at
    // COMMIT time, and every watermark consumer (the claim has-work
    // probe, fetch's `after`, the correlate checkpoint) assumes id
    // order equals visibility order. Without a fence two concurrent
    // commits to different streams can surface out of id order, and a
    // reader that acks past the higher id permanently skips the lower
    // one — the classic event-store gap problem. Same-stream commits
    // were already serialized by the (stream, version) unique index;
    // the advisory lock below extends the guarantee across streams.
    //
    // The whole commit is TWO round trips with NO client round trip
    // inside the lock window: an unlocked head probe (its own implicit
    // transaction — optimistic concurrency is guarded by the unique
    // index, not the probe), then ONE autocommit statement that
    // acquires the xact-scoped lock in a CTE, inserts the batch, and
    // (when enabled) raises the NOTIFY — the lock is held only for
    // server-side execution plus the implicit COMMIT, never across a
    // client round trip. The pooled client is checked out through
    // `_client` so acquisition failures keep their StoreError context
    // (#1119); checkout itself is in-process, not a round trip.
    const client = await this._client("commit");
    try {
      const last = await client.query<{ version: number }>(
        `SELECT version FROM ${this._fqt}
         WHERE stream=$1 ORDER BY version DESC LIMIT 1`,
        [stream]
      );
      let version = last.rows.at(0)?.version ?? -1;
      if (typeof expectedVersion === "number" && version !== expectedVersion)
        throw new ConcurrencyError(
          stream,
          version,
          msgs as unknown as Message<Schemas, string>[],
          expectedVersion
        );

      // Encrypt the pii payloads when encryption is configured and
      // there's anything to encrypt — `null` passes through verbatim so
      // `forget_pii` semantics survive intact (a NULL stays NULL).
      // Encrypted output is `JSON.stringify`-ed so the bare base64
      // string casts to jsonb as a JSON string literal. Data/pii travel
      // as text[] and cast to jsonb in SQL — the pg driver can't
      // serialize object elements inside a jsonb[] parameter.
      const base_version = version;
      const names: string[] = [];
      const datas: string[] = [];
      const piis: (string | null)[] = [];
      const versions: number[] = [];
      for (const { name, data, pii } of msgs) {
        version++;
        names.push(name as string);
        datas.push(JSON.stringify(data));
        piis.push(
          this._resolve_pii_key && pii != null
            ? JSON.stringify(await encrypt(pii, this._resolve_pii_key))
            : pii != null
              ? JSON.stringify(pii)
              : null
        );
        versions.push(version);
      }

      // The cross join on the lock CTE forces the advisory lock to be
      // acquired before any row (and therefore any serial id) is
      // produced. Single-event commits (the overwhelmingly common
      // shape) skip the unnest machinery for a leaner plan. The NOTIFY
      // rides the same statement as a CTE: one notification per commit
      // transaction with the full batch, delivered at the implicit
      // COMMIT, skipped in SQL when the payload would exceed PG's cap
      // (listeners fall back to the poll path — degraded latency,
      // never lost events), and skipped entirely when
      // `config.notify === false` (the default). The final select LEFT
      // JOINs the notify CTE so it is referenced (a bare SELECT CTE
      // would otherwise be skipped) without changing row multiplicity —
      // it yields at most one row.
      const insert_select =
        msgs.length === 1
          ? `SELECT $1, $2::jsonb, $3::jsonb, $5, $4::int, $6 FROM l`
          : `SELECT u.name, u.data::jsonb, u.pii::jsonb, $5, u.version, $6
             FROM l, unnest($1::text[], $2::text[], $3::text[], $4::int[])
               WITH ORDINALITY AS u(name, data, pii, version, ord)
             ORDER BY u.ord`;
      const notify_ctes = this.config.notify
        ? `,
           payload AS (
             SELECT json_build_object(
               'stream', $5::text,
               'events', json_agg(json_build_object('id', ins.id, 'name', ins.name) ORDER BY ins.version),
               'by', $9::text
             )::text AS p
             FROM ins
           ),
           n AS (
             SELECT pg_notify($8, payload.p) FROM payload
             WHERE octet_length(payload.p) < $10
           )`
        : "";
      const final_select = this.config.notify
        ? "SELECT ins.* FROM ins LEFT JOIN n ON true ORDER BY ins.version"
        : "SELECT * FROM ins ORDER BY version";
      const sql = `WITH l AS (SELECT pg_advisory_xact_lock(hashtext($7))),
        ins AS (
          INSERT INTO ${this._fqt}(name, data, pii, stream, version, meta)
          ${insert_select}
          RETURNING *
        )${notify_ctes}
        ${final_select}`;
      const base_params =
        msgs.length === 1
          ? [names[0], datas[0], piis[0], versions[0], stream, meta, this._fqt]
          : [names, datas, piis, versions, stream, meta, this._fqt];
      const params = this.config.notify
        ? [...base_params, this._channel, this._by, NOTIFY_MAX_PAYLOAD_BYTES]
        : base_params;

      try {
        const { rows } = await client.query<Committed<E, keyof E>>(sql, params);
        // Decrypt before handing back to the caller — the committed
        // event the framework returns must carry the cleartext payload
        // (the reducer chain runs against `event.pii`). The encrypted
        // value only lives at rest in the column; never in memory past
        // this point.
        if (this._resolve_pii_key) {
          for (const row of rows) {
            if (typeof row.pii === "string") {
              const decrypted = await decrypt(row.pii, this._resolve_pii_key);
              (row as { pii: unknown }).pii = decrypted;
            }
          }
        }
        return rows;
      } catch (error) {
        // PG unique-violation on (stream, version) — a concurrent commit
        // beat us between the head probe and this INSERT. Surface as
        // ConcurrencyError so callers retry on the framework signal
        // instead of an adapter-specific error. The statement is its own
        // transaction, so there is nothing to roll back.
        if ((error as { code?: string })?.code === PG_UNIQUE_VIOLATION) {
          throw new ConcurrencyError(
            stream,
            base_version,
            msgs as unknown as Message<Schemas, string>[],
            expectedVersion ?? -1
          );
        }
        throw error;
      }
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
    const client = await this._client("claim");
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
            AND (deferred_at IS NULL OR deferred_at <= NOW())
            AND (s.at < 0 OR EXISTS (
              SELECT 1 FROM ${this._fqt} e
              WHERE e.id > s.at
                AND e.name <> '${SNAP_EVENT}'
                -- Literal source (no regex metacharacter) matches by
                -- equality — index-friendly, and exact so "s1" never
                -- claims "s12". A pattern source (e.g. '^(A|B)$') matches
                -- with the POSIX regex operator so the calculator's static
                -- regex reaction is claimed for every stream it anchors.
                AND (
                  s.source IS NULL
                  OR (s.source !~ '${SOURCE_METACHARACTER_CLASS}' AND e.stream = s.source)
                  OR (s.source ~ '${SOURCE_METACHARACTER_CLASS}' AND e.stream ~ s.source)
                )
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
    const client = await this._client("subscribe");
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
    const client = await this._client("ack");
    try {
      await client.query("BEGIN");
      // One statement finalizes the whole batch, so acks and defer
      // schedules land all-or-nothing per the Store.ack contract: an
      // entry without `due` acks (watermark advances, schedule cleared),
      // an entry with `due` defers (schedule set, watermark untouched).
      // A defer is a deliberate "come back later," not a failure, so
      // retry resets on both paths. Deferred rows are filtered out of
      // the returned acked leases.
      const { rows } = await client.query<{
        stream: string;
        source: string | null;
        at: number;
        by: string;
        retry: number;
        lagging: boolean;
        lane: string;
        due: string | null;
      }>(
        `
      WITH input AS (
        SELECT * FROM jsonb_to_recordset($1::jsonb)
        AS x(stream text, by text, at int, lagging boolean, due bigint)
      )
      UPDATE ${this._fqs} AS s
      SET
        at = CASE WHEN i.due IS NULL THEN i.at ELSE s.at END,
        retry = -1,
        leased_by = NULL,
        leased_until = NULL,
        deferred_at = CASE WHEN i.due IS NULL THEN NULL
                           ELSE to_timestamp(i.due / 1000.0) END
      FROM input i
      WHERE s.stream = i.stream AND s.leased_by = i.by
      RETURNING s.stream, s.source, s.at, i.by, s.retry, i.lagging, s.lane, i.due
      `,
        [JSON.stringify(leases)]
      );
      await client.query("COMMIT");

      return rows
        .filter((row) => row.due === null)
        .map((row) => ({
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
    const client = await this._client("block");
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
      SET blocked = true, error = i.error, deferred_at = NULL
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
   * Hold the matched streams out of {@link claim} until `deferred_at`
   * (ms since epoch) — see {@link Store.defer}. Persists `deferred_at`
   * (as a `timestamptz`) so the skip is honored by every competing
   * worker; `claim` filters on `deferred_at <= NOW()`. Accepts an
   * explicit list of names or a {@link StreamFilter}, mirroring
   * {@link reset}/{@link prioritize}. Cleared by ack/block/reset/unblock.
   *
   * @returns Count of streams whose `deferred_at` was set.
   */
  async defer(
    input: string[] | StreamFilter,
    deferred_at: number
  ): Promise<number> {
    // Reset retry too: a defer is a deliberate "come back later," not a
    // failure, so the redelivery after the due-time is a fresh attempt.
    const set_clause = `SET deferred_at = to_timestamp($1 / 1000.0), retry = -1`;
    if (Array.isArray(input)) {
      if (!input.length) return 0;
      const { rowCount } = await this._pool.query(
        `UPDATE ${this._fqs} ${set_clause} WHERE stream = ANY($2)`,
        [deferred_at, input]
      );
      return rowCount ?? 0;
    }
    const { clause, values } = this._filter_clause(input, 2);
    const { rowCount } = await this._pool.query(
      `UPDATE ${this._fqs} ${set_clause} WHERE ${clause}`,
      [deferred_at, ...values]
    );
    return rowCount ?? 0;
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
                          leased_by = NULL, leased_until = NULL, deferred_at = NULL`;
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
                          leased_by = NULL, leased_until = NULL, deferred_at = NULL`;
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

    const client = await this._client("query_streams");
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
   * The subscription is **self-healing** (#1189): the dedicated client
   * has an `error` listener that, on a connection blip (backend restart,
   * failover, network drop), tears the dead client down and re-LISTENs
   * on a fresh one with capped exponential backoff — degrading to the
   * poll path in between. A pending reconnect is cancelled by disposal,
   * so no reconnect fires after teardown.
   *
   * @param handler Called for each cross-process commit notification.
   * @returns Disposer that releases the LISTEN client.
   */
  private async _subscribe_notifications(
    handler: (notification: StoreNotification) => void
  ): Promise<NotifyDisposer> {
    // Close any prior subscription so callers don't silently double-listen.
    await this._teardown_listen();

    // Remember the caller's handler so the self-healing reconnect path
    // (#1189) can re-establish LISTEN on a fresh client after a
    // connection blip without the caller re-subscribing.
    this._notify_handler = handler;
    try {
      await this._open_listen(handler);
    } catch (err) {
      // Initial LISTEN failed — leave no half-set state behind so the
      // orchestrator's wireNotify sees a clean rejection.
      this._notify_handler = undefined;
      throw err;
    }

    return async () => {
      // No-op when this disposer is stale (a later notify() call already
      // tore the subscription down and replaced the handler).
      if (this._notify_handler !== handler) return;
      await this._teardown_listen();
    };
  }

  /**
   * Check out a dedicated client, attach the notification + error
   * listeners, and run `LISTEN`. Shared by the initial subscription and
   * every reconnect (#1189). On any failure before `LISTEN` succeeds the
   * client is detached and destroyed so nothing leaks — the caller
   * decides whether to propagate (initial subscribe) or reschedule
   * (reconnect).
   */
  private async _open_listen(
    handler: (notification: StoreNotification) => void
  ): Promise<void> {
    const client = await this._client("notify");
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
    // The dedicated LISTEN client loses node-postgres's idle-error guard
    // on checkout, so an unhandled `error` (backend restart, failover,
    // network drop) would crash the process (#1189). Handle it: log,
    // tear the dead client down, and schedule a re-LISTEN with capped
    // backoff. Between attempts the store degrades to the poll path.
    const on_error = (err: Error) => {
      logger.error(err, "act_commit: LISTEN client errored, reconnecting");
      this._reconnect();
    };
    client.on("notification", on_notification);
    client.on("error", on_error);
    try {
      await client.query(`LISTEN ${this._channel}`);
    } catch (err) {
      client.removeListener("notification", on_notification);
      client.removeListener("error", on_error);
      client.release(true);
      throw err;
    }
    this._listen_client = client;
    this._listen_handler = on_notification;
    this._listen_error_handler = on_error;
    // A healthy LISTEN resets the backoff so the next blip starts fresh.
    this._reconnect_attempts = 0;
  }

  /**
   * Self-heal the LISTEN subscription after the dedicated client emitted
   * `error` (#1189). Detaches and destroys the dead client, then
   * reconnects on a fresh one with capped exponential backoff. Bails
   * immediately if the subscription was disposed while a reconnect was
   * pending (`_notify_handler` cleared by `_teardown_listen`), so no
   * reconnect ever fires after teardown.
   */
  private _reconnect(): void {
    const handler = this._notify_handler;
    // Disposed (or torn down by a re-subscribe) while the error fired —
    // nothing to reconnect.
    if (!handler) return;
    // Detach and destroy the dead client. Its listeners are gone once
    // `_teardown_listen` runs, but the error already fired, so just drop
    // it — do not run UNLISTEN on a broken connection.
    if (this._listen_client) {
      const dead = this._listen_client;
      dead.removeListener("notification", this._listen_handler!);
      dead.removeListener("error", this._listen_error_handler!);
      // A node-postgres socket routinely emits `error` more than once on
      // teardown (in-flight LISTEN rejection, then the ECONNRESET/end that
      // follows). `release(true)` destroys the connection but does not
      // synchronously silence the socket, so the client must never be
      // listener-less: an unhandled second `error` re-raises as an uncaught
      // exception — the exact process crash #1189 fixed (#1231). Attach a
      // swallow listener that lives until the destroyed client is GC'd.
      dead.on("error", swallow_error);
      this._listen_handler = undefined;
      this._listen_error_handler = undefined;
      this._listen_client = undefined;
      dead.release(true);
    }
    const delay = Math.min(
      NOTIFY_RECONNECT_MAX_MS,
      NOTIFY_RECONNECT_BASE_MS * 2 ** this._reconnect_attempts
    );
    this._reconnect_attempts++;
    // A second error (or the recursive `.catch` reconnect) must not leave two
    // live timers racing to re-LISTEN — cancel any pending one before we
    // reassign. `_teardown_listen` clears it on disposal.
    if (this._reconnect_timer) clearTimeout(this._reconnect_timer);
    this._reconnect_timer = setTimeout(() => {
      this._reconnect_timer = undefined;
      // Re-check: disposal may have won the race after the timer fired.
      const current = this._notify_handler;
      if (!current) return;
      this._open_listen(current).catch((err) => {
        logger.error(err, "act_commit: LISTEN reconnect failed, retrying");
        this._reconnect();
      });
    }, delay);
    // Don't keep the event loop alive purely for a reconnect attempt —
    // a process that has nothing else to do should still be able to exit.
    this._reconnect_timer.unref?.();
  }

  /**
   * Atomically truncates streams and seeds each with a snapshot or tombstone.
   * Windowed targets (`before` set) prune the prefix below the closest safe
   * `__snapshot__` instead — no seed, subscriptions untouched, no-op when no
   * snapshot qualifies.
   * @param targets - Streams to truncate with optional snapshot state and meta,
   *   or a `before`/`max_id` boundary for a windowed prefix delete.
   * @returns Map keyed by stream name, each entry with `deleted` count and `committed` event.
   */
  async truncate(
    targets: Array<{
      stream: string;
      snapshot?: Schema;
      meta?: EventMeta;
      before?: Date;
      max_id?: number;
    }>
  ): Promise<
    Map<
      string,
      {
        deleted: number;
        committed: Committed<Schemas, keyof Schemas>;
        before?: Date;
      }
    >
  > {
    if (!targets.length) return new Map();
    const full = targets.filter((t) => t.before === undefined);
    const windowed = targets.filter((t) => t.before !== undefined);
    const client = await this._client("truncate");
    try {
      await client.query("BEGIN");
      // Seeds (snapshots/tombstones) produce watermark-relevant ids, so
      // truncate takes the same visibility lock as commit — see the
      // commit path for the id-order-vs-visibility-order rationale.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        this._fqt,
      ]);
      const result = new Map<
        string,
        {
          deleted: number;
          committed: Committed<Schemas, keyof Schemas>;
          before?: Date;
        }
      >();
      if (full.length) {
        await client.query(`DELETE FROM ${this._fqs} WHERE stream = ANY($1)`, [
          full.map((t) => t.stream),
        ]);
      }
      for (const { stream, snapshot, meta } of full) {
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
      for (const { stream, before, max_id } of windowed) {
        // Closest safe boundary: latest snapshot older than the cutoff and
        // at/below the consumer watermark cap. No qualifying snapshot →
        // no-op, stream absent from the result.
        const { rows } = await client.query(
          `SELECT id, stream, version, name, data, created, meta
           FROM ${this._fqt}
           WHERE stream = $1 AND name = $2 AND created < $3
             AND ($4::int IS NULL OR id <= $4)
           ORDER BY id DESC LIMIT 1`,
          [stream, SNAP_EVENT, before, max_id ?? null]
        );
        if (!rows.length) continue;
        const boundary = rows[0] as Committed<Schemas, keyof Schemas>;
        const { rowCount } = await client.query(
          `DELETE FROM ${this._fqt} WHERE stream = $1 AND id < $2`,
          [stream, boundary.id]
        );
        result.set(stream, {
          deleted: rowCount ?? 0,
          committed: boundary,
          before,
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
    const client = await this._client("restore");
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
