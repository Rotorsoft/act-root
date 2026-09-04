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
  SubscribeInput,
  SubscribeResult,
} from "@rotorsoft/act";
import {
  ConcurrencyError,
  is_literal_source,
  StoreError,
  ValidationError,
} from "@rotorsoft/act";
import {
  decrypt,
  type Encryption,
  encrypt,
  makeKeyResolver,
} from "@rotorsoft/act-crypto";

/**
 * SQLite store configuration
 */
export interface SqliteConfig {
  /**
   * libSQL connection URL. **Required — there is no default.**
   *
   * Accepted forms:
   *
   * - `file:myapp.db` — a local database file, relative or absolute.
   *   This is the shape an embedded deployment wants.
   * - `libsql://…` / `https://…` — a remote libSQL server, paired with
   *   {@link SqliteConfig.authToken}.
   * - `:memory:` / `file::memory:` — an in-memory database. Normalized
   *   to `file::memory:?cache=shared`, because libSQL hands every
   *   *connection* its own private database otherwise and the client
   *   does not pin statements to one connection — DDL would land in a
   *   database later statements cannot see, so writes would be accepted
   *   and then silently lost. Shared cache is the only in-memory mode
   *   that round-trips, and it comes with a caveat worth knowing: it is
   *   **one database per process**, shared by every store pointed at
   *   it, and it outlives {@link SqliteStore.dispose}. For isolated
   *   throwaway state prefer `InMemoryStore` from `@rotorsoft/act`, or
   *   give each store its own `file:` path.
   *
   * `file::memory:?cache=private` is rejected at construction — it is
   * the failure mode above, spelled out explicitly.
   */
  url: string;
  /** Auth token for libSQL server connections (optional) */
  authToken?: string;
  /**
   * Adapter-layer envelope encryption for the `events.pii` column.
   * Optional — when present, every non-null PII payload is encrypted
   * before INSERT and decrypted on every read; when absent, the
   * column is stored and read as plaintext (the framework's default
   * behavior).
   *
   * Cipher and wire format come from `@rotorsoft/act-crypto`:
   * AES-256-GCM with a versioned base64-framed envelope. The TEXT
   * column stores `JSON.stringify(...)`-ed values either way, so
   * encrypted writes land as a JSON-stringified base64 string and
   * plaintext writes as a JSON-stringified object. The read path
   * discriminates by `typeof` after `JSON.parse` — strings get
   * decrypted, objects pass through — which makes mixed-data
   * rollouts transparent.
   *
   * `forget_pii` semantics are unchanged: the column is set to
   * `NULL` regardless of whether the prior value was plaintext or
   * ciphertext.
   *
   * Encryption at rest at the **storage** layer (SQLite SEE, an
   * encrypted volume, OS-level FDE) composes orthogonally with
   * adapter-layer encryption. See
   * `docs/docs/guides/pii-encryption-at-rest.md` for the decision
   * matrix.
   */
  pii_encryption?: Encryption;
}

/**
 * The only in-memory URL libSQL serves from a single database. A bare
 * `:memory:` / `file::memory:` gives every connection a *private*
 * database, and the client is free to run consecutive statements on
 * different connections — `seed()`'s DDL then lands somewhere the next
 * `commit` cannot see, which surfaces as a successful commit followed
 * by "no such table: events" on readback.
 * @internal
 */
const SHARED_MEMORY_URL = "file::memory:?cache=shared";

/**
 * Recognize libSQL's in-memory URL forms: the bare `:memory:` alias and
 * the `file::memory:` URI it expands to, with or without a query string.
 * Mirrors `isInMemoryConfig` in `@libsql/core`.
 * @internal
 */
const is_in_memory_url = (url: string): boolean =>
  url === ":memory:" ||
  url === "file::memory:" ||
  url.startsWith("file::memory:?");

/**
 * Validate and normalize the configured URL.
 *
 * Two failures are turned into loud construction-time errors rather
 * than silent data loss: a missing URL (there is no safe default — a
 * store has to be told where to write) and an explicitly private
 * in-memory database (unusable, for the reason on
 * {@link SHARED_MEMORY_URL}). Every other in-memory spelling is
 * normalized to the shared-cache form so it actually round-trips.
 * @internal
 */
const resolve_url = (url: unknown): string => {
  if (typeof url !== "string" || url.trim().length === 0)
    throw new ValidationError(
      'SqliteStore config — "url" is required and has no default. Use a file database ("file:myapp.db"), a remote libSQL server ("libsql://…" plus authToken), or ":memory:" for a process-wide shared in-memory database. For isolated throwaway state, prefer InMemoryStore from @rotorsoft/act',
      { url },
      "missing url"
    );
  if (url.startsWith("file::memory:?") && url.includes("cache=private"))
    throw new ValidationError(
      'SqliteStore config — a private in-memory database ("cache=private") cannot back a store: libSQL gives each connection its own database, so writes are accepted and then lost on the next statement. Use ":memory:" for the shared-cache database, a "file:" path, or InMemoryStore from @rotorsoft/act',
      { url },
      "private in-memory url"
    );
  return is_in_memory_url(url) ? SHARED_MEMORY_URL : url;
};

/**
 * Parse a JSON-encoded TEXT column, reviving ISO-date strings to `Date`
 * for cross-adapter payload parity (#1198).
 * @internal
 */
const parse_json = (raw: string): unknown => JSON.parse(raw);

/**
 * SQLite extended result code for a UNIQUE constraint violation
 * (`SQLITE_CONSTRAINT_UNIQUE`). libsql surfaces it on the error's
 * `rawCode`.
 * @internal
 */
const SQLITE_CONSTRAINT_UNIQUE = 2067;

/**
 * Recognize a `(stream, version)` unique-constraint violation from a
 * libsql commit error (#1202). Detects via the extended result code when
 * present, falling back to the message text (`UNIQUE constraint failed`)
 * for drivers that surface only the message.
 * @internal
 */
const is_unique_violation = (e: unknown): boolean => {
  const err = e as { rawCode?: number; message?: unknown };
  return (
    err?.rawCode === SQLITE_CONSTRAINT_UNIQUE ||
    (typeof err?.message === "string" &&
      err.message.includes("UNIQUE constraint failed"))
  );
};

/** Portable stream-filter body grammar: literal characters, `.` (any
 *  single character), and `.*` (any run). Everything else — escapes
 *  (`\.`), character classes (`[0-9]`), grouping/alternation (`(a|b)`),
 *  quantifiers (`+ ? { }`), and mid-pattern anchors — has no faithful
 *  `GLOB` translation and must throw instead of silently mis-matching.
 *  @internal
 */
const PORTABLE_BODY = /^(?:\.\*|\.|[^\\^$.()[\]{}|+?*])*$/;

/** Translate a stream filter (regex-shaped or plain substring) into a
 *  SQLite `GLOB` pattern.
 *
 *  #1197: `GLOB` — not `LIKE` — because `GLOB` is **case-sensitive**,
 *  matching PG's `~` and InMemory's `RegExp`. SQLite's `LIKE` is ASCII
 *  case-insensitive, and its per-connection `PRAGMA case_sensitive_like`
 *  override is unreliable under libsql's pooled connections (a
 *  transaction and a follow-up read can land on different connections).
 *  `GLOB` carries its case-sensitivity in the operator itself, so it is
 *  correct regardless of which pooled connection runs the statement.
 *
 *  Honors `^` / `$` anchors and converts `.*` → `*`, `.` → `?`.
 *  Unanchored input gets `*` wildcards on both sides. `GLOB` has no
 *  ESCAPE clause and `%` / `_` are ordinary literals under it — so no
 *  escaping is needed. The portable grammar rejects `*`, `?`, and `[`
 *  as literals (they are metacharacters), so a literal can never collide
 *  with a `GLOB` wildcard.
 *
 *  Only the portable filter grammar documented on
 *  {@link QueryStreams.stream} is convertible: `^` / `$` anchors, `.`,
 *  `.*`, and literal characters. Any richer regex syntax throws
 *  {@link ValidationError} — a lossy approximation would silently
 *  return wrong rows, the worst available failure mode when the filter
 *  drives `reset` / `unblock`.
 *
 *  Examples:
 *  - `^abc$`  → `abc`        (exact)
 *  - `^abc.*` → `abc*`       (starts-with)
 *  - `.*abc$` → `*abc`       (ends-with)
 *  - `abc`    → `*abc*`      (contains)
 *  - `a.c`    → `*a?c*`      (single-char wildcard, contains)
 *  - `^a_c$`  → `a_c`        (literal underscore — ordinary under GLOB)
 *  - `(a|b)`  → throws {@link ValidationError}
 *
 *  @internal exported for testing
 */
export function streamPatternToGlob(input: string): string {
  let s = input;
  const start = s.startsWith("^");
  const end = s.endsWith("$");
  if (start) s = s.slice(1);
  if (end) s = s.slice(0, -1);
  if (!PORTABLE_BODY.test(s))
    throw new ValidationError(
      `stream filter pattern "${input}" — the SQLite adapter supports only the portable subset: "^" and "$" anchors, "." (any single character), ".*" (any run), and literal characters. Escapes, character classes, grouping, alternation, and quantifiers cannot be converted to GLOB; use stream_exact/source_exact for literal names`,
      input,
      "non-portable stream filter pattern"
    );
  const tokens: string[] = [];
  if (!start) tokens.push("*");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === ".") {
      if (s[i + 1] === "*") {
        tokens.push("*");
        i++;
      } else tokens.push("?");
    } else tokens.push(c);
  }
  if (!end) tokens.push("*");
  // Collapse adjacent `*` wildcards — e.g. `^a.*` would otherwise yield
  // `a**`. GLOB treats `**` as `*`, but collapsing keeps the output
  // minimal and matches the pre-#1197 LIKE behavior.
  let out = "";
  let prev = "";
  for (const t of tokens) {
    if (t === "*" && prev === "*") continue;
    out += t;
    prev = t;
  }
  return out;
}

/**
 * SQLite event store adapter for [@rotorsoft/act](https://www.npmjs.com/package/@rotorsoft/act).
 *
 * Provides persistent event storage using SQLite via `@libsql/client`.
 * All write operations use transactions for ACID guarantees.
 *
 * SQLite is a single-writer store: concurrent write transactions raise
 * `SQLITE_BUSY` rather than serializing transparently, so it does not
 * support competing consumers the way PostgreSQL's `FOR UPDATE SKIP LOCKED`
 * does (the TCK leaves `concurrent_claim` off for this reason). The intended
 * model is a single drain worker per database file.
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
  /**
   * Memoized key resolver for the optional `pii_encryption` envelope.
   * Initialized in the constructor when encryption is configured;
   * `undefined` otherwise. The resolver caches the operator's key on
   * first use — rotation means restarting the store with a fresh
   * provider.
   */
  private readonly _resolve_pii_key: (() => Promise<Buffer>) | undefined;

  constructor(config: SqliteConfig) {
    this.client = createClient({
      url: resolve_url(config?.url),
      authToken: config.authToken,
    });
    this._resolve_pii_key = config.pii_encryption
      ? makeKeyResolver(config.pii_encryption)
      : undefined;
  }

  /**
   * Write-side pii encoder: encrypts when `pii_encryption` is configured,
   * stringifies for the TEXT column either way. `null` passes through so
   * `forget_pii` semantics survive intact (the row format skips the
   * column entirely on a `NULL` write).
   *
   * @internal
   */
  private async _stringify_pii_for_write(
    pii: Readonly<Record<string, unknown>> | null | undefined
  ): Promise<string | null> {
    if (pii == null) return null;
    if (this._resolve_pii_key) {
      return JSON.stringify(await encrypt(pii, this._resolve_pii_key));
    }
    return JSON.stringify(pii);
  }

  /**
   * Read-side pii decoder: parses the TEXT column, and when
   * `pii_encryption` is configured, transparently decrypts any value
   * that came back as a JSON string. Plaintext writes deserialize to
   * objects and pass through — which is what makes mixed-data
   * rollouts (some pre-encryption rows, some post-) read cleanly.
   *
   * @internal
   */
  private async _parse_pii_from_read(
    raw: unknown
  ): Promise<Record<string, unknown> | null> {
    if (raw == null) return null;
    // Revive dates like `data`/`meta` do (#1198/#1365). Base64 ciphertext
    // Dates are resolved from the declared schema by the framework, so the
    // store returns exactly what it stored — plaintext or decrypted alike.
    const parsed = parse_json(raw as string);
    if (this._resolve_pii_key && typeof parsed === "string") {
      return (await decrypt(parsed, this._resolve_pii_key)) as Record<
        string,
        unknown
      >;
    }
    return parsed as Record<string, unknown>;
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
        pii TEXT,
        UNIQUE(stream, version)
      )
    `);
    // Migration for tables created before pii_isolation (#871).
    // libSQL surfaces "duplicate column" as an error, hence the
    // try/swallow — mirrors PG's `ADD COLUMN IF NOT EXISTS`. SQLite's
    // row format skips NULL columns, so events without sensitive
    // declarations pay zero extra bytes.
    try {
      await this.client.execute("ALTER TABLE events ADD COLUMN pii TEXT");
    } catch {
      // already present
    }
    await this.client.execute(
      "CREATE INDEX IF NOT EXISTS idx_events_stream ON events(stream)"
    );
    await this.client.execute(
      "CREATE INDEX IF NOT EXISTS idx_events_name ON events(name)"
    );
    // Partial index over snapshot rows only, so the with_snaps "resume at
    // the latest snapshot" floor (MAX(id) WHERE stream=? AND
    // name='__snapshot__') is an O(log) lookup and costs nothing for
    // streams with no snapshot (the index has no rows for them).
    await this.client.execute(
      "CREATE INDEX IF NOT EXISTS idx_events_snapshot ON events(stream, id) WHERE name = '__snapshot__'"
    );
    // Complement of the snapshot index, and the one claim's has-work probe
    // seeks on: "does this source stream have a non-snapshot event past the
    // watermark?" (#1448). SQLite already probes per candidate with a
    // sargable `stream = ? AND id > ?`, so it only lacked the index — the
    // existing idx_events_stream is stream-only and still has to walk every
    // event of that stream. Partial over non-snapshot rows so the two
    // indexes partition the table rather than overlapping.
    await this.client.execute(
      "CREATE INDEX IF NOT EXISTS idx_events_stream_id ON events(stream, id) WHERE name <> '__snapshot__'"
    );
    await this.client.execute(`
      CREATE TABLE IF NOT EXISTS streams (
        stream TEXT PRIMARY KEY,
        source TEXT,
        at INTEGER NOT NULL DEFAULT -1,
        retry INTEGER NOT NULL DEFAULT -1,
        blocked INTEGER NOT NULL DEFAULT 0,
        error TEXT NOT NULL DEFAULT '',
        leased_by TEXT,
        leased_until TEXT,
        priority INTEGER NOT NULL DEFAULT 0,
        lane TEXT NOT NULL DEFAULT 'default',
        deferred_at TEXT,
        correlated_at INTEGER
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
    // Migration for tables created before deferred reactions (#1090).
    try {
      await this.client.execute(
        "ALTER TABLE streams ADD COLUMN deferred_at TEXT"
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
    // Migration for tables created before the work set (#1485).
    try {
      await this.client.execute(
        "ALTER TABLE streams ADD COLUMN correlated_at INTEGER"
      );
    } catch {
      // already present
    }
    // Rows that predate the mark get one, at the log's head (#1488).
    // `claim` is mark-only now, so a row left at NULL would silently stop
    // being served, and correlate cannot rescue it — its checkpoint is long
    // past those events.
    //
    // Deliberately an over-estimate: it says "worth one look", not "there is
    // work here". The first drain pass claims each such stream once, fetches
    // its window, handles whatever is really there, and acks — after which
    // the watermark catches the mark and the stream leaves the claimable set
    // with an honest position. One extra cycle per pre-existing subscription,
    // paid once, in exchange for a schema step with no per-row probing.
    await this.client.execute(
      `UPDATE streams
       SET correlated_at = (SELECT COALESCE(MAX(id), -1) FROM events)
       WHERE correlated_at IS NULL`
    );
    // Correlate checkpoint (#1484), keyed per correlator (#1532).
    //
    // Its own table rather than a reserved subscription: a subscription row is
    // counted by every stream-scoped operator surface (prioritize / reset /
    // unblock / query_streams / blocked_streams) and would inflate those
    // counts.
    //
    // Keyed because correlators that look for different things read the log
    // for different reasons. One row let a worker running partial behaviour
    // inherit another's position, and would let one hold a lease the other
    // needs. The empty key is the shared row a caller with no correlator
    // reads, and the floor a brand-new key inherits.
    //
    // SQLite cannot drop a primary key, so migrating the pre-#1532 shape
    // means rebuilding: copy the single row's checkpoint across as the shared
    // row, then swap the tables. Guarded on the old `id` column, so a seed
    // against either shape converges and the checkpoint survives.
    const correlated_columns = await this.client.execute(
      "PRAGMA table_info(correlated)"
    );
    const legacy = correlated_columns.rows.some((r) => r.name === "id");
    if (legacy) {
      await this.client.execute(`
        CREATE TABLE IF NOT EXISTS correlated_keyed (
          key TEXT PRIMARY KEY,
          at INTEGER NOT NULL DEFAULT -1,
          leased_by TEXT,
          leased_until INTEGER
        )
      `);
      await this.client.execute(
        "INSERT OR IGNORE INTO correlated_keyed (key, at) SELECT '', at FROM correlated WHERE id = 0"
      );
      await this.client.execute("DROP TABLE correlated");
      await this.client.execute(
        "ALTER TABLE correlated_keyed RENAME TO correlated"
      );
    } else {
      await this.client.execute(`
        CREATE TABLE IF NOT EXISTS correlated (
          key TEXT PRIMARY KEY,
          at INTEGER NOT NULL DEFAULT -1,
          leased_by TEXT,
          leased_until INTEGER
        )
      `);
    }
    await this.client.execute(
      "INSERT OR IGNORE INTO correlated (key) VALUES ('')"
    );
    await this.client.execute(
      "CREATE INDEX IF NOT EXISTS idx_streams_claim ON streams(blocked, priority DESC, at)"
    );
    // The correlated set IS the index (#1485): it holds only streams with
    // work, so `claim` scans candidates instead of every subscription. A
    // stream leaves when `ack` advances `at` to `correlated_at`, and re-enters
    // when correlate raises the mark.
    await this.client.execute(
      "CREATE INDEX IF NOT EXISTS idx_streams_correlated_at ON streams(lane, priority DESC, at) WHERE blocked = 0 AND at < correlated_at"
    );
    // The same set without the lane prefix. SQLite can only use an index for
    // ORDER BY when the leading columns are constrained, so a claim with no
    // lane filter — the shape every app that never calls `.withLane` issues —
    // could not use the index above and fell back to sorting the whole
    // eligible set. With this one the scan stops at `lagging + leading` rows.
    await this.client.execute(
      "CREATE INDEX IF NOT EXISTS idx_streams_correlated_at_any_lane ON streams(priority DESC, at) WHERE blocked = 0 AND at < correlated_at"
    );
    // Lane filter index (ACT-1103).
    await this.client.execute(
      "CREATE INDEX IF NOT EXISTS idx_streams_lane ON streams(lane)"
    );
  }

  async drop() {
    await this.client.execute("DROP TABLE IF EXISTS events");
    await this.client.execute("DROP TABLE IF EXISTS streams");
    await this.client.execute("DROP TABLE IF EXISTS correlated");
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
    // Hoisted so the catch can build a ConcurrencyError with the head
    // version on a (stream, version) unique collision (#1202).
    let current_version = -1;
    try {
      const version_row = await tx.execute({
        sql: "SELECT COALESCE(MAX(version), -1) as v FROM events WHERE stream = ?",
        args: [stream],
      });
      current_version = Number(version_row.rows[0].v);

      if (
        typeof expectedVersion === "number" &&
        current_version !== expectedVersion
      ) {
        throw new ConcurrencyError(
          stream,
          current_version,
          msgs as Message<Schemas, keyof Schemas>[],
          expectedVersion
        );
      }

      const now = new Date().toISOString();
      const committed: Committed<E, keyof E>[] = [];
      let version = current_version + 1;

      for (const { name, data, pii } of msgs) {
        const pii_for_write = await this._stringify_pii_for_write(pii);
        const result = await tx.execute({
          sql: "INSERT INTO events (stream, version, name, data, meta, created, pii) VALUES (?, ?, ?, ?, ?, ?, ?)",
          args: [
            stream,
            version,
            name as string,
            JSON.stringify(data),
            JSON.stringify(meta),
            now,
            pii_for_write,
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
          ...(pii == null ? {} : { pii }),
        });
        version++;
      }

      await tx.commit();
      return committed;
    } catch (e) {
      await tx.rollback();
      // #1202: map the (stream, version) unique collision to
      // ConcurrencyError — the same signal PG raises from 23505 — so a
      // caller retries on the framework contract, not a raw libsql error.
      // This is the race where the version probe passed but a concurrent
      // INSERT (a second store on the same file, tooling, the act CLI)
      // beat this one to the row. Every other driver error is wrapped in
      // StoreError('commit') for parity with the adapter's other methods.
      if (e instanceof ConcurrencyError) throw e;
      if (is_unique_violation(e))
        throw new ConcurrencyError(
          stream,
          current_version,
          msgs as Message<Schemas, keyof Schemas>[],
          expectedVersion ?? -1
        );
      throw new StoreError("commit", { cause: e });
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
        sql += " AND stream GLOB ?";
        args.push(streamPatternToGlob(query.stream));
      }
    }
    if (query?.names !== undefined) {
      // #1199: `names: []` means "match no event names". An empty
      // placeholder list yields `name IN ()` which SQLite evaluates as
      // always-false — matching the PG (`= ANY('{}')`) / InMemory
      // semantics. `!== undefined` (not truthiness) keeps that explicit.
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
    } else if (query?.with_snaps && query.stream_exact && query.stream) {
      // Resume at the latest snapshot for this stream so pre-snapshot
      // events aren't scanned. No snapshot → MAX is NULL → -1 → full
      // stream. An explicit `after` (above) wins. The orchestrator only sets
      // `with_snaps` for an unbounded current-state load — it suppresses the
      // flag under any `asOf` bound (RFC 1274) — so the floor never needs to
      // re-check `before`/`created_*`/`limit` here.
      sql +=
        " AND id >= (SELECT COALESCE(MAX(id), -1) FROM events WHERE stream = ? AND name = '__snapshot__')";
      args.push(query.stream);
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
      const pii_value = await this._parse_pii_from_read(row.pii);
      await Promise.resolve(
        callback({
          id: Number(row.id),
          stream: row.stream as string,
          version: Number(row.version),
          created: new Date(row.created as string),
          name: row.name as string,
          data: parse_json(row.data as string) as any,
          meta: parse_json(row.meta as string) as any,
          pii: pii_value,
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
    streams: SubscribeInput[],
    correlated_at?: number,
    correlator?: { key: string; by: string; millis: number }
  ): Promise<SubscribeResult> {
    // Fail loud at registration for a claim source this adapter cannot
    // match: libsql has no `REGEXP`, and the portable GLOB grammar cannot
    // express alternation/grouping. A pattern source outside the portable
    // subset (e.g. `^(A|B)$`) would otherwise silently never claim its
    // stream, so `streamPatternToGlob` throws `ValidationError` here —
    // pointing operators to InMemory/PG for full regex claim sources —
    // before any row is written. Literal sources skip the check entirely.
    for (const { source } of streams) {
      if (source !== undefined && !is_literal_source(source))
        streamPatternToGlob(source);
    }
    const tx = await this.client.transaction("write");
    try {
      let subscribed = 0;
      for (const {
        stream,
        source,
        priority = 0,
        lane = "default",
        correlated_at,
      } of streams) {
        const inserted = await tx.execute({
          sql: "INSERT OR IGNORE INTO streams (stream, source, priority, lane, retry) VALUES (?, ?, ?, ?, -1)",
          args: [stream, source ?? null, priority, lane],
        });
        if (inserted.rowsAffected > 0) {
          subscribed++;
        } else {
          // `WHERE priority < ?` is the whole max rule, for every value on
          // the number line. An extra `priority > 0` gate around this used to
          // skip the merge for non-positive priorities, which made a stored
          // negative priority unraisable: an operator's `prioritize(-5)`
          // survived every subsequent boot instead of being restored to the
          // declared priority by the restart-driven re-subscribe (#1445).
          await tx.execute({
            sql: "UPDATE streams SET priority = ? WHERE stream = ? AND priority < ?",
            args: [priority, stream, priority],
          });
          // ACT-1103 / #1599: the lane rides the priority max. `priority <=
          // ?` reads the row after the merge above, which is the same test
          // as "at or above the stored priority" — the merge only fires when
          // the incoming value is higher. A subscribe below the stored
          // priority leaves the lane alone, so a caller that has forgotten
          // what a stream carries cannot re-lane it from underneath the
          // highest-priority reaction that owns it.
          await tx.execute({
            sql: "UPDATE streams SET lane = ? WHERE stream = ? AND lane <> ? AND priority <= ?",
            args: [lane, stream, lane, priority],
          });
        }
        // The work mark never regresses (#1485). `WHERE correlated_at IS
        // NULL OR correlated_at < ?` is the whole rule: the NULL arm is first
        // mark (a comparison against NULL is unknown, so the predicate alone
        // would skip it), and it holds for every value including zero and
        // negatives. Written here rather than in the INSERT above so an
        // unmarked subscribe never names the column — a table that predates
        // it, and that `seed()` has not migrated, keeps working.
        if (correlated_at !== undefined)
          await tx.execute({
            sql: "UPDATE streams SET correlated_at = ? WHERE stream = ? AND (correlated_at IS NULL OR correlated_at < ?)",
            args: [correlated_at, stream, correlated_at],
          });
      }
      const wm = await tx.execute(
        "SELECT COALESCE(MAX(at), -1) as w FROM streams"
      );
      // The correlate checkpoint is written by its own producer, in the call
      // correlate already makes (#1484). MAX keeps it monotonic.
      // With a correlator the position and the lease are per-key (#1532),
      // both in one conditional upsert: a read then a write would let two
      // workers that both saw an expired lease believe they hold it, which is
      // the duplication the lease removes. A key with no row yet seeds from
      // the shared row, so an upgrade does not re-read history.
      let correlating: boolean | undefined;
      if (correlator) {
        const now = Date.now();
        const taken = await tx.execute({
          sql: `INSERT INTO correlated (key, at, leased_by, leased_until)
                SELECT ?,
                       MAX(COALESCE(?, -1),
                           COALESCE((SELECT at FROM correlated WHERE key = ''), -1)),
                       ?, ?
                ON CONFLICT (key) DO UPDATE
                   SET at = MAX(correlated.at, COALESCE(?, -1)),
                       leased_by = excluded.leased_by,
                       leased_until = excluded.leased_until
                 WHERE correlated.leased_until IS NULL
                    OR correlated.leased_until < ?
                    OR correlated.leased_by = excluded.leased_by`,
          args: [
            correlator.key,
            correlated_at ?? null,
            correlator.by,
            // `millis <= 0` releases outright rather than setting an expiry a
            // hair in the future, which would still refuse a successor asking
            // in the same instant.
            correlator.millis > 0 ? now + correlator.millis : null,
            correlated_at ?? null,
            now,
          ],
        });
        correlating = taken.rowsAffected > 0;
        // Losing the race must still advance the checkpoint this worker
        // already read past, or its marks and its position disagree.
        if (!correlating && correlated_at !== undefined)
          await tx.execute({
            sql: "UPDATE correlated SET at = MAX(at, ?) WHERE key = ?",
            args: [correlated_at, correlator.key],
          });
        // The shared row tracks how far *any* correlator has read: the floor
        // a brand-new key inherits, and what a caller reading without a
        // correlator still sees.
        if (correlated_at !== undefined)
          await tx.execute({
            sql: "UPDATE correlated SET at = MAX(at, ?) WHERE key = ''",
            args: [correlated_at],
          });
      } else if (correlated_at !== undefined)
        await tx.execute({
          sql: "UPDATE correlated SET at = MAX(at, ?) WHERE key = ''",
          args: [correlated_at],
        });
      // Watermark and checkpoint together — correlate needs both.
      const cp = await tx.execute({
        sql: "SELECT at FROM correlated WHERE key = ?",
        args: [correlator?.key ?? ""],
      });
      await tx.commit();
      return {
        subscribed,
        watermark: Number(wm.rows[0].w),
        // `seed()` always inserts the shared row, and a correlator's row is
        // created by the upsert above — or already existed, which is why the
        // lease was refused. Either way this read cannot come back empty, so
        // there is no defensive fallback to leave untested.
        correlated_at: Number(cp.rows[0].at),
        ...(correlating === undefined ? {} : { correlating }),
      };
    } catch (e) {
      await tx.rollback();
      throw new StoreError("subscribe", { cause: e });
    }
  }

  // --- claim: write transaction. Single-writer: concurrent claims from
  //     separate connections raise SQLITE_BUSY, so this assumes one drain
  //     worker per database file (see class doc; TCK `concurrent_claim` off).
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

      const lane_clause = lane !== undefined ? " AND lane = ?" : "";
      // Eligibility is a pure subscription-table predicate (#1488). `claim`
      // does not read the events table at all: correlate records the highest
      // event id that resolves to a target, and `at < correlated_at` is the
      // whole question, answered by the partial index built for it.
      //
      // What this replaced was the worst shape in the adapter — every
      // eligible row selected with no limit, then one `SELECT 1 FROM events`
      // per candidate in a JavaScript loop with no early exit, all inside
      // `transaction("write")`, so a claim's cost was linear in subscribed
      // streams and every concurrent commit queued behind it. There was no
      // index fix available for it, because the probe was in JS rather than
      // in SQL.
      //
      // A row with no mark is not claimable, by definition (#1446): NULL
      // means the row has never been correlated, not that it has no work.
      // An install upgrading from before the column needs one correlate pass
      // from a rewound checkpoint — see the runbook in
      // docs/docs/guides/production-checklist.md.
      // Three bounded reads, unioned, so the scan is O(lease budget)
      // rather than O(streams with work): the priority frontier, the
      // fairness reserve's pure-watermark order, and the leading frontier.
      // Their union is a superset of every row the split below can pick —
      // the fairness reserve needs at most `lagging` rows by `at ASC`, since
      // in the worst case every priority pick is also a lowest-watermark one.
      const elig = `blocked = 0 AND (leased_until IS NULL OR leased_until <= ?)
                AND (deferred_at IS NULL OR deferred_at <= ?)${lane_clause}
                AND at < correlated_at`;
      const cols = "stream, source, at, priority, lane";
      const where_args = lane !== undefined ? [now, now, lane] : [now, now];
      const result = await tx.execute({
        sql: `SELECT ${cols} FROM (SELECT ${cols} FROM streams WHERE ${elig}
                ORDER BY priority DESC, at ASC LIMIT ?)
              UNION
              SELECT ${cols} FROM (SELECT ${cols} FROM streams WHERE ${elig}
                ORDER BY at ASC LIMIT ?)
              UNION
              SELECT ${cols} FROM (SELECT ${cols} FROM streams WHERE ${elig}
                ORDER BY at DESC LIMIT ?)`,
        args: [
          ...where_args,
          lagging,
          ...where_args,
          lagging,
          ...where_args,
          leading,
        ],
      });

      // UNION does not preserve the operands' order, so re-establish the
      // one the split below reads: priority DESC, then watermark ASC. Over
      // this superset that yields the same head as the unbounded scan did.
      const candidates = result.rows
        .map((row) => ({
          stream: row.stream as string,
          source: (row.source as string | null) ?? undefined,
          at: Number(row.at),
          priority: Number(row.priority),
          lane: row.lane as string,
        }))
        .sort((a, b) => b.priority - a.priority || a.at - b.at);

      // Dual frontier: lagging (priority DESC, watermark ASC — ACT-102)
      // + leading (newest first). The candidates list arrives sorted
      // by `priority DESC, at ASC` from the SELECT above. The lagging
      // budget is split (ACT-1223): the priority portion takes the first
      // `lagging - fair` candidates in that order; a fairness reserve then
      // fills `fair` more by pure `at ASC` (priority ignored), excluding
      // the ones already picked, so a default-priority lagging stream is
      // never starved out by sustained higher-priority load. With all
      // priorities equal both portions order by `at`, a no-op split.
      const fair = lagging >= 2 ? Math.max(1, Math.floor(lagging / 4)) : 0;
      const priority_slice = candidates.slice(0, lagging - fair);
      const picked = new Set(priority_slice.map((c) => c.stream));
      const fair_slice = [...candidates]
        .sort((a, b) => a.at - b.at)
        .filter((c) => !picked.has(c.stream))
        .slice(0, fair);
      const lag = [...priority_slice, ...fair_slice].map((c) => ({
        ...c,
        lagging: true,
      }));
      const lead = [...candidates]
        .sort((a, b) => b.at - a.at)
        .slice(0, leading)
        .map((c) => ({ ...c, lagging: false }));
      const seen = new Set<string>();
      const combined = [...lag, ...lead].filter((p) => {
        if (seen.has(p.stream)) return false;
        seen.add(p.stream);
        return true;
      });

      const leases: Lease[] = [];
      const until = new Date(Date.now() + millis).toISOString();
      for (const row of combined) {
        const updated = await tx.execute({
          sql: "UPDATE streams SET leased_by = ?, leased_until = ?, retry = retry + 1 WHERE stream = ? RETURNING retry",
          args: [by, until, row.stream],
        });
        leases.push({
          stream: row.stream,
          source: row.source,
          at: row.at,
          by,
          retry: Number(updated.rows[0].retry),
          lagging: row.lagging,
          lane: row.lane,
        });
      }

      await tx.commit();
      return leases;
    } catch (e) {
      await tx.rollback();
      throw new StoreError("claim", { cause: e });
    }
  }

  // --- ack: transaction + ownership check (= PG WHERE leased_by) ---
  async ack(leases: Lease[]) {
    const tx = await this.client.transaction("write");
    try {
      // The whole batch finalizes in one transaction, so acks and defer
      // schedules land all-or-nothing per the Store.ack contract. Every
      // entry advances the watermark to its `at` (the last event handled
      // this cycle); an entry without `due` also clears retry + schedule,
      // while an entry with `due` additionally sets the schedule and the
      // entry's own `retry` — advance and defer are independent legs
      // (#1278), so a partial-progress defer keeps the handled prefix. The
      // bound schedule doubles as the ack-vs-defer discriminator — NULL
      // means ack. An explicit defer passes retry -1 (not a failure); a
      // backoff retry passes the climbing counter so the budget keeps
      // accruing across windows (#1262). Only acked entries are returned.
      const result: Lease[] = [];
      for (const l of leases) {
        const due = l.due !== undefined ? new Date(l.due).toISOString() : null;
        const r = await tx.execute({
          // RETURNING the post-ack `retry`/`source`/`lane` from the row so the
          // returned lease reflects the authoritative state, not the caller's
          // pre-ack echo (#1347). A non-due ack sets `retry = -1`; pushing the
          // input lease verbatim leaked the claim-incremented value and
          // diverged from PG (RETURNING s.retry) and InMemory (which return the
          // reset -1). `at`/`by`/`lagging` still come from the input lease,
          // matching both other adapters.
          sql: `UPDATE streams
                SET at = ?,
                    deferred_at = ?,
                    leased_by = NULL, leased_until = NULL,
                    retry = CASE WHEN ? IS NULL THEN -1 ELSE ? END
                WHERE stream = ? AND leased_by = ?
                RETURNING source, retry, lane`,
          args: [l.at, due, due, l.retry, l.stream, l.by],
        });
        if (due === null && r.rows.length > 0) {
          const row = r.rows[0];
          result.push({
            stream: l.stream,
            source: (row.source as string | null) ?? undefined,
            at: l.at,
            by: l.by,
            retry: Number(row.retry),
            lagging: l.lagging,
            lane: row.lane as string,
          });
        }
      }
      await tx.commit();
      return result;
    } catch (e) {
      await tx.rollback();
      throw new StoreError("ack", { cause: e });
    }
  }

  // --- block: transaction + ownership + idempotent (= PG) ---
  async block(leases: BlockedLease[]) {
    const tx = await this.client.transaction("write");
    try {
      const result: BlockedLease[] = [];
      for (const l of leases) {
        const r = await tx.execute({
          // RETURNING the post-block row so the returned lease reflects the
          // authoritative state, not the caller's echo (#1382, the `block`
          // twin of #1347). A block leaves the watermark alone — the failing
          // event must be retried, not skipped — but `run_drain_cycle` hands
          // us a lease whose `at` was fast-forwarded to the fetch ceiling, so
          // pushing the input verbatim reported a position the row never
          // held. `by`/`error`/`lagging` still come from the input lease,
          // matching PG (`RETURNING s.stream, s.source, s.at, i.by, ...`).
          sql: `UPDATE streams SET blocked = 1, error = ?, deferred_at = NULL
                WHERE stream = ? AND leased_by = ? AND blocked = 0
                RETURNING source, at, retry, lane`,
          args: [l.error, l.stream, l.by],
        });
        if (r.rows.length > 0) {
          const row = r.rows[0];
          result.push({
            stream: l.stream,
            source: (row.source as string | null) ?? undefined,
            at: Number(row.at),
            by: l.by,
            retry: Number(row.retry),
            error: l.error,
            lagging: l.lagging,
            lane: row.lane as string,
          });
        }
      }
      await tx.commit();
      return result;
    } catch (e) {
      await tx.rollback();
      throw new StoreError("block", { cause: e });
    }
  }

  // --- defer: hold streams out of claim until deferred_at (#1090) ---
  // Persisted as an ISO string (like leased_until) so claim's
  // `deferred_at <= now` comparison is a lexicographic string compare.
  // Cleared by ack/block/reset/unblock. See {@link Store.defer}.
  async defer(input: string[] | StreamFilter, deferred_at: number) {
    const at_iso = new Date(deferred_at).toISOString();
    const tx = await this.client.transaction("write");
    try {
      let count = 0;
      if (Array.isArray(input)) {
        // De-dup so a repeated name counts once, matching PG's set-based
        // `WHERE stream = ANY(...)` (#1360).
        for (const stream of new Set(input)) {
          const r = await tx.execute({
            sql: `UPDATE streams SET deferred_at = ?, retry = -1 WHERE stream = ?`,
            args: [at_iso, stream],
          });
          count += r.rowsAffected;
        }
      } else {
        const { clause, args } = this._filter_clause(input);
        const r = await tx.execute({
          sql: `UPDATE streams SET deferred_at = ?, retry = -1 WHERE ${clause}`,
          args: [at_iso, ...args] as any[],
        });
        count = r.rowsAffected;
      }
      await tx.commit();
      return count;
    } catch (e) {
      await tx.rollback();
      throw new StoreError("defer", { cause: e });
    }
  }

  /**
   * Translate a {@link StreamFilter} to a SQLite `WHERE` clause fragment
   * plus positional args. Returns `"1"` (always true) when empty so
   * callers can compose it unconditionally.
   */
  private _filter_clause(filter: StreamFilter): {
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
        conditions.push("stream GLOB ?");
        args.push(streamPatternToGlob(filter.stream));
      }
    }
    if (filter.source !== undefined) {
      conditions.push("source IS NOT NULL");
      if (filter.source_exact) {
        conditions.push("source = ?");
        args.push(filter.source);
      } else {
        conditions.push("source GLOB ?");
        args.push(streamPatternToGlob(filter.source));
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
    const set_clause = `SET at = -1, retry = -1, blocked = 0, error = '',
                          leased_by = NULL, leased_until = NULL, deferred_at = NULL`;
    const tx = await this.client.transaction("write");
    try {
      let count = 0;
      if (Array.isArray(input)) {
        // De-dup so a repeated name counts once, matching PG's set-based
        // `WHERE stream = ANY(...)` (#1360).
        for (const stream of new Set(input)) {
          const r = await tx.execute({
            sql: `UPDATE streams ${set_clause} WHERE stream = ?`,
            args: [stream],
          });
          count += r.rowsAffected;
        }
      } else {
        const { clause, args } = this._filter_clause(input);
        const r = await tx.execute({
          sql: `UPDATE streams ${set_clause} WHERE ${clause}`,
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
    const set_clause = `SET retry = -1, blocked = 0, error = '',
                          leased_by = NULL, leased_until = NULL, deferred_at = NULL`;
    const tx = await this.client.transaction("write");
    try {
      let count = 0;
      if (Array.isArray(input)) {
        for (const stream of input) {
          const r = await tx.execute({
            sql: `UPDATE streams ${set_clause}
                  WHERE stream = ? AND blocked = 1`,
            args: [stream],
          });
          count += r.rowsAffected;
        }
      } else {
        // Filter form: force blocked = true regardless of what the
        // caller passed.
        const { clause, args } = this._filter_clause({
          ...input,
          blocked: true,
        });
        const r = await tx.execute({
          sql: `UPDATE streams ${set_clause} WHERE ${clause}`,
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
      "SELECT stream, source, at, retry, blocked, error, leased_by, leased_until, priority, lane, deferred_at, correlated_at FROM streams WHERE 1=1";
    const args: unknown[] = [];

    if (query?.stream !== undefined) {
      if (query.stream_exact) {
        sql += " AND stream = ?";
        args.push(query.stream);
      } else {
        sql += " AND stream GLOB ?";
        args.push(streamPatternToGlob(query.stream));
      }
    }
    if (query?.source !== undefined) {
      sql += " AND source IS NOT NULL";
      if (query.source_exact) {
        sql += " AND source = ?";
        args.push(query.source);
      } else {
        sql += " AND source GLOB ?";
        args.push(streamPatternToGlob(query.source));
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
      // Persisted as an ISO string (like leased_until); surface as ms since
      // epoch (#1221) so the cold-start re-seed re-arms at the due-time.
      const deferred_at = row.deferred_at as string | null;
      // NULL means "no mark yet" — unknown, not "no work" (#1485).
      const correlated_at = row.correlated_at as number | null;
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
        deferred_at: deferred_at ? new Date(deferred_at).getTime() : undefined,
        correlated_at: correlated_at ?? undefined,
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
    const want_tail = options?.tail ?? false;
    const want_count = options?.count ?? false;
    const want_names = options?.names ?? false;
    const before = options?.before;
    const after = options?.after;
    const limit = options?.limit;
    const full_scan = want_count || want_names;

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
        where.push(`e.stream GLOB ?`);
        args.push(streamPatternToGlob(input.stream));
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
    // Keyset pagination cursor (#1010): exclusive — return only streams
    // whose name sorts strictly after `after`. Applied at the event level
    // so the per-stream head/agg rows downstream only cover the page.
    if (after !== undefined) {
      where.push(`e.stream > ?`);
      args.push(after);
    }

    const from_clause = `events e`;
    // Always emit a WHERE clause — `WHERE 1=1` short-circuits the
    // empty-filter case without a conditional branch on the generation
    // side. SQLite optimizes the trivial predicate out.
    const where_clause = `WHERE ${where.length ? where.join(" AND ") : "1=1"}`;

    return full_scan
      ? this._query_stats_full_scan<E>(
          from_clause,
          where_clause,
          args,
          want_tail,
          want_count,
          want_names,
          limit
        )
      : this._query_stats_heads_only<E>(
          from_clause,
          where_clause,
          args,
          want_tail,
          limit
        );
  }

  /**
   * Cheap path — head (and optional tail) via ROW_NUMBER() over the
   * `(stream, version)` unique index. Parallel queries when tail set.
   */
  private async _query_stats_heads_only<E extends Schemas>(
    from_clause: string,
    where_clause: string,
    args: unknown[],
    want_tail: boolean,
    limit?: number
  ): Promise<Map<string, StreamStats<E>>> {
    // `query_stats` is an operator-introspection surface with no actor
    // context and no disclosure gate, so it never carries pii — heads/tails
    // return the event shape without the pii sidecar, matching PostgresStore
    // and InMemoryStore (#1294).
    const cols = `e.id, e.stream, e.version, e.name, e.data, e.created, e.meta`;
    // Keyset pagination (#1010): order heads by stream ascending so the
    // caller can use the last key as the next `after` cursor; cap with
    // LIMIT when set (unbounded otherwise).
    const limit_clause = limit !== undefined ? " LIMIT ?" : "";
    const head_sql = `SELECT * FROM (
      SELECT ${cols}, ROW_NUMBER() OVER (PARTITION BY e.stream ORDER BY e.version DESC) AS rn
      FROM ${from_clause}
      ${where_clause}
    ) WHERE rn = 1 ORDER BY stream${limit_clause}`;
    const head_args = limit !== undefined ? [...args, limit] : args;
    // The tail query shares the same WHERE; when paginating it must cover
    // exactly the limited head stream set, so it joins against the same
    // ordered+limited heads subquery rather than re-scanning all streams.
    const tail_sql = want_tail
      ? `SELECT t.* FROM (
          SELECT ${cols}, ROW_NUMBER() OVER (PARTITION BY e.stream ORDER BY e.version ASC) AS rn
          FROM ${from_clause}
          ${where_clause}
        ) t
        WHERE t.rn = 1 AND t.stream IN (
          SELECT stream FROM (
            SELECT e.stream, ROW_NUMBER() OVER (PARTITION BY e.stream ORDER BY e.version DESC) AS rn
            FROM ${from_clause}
            ${where_clause}
          ) WHERE rn = 1 ORDER BY stream${limit_clause}
        )`
      : null;
    const tail_args =
      limit !== undefined ? [...args, ...args, limit] : [...args, ...args];

    const [headRes, tailRes] = await Promise.all([
      this.client.execute({ sql: head_sql, args: head_args as any[] }),
      tail_sql
        ? this.client.execute({ sql: tail_sql, args: tail_args as any[] })
        : null,
    ]);

    const to_committed = (
      row: Record<string, unknown>
    ): Committed<E, keyof E> =>
      ({
        id: Number(row.id),
        stream: row.stream as string,
        version: Number(row.version),
        name: row.name as string,
        data: parse_json(row.data as string) as any,
        meta: parse_json(row.meta as string) as any,
        created: new Date(row.created as string),
      }) as Committed<E, keyof E>;

    const out = new Map<string, StreamStats<E>>();
    for (const row of headRes.rows) {
      out.set(row.stream as string, {
        head: to_committed(row as Record<string, unknown>),
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
        ).tail = to_committed(row as Record<string, unknown>);
      }
    }
    return out;
  }

  /**
   * Full-scan path — one CTE-based query with per-stream `COUNT(*)` and
   * `json_group_object(name, n)`. Heads (and optional tails) ride free
   * on the same scan.
   */
  private async _query_stats_full_scan<E extends Schemas>(
    from_clause: string,
    where_clause: string,
    args: unknown[],
    want_tail: boolean,
    want_count: boolean,
    want_names: boolean,
    limit?: number
  ): Promise<Map<string, StreamStats<E>>> {
    const tail_cte = want_tail
      ? `, tails AS (
          SELECT * FROM (
            SELECT *, ROW_NUMBER() OVER (PARTITION BY stream ORDER BY version ASC) AS rn FROM ef
          ) WHERE rn = 1
        )`
      : "";
    const tail_join = want_tail
      ? `LEFT JOIN tails t ON t.stream = h.stream`
      : "";
    const tail_cols = want_tail
      ? `, t.id AS t_id, t.stream AS t_stream, t.version AS t_version,
           t.name AS t_name, t.data AS t_data, t.created AS t_created, t.meta AS t_meta`
      : "";

    // No pii column: `query_stats` heads/tails are pii-free (#1294 — see
    // `_query_stats_heads_only`).
    const sql = `
      WITH ef AS (
        SELECT e.id, e.stream, e.version, e.name, e.data, e.created, e.meta
        FROM ${from_clause}
        ${where_clause}
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
        ORDER BY stream${limit !== undefined ? " LIMIT ?" : ""}
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
    `;

    // Keyset pagination (#1010): the `heads` CTE is ordered by stream and
    // capped with LIMIT (when set); the final SELECT re-asserts stream
    // order so the returned Map's key order is the next cursor. The LIMIT
    // arg binds last when present (unbounded otherwise).
    const full_args = limit !== undefined ? [...args, limit] : args;
    const res = await this.client.execute({ sql, args: full_args as any[] });

    const to_committed = (
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
        data: parse_json(data as string) as any,
        meta: parse_json(meta as string) as any,
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
        head: to_committed(
          r.id,
          r.stream,
          r.version,
          r.name,
          r.data,
          r.meta,
          r.created
        ),
      };
      if (want_tail && r.t_id !== null && r.t_id !== undefined) {
        stats.tail = to_committed(
          r.t_id,
          r.t_stream,
          r.t_version,
          r.t_name,
          r.t_data,
          r.t_meta,
          r.t_created
        );
      }
      if (want_count) stats.count = Number(r.agg_count);
      // `agg_names` is non-null when this row exists: heads and agg are
      // both built from the same `ef` CTE, so any stream in heads has
      // at least one matching event and `json_group_object` returns a
      // JSON string (never null) for that group.
      if (want_names) stats.names = JSON.parse(r.agg_names as string);
      out.set(r.stream as string, stats as StreamStats<E>);
    }
    return out;
  }

  // --- prioritize: bulk priority update with filter (ACT-102) ---
  async prioritize(filter: StreamFilter, priority: number): Promise<number> {
    const { clause, args: filterArgs } = this._filter_clause(filter);
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
  // Windowed targets (`before` set) prune the prefix below the closest safe
  // `__snapshot__` instead — no seed, subscriptions untouched, no-op when no
  // snapshot qualifies.
  async truncate(
    targets: Array<{
      stream: string;
      snapshot?: Record<string, unknown>;
      meta?: EventMeta;
      before?: Date;
      max_id?: number;
    }>
  ) {
    const result = new Map<
      string,
      {
        deleted: number;
        committed: Committed<Schemas, keyof Schemas>;
        before?: Date;
      }
    >();

    const tx = await this.client.transaction("write");
    try {
      for (const { stream, before, max_id } of targets) {
        if (before === undefined) continue;
        // Closest safe boundary: latest snapshot older than the cutoff
        // and at/below the consumer watermark cap. ISO-8601 strings
        // compare lexicographically, so `created < ?` works on the text
        // column. No qualifying snapshot → no-op, absent from the result.
        const snap_row = await tx.execute({
          sql: `SELECT id, stream, version, name, data, meta, created
                FROM events
                WHERE stream = ? AND name = '__snapshot__' AND created < ?
                  AND (? IS NULL OR id <= ?)
                ORDER BY id DESC LIMIT 1`,
          args: [stream, before.toISOString(), max_id ?? null, max_id ?? null],
        });
        if (!snap_row.rows.length) continue;
        const row = snap_row.rows[0];
        const boundary_id = Number(row.id);
        const del = await tx.execute({
          sql: "DELETE FROM events WHERE stream = ? AND id < ?",
          args: [stream, boundary_id],
        });
        result.set(stream, {
          deleted: del.rowsAffected,
          committed: {
            id: boundary_id,
            stream,
            version: Number(row.version),
            created: new Date(row.created as string),
            name: row.name as string,
            data: parse_json(row.data as string) as any,
            meta: parse_json(row.meta as string) as any,
          },
          before,
        });
      }
      for (const { stream, snapshot, meta, before } of targets) {
        if (before !== undefined) continue;
        const count_row = await tx.execute({
          sql: "SELECT COUNT(*) as c FROM events WHERE stream = ?",
          args: [stream],
        });
        const deleted = Number(count_row.rows[0].c);
        await tx.execute({
          sql: "DELETE FROM events WHERE stream = ?",
          args: [stream],
        });
        // Subscriptions are deliberately untouched, for restart *and* retire
        // targets alike — see the note in truncate's contract. A tombstoned
        // stream's subscription is inert, and reaping it is maintenance that
        // `seed()` performs (#1527).

        const event_name =
          snapshot !== undefined ? "__snapshot__" : "__tombstone__";
        const event_meta = meta ?? { correlation: "", causation: {} };
        const now = new Date().toISOString();
        const ins = await tx.execute({
          sql: "INSERT INTO events (stream, version, name, data, meta, created) VALUES (?, 0, ?, ?, ?, ?)",
          args: [
            stream,
            event_name,
            JSON.stringify(snapshot ?? {}),
            JSON.stringify(event_meta),
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
            name: event_name,
            data: snapshot ?? {},
            meta: event_meta,
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
        const pii_for_write = await this._stringify_pii_for_write(event.pii);
        const ins = await tx.execute({
          sql: "INSERT INTO events (stream, version, name, data, meta, created, pii) VALUES (?, ?, ?, ?, ?, ?, ?)",
          args: [
            event.stream,
            event.version,
            event.name,
            JSON.stringify(event.data),
            JSON.stringify(event.meta),
            event.created.toISOString(),
            pii_for_write,
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

  /**
   * Wipe the sensitive-data payload for every event on the stream — the
   * physical-erasure side of the sensitive-data epic (#566). Sets
   * `events.pii` to `NULL` for the stream's events; `events.data` and
   * the rest of the row are never touched.
   *
   * Single `UPDATE` under SQLite's writer lock, bounded by events-per-
   * stream. Idempotent — the `pii IS NOT NULL` predicate filters out
   * already-wiped rows so a second call returns `0`.
   *
   * SQLite doesn't auto-reclaim space; freed pages stay in the file
   * until an operator-scheduled `PRAGMA incremental_vacuum` or a full
   * `VACUUM`. The production checklist documents the cadence.
   *
   * @param stream Target stream
   * @returns Count of events whose `pii` was set to `NULL`
   */
  async forget_pii(stream: string): Promise<number> {
    const r = await this.client.execute({
      sql: "UPDATE events SET pii = NULL WHERE stream = ? AND pii IS NOT NULL",
      args: [stream],
    });
    return r.rowsAffected ?? 0;
  }
}
