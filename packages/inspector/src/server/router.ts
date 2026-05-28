import { EventEmitter, on } from "node:events";
import {
  act,
  type Committed,
  CsvFile,
  InMemoryCache,
  InMemoryStore,
  type ScanResult,
  type Schemas,
  type Store,
  type StreamPosition,
} from "@rotorsoft/act";
import { PostgresStore } from "@rotorsoft/act-pg";
import { SqliteStore } from "@rotorsoft/act-sqlite";
import { initTRPC } from "@trpc/server";
import { z } from "zod";
import {
  PG_PORT_RANGE_END,
  PG_PORT_RANGE_START,
  runDiscovery,
} from "./discovery/index.js";

const t = initTRPC.create();

/**
 * Write-mutation gate (#698). Mutating procedures that change adapter
 * state — currently just `prioritize` — refuse to run unless this is
 * explicitly opted into via `ACT_INSPECTOR_WRITE=1`. The legacy
 * `backup` / `restore` mutations predate the gate and aren't covered;
 * they're guarded by their UI flow (explicit click + confirm) rather
 * than by env.
 *
 * Default off keeps the inspector safe to point at production from a
 * laptop. A misclick in the dashboard can no longer reorder live
 * priorities unless an operator has consciously set the env var.
 */
const writeEnabled = process.env.ACT_INSPECTOR_WRITE === "1";

/**
 * In-memory audit log (#698). Records each successful mutation so an
 * operator can answer "who set priority=10 on which streams ten minutes
 * ago?" without persistent storage. Bounded to keep memory usage flat;
 * older entries fall off as new ones land. Cleared on process restart.
 */
type AuditEntry =
  | {
      readonly timestamp: string;
      readonly action: "prioritize";
      readonly filter: Record<string, unknown>;
      readonly priority: number;
      readonly affected: number;
    }
  | {
      readonly timestamp: string;
      readonly action: "restore";
      readonly adapter: AdapterConfig["adapter"];
      readonly result: ScanResult;
    };
const AUDIT_CAPACITY = 100;
const auditLog: AuditEntry[] = [];
const recordAudit = (entry: AuditEntry): void => {
  auditLog.push(entry);
  if (auditLog.length > AUDIT_CAPACITY)
    auditLog.splice(0, auditLog.length - AUDIT_CAPACITY);
};

/** Loosely-typed committed event for inspector queries */
type AnyEvent = Committed<Schemas, string>;

/**
 * Event-version classifier (ACT-403 mirror) — #708.
 *
 * The framework's `internal/event-versions.ts` owns the canonical
 * `_v<digits>` rule. The inspector can't reach into internal, so this
 * is a local copy of the same convention:
 *
 *   `Foo_v<n>` with `n >= 2` is "version n of Foo"; bare `Foo` is
 *   implicit v1; `Foo_v1` is just a literal name. Within a base
 *   group, the highest version is "current", lower versions are
 *   "deprecated", standalone bases (no siblings) are "active".
 *
 * Kept inline so the inspector stays standalone — it queries a PG
 * store directly and never needs to import the running app's
 * registry. The convention is documented in
 * `docs/docs/architecture/event-schema-evolution.md`, so duplicating
 * the rule here doesn't widen any unstable surface.
 */
const VERSION_SUFFIX_RE = /^(.+?)_v(\d+)$/;
type EventStatus = "current" | "deprecated" | "active";
type Classification = {
  status: EventStatus;
  /** Defined when `status === "deprecated"` — points at the highest version. */
  currentVersion: string | null;
};

function classifyEventVersions(
  names: Iterable<string>
): Map<string, Classification> {
  const groups = new Map<string, Array<{ name: string; version: number }>>();
  for (const name of names) {
    const m = name.match(VERSION_SUFFIX_RE);
    const v = m ? Number.parseInt(m[2], 10) : 1;
    const base = m && v >= 2 ? m[1] : name;
    const list = groups.get(base);
    if (list) list.push({ name, version: v });
    else groups.set(base, [{ name, version: v }]);
  }
  const out = new Map<string, Classification>();
  for (const [, list] of groups) {
    if (list.length < 2) {
      // Standalone — "active".
      out.set(list[0].name, { status: "active", currentVersion: null });
      continue;
    }
    list.sort((a, b) => b.version - a.version);
    const current = list[0];
    out.set(current.name, { status: "current", currentVersion: null });
    for (let i = 1; i < list.length; i++) {
      out.set(list[i].name, {
        status: "deprecated",
        currentVersion: current.name,
      });
    }
  }
  return out;
}

/** Collect events into an array */
const collect =
  (target: AnyEvent[]) =>
  (event: AnyEvent): void => {
    target.push(event);
  };

/** Parse optional ISO string to Date */
const toDate = (iso: string | undefined): Date | undefined =>
  iso ? new Date(iso) : undefined;

/**
 * Per-adapter shape of the currently-connected store's configuration.
 *
 * Three members:
 * - `pg` — production path, constructs a `PostgresStore`.
 * - `sqlite` — reserved for #782 (SQLite `connect` branch); not yet
 *   reachable. Kept here so #781/#782 land additively rather than
 *   churning this declaration.
 * - `inmemory` — ephemeral, single-process. Used by ACT-1131's test
 *   suite and by future "demo / playground" affordances in the UI.
 *   No persistent config — every connect builds a fresh empty store.
 *
 * Read-only-after-connect: mutated exclusively by `connect` /
 * `disconnect`.
 */
type PgConfig = {
  adapter: "pg";
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  schema: string;
  table: string;
};

type SqliteConfig = {
  adapter: "sqlite";
  file: string;
  table: string;
};

type InMemoryConfig = {
  adapter: "inmemory";
};

/**
 * CSV-file adapter config (ACT-1128 transfer endpoint). Only the
 * `transfer` mutation uses this — the inspector's `connect` flow
 * doesn't host CSV as a primary store because CSV files don't
 * implement the full `Store` contract (no commit, claim, subscribe,
 * etc.). They're transfer-only endpoints: as source you read with
 * `Store.query`, as target you write with `Store.restore`.
 */
type CsvConfig = {
  adapter: "csv";
  file: string;
};

type AdapterConfig = PgConfig | SqliteConfig | InMemoryConfig;
type TransferConfig = PgConfig | SqliteConfig | CsvConfig;

/** Managed store instance — not the singleton, so we can reconnect */
let currentStore: Store | null = null;
let currentConfig: AdapterConfig | null = null;

/**
 * Build an `EventSource & EventSink`-shaped adapter from a transfer
 * config (ACT-1128 transfer mutation). Hides the per-adapter
 * construction so the transfer endpoint stays a one-liner per side.
 *
 * Adapters returned here are **ephemeral** — the caller is
 * responsible for disposing them after the transfer (or in a
 * `finally`). They are **not** registered with the inspector's
 * `currentStore` slot; the connected store is unaffected.
 *
 * CSV-target callers should pass an already-resolved absolute path
 * — this helper doesn't sandbox or normalize paths. Operator-typed
 * paths arrive here only via the transfer-UI's confirmation flow.
 */
function buildAdapter(config: TransferConfig): Store {
  switch (config.adapter) {
    case "csv":
      // `CsvFile` doesn't satisfy the full `Store` interface (no
      // commit/claim/subscribe — it's transfer-only). The cast is
      // safe because the transfer pipeline only calls `query` and
      // `restore` on the value; the other Store methods are never
      // touched. Documented as part of `CsvFile`'s contract.
      return new CsvFile({ path: config.file }) as unknown as Store;
    case "pg":
      return new PostgresStore({
        host: config.host,
        port: config.port,
        database: config.database,
        user: config.user,
        password: config.password,
        schema: config.schema,
        table: config.table,
      });
    case "sqlite":
      return new SqliteStore({ url: `file:${config.file}` });
  }
}

/**
 * Structural-equality identity check for two transfer configs.
 * Returns `true` when both sides resolve to the same on-disk store
 * — used by `transfer` to refuse no-op or destructive self-copies
 * (e.g. PG → same-PG would wipe the source and try to restore from
 * itself mid-transaction).
 *
 * Different adapter kinds are never equal. Within an adapter:
 * - PG: host/port/database/schema/table all match
 * - SQLite / CSV: same `file` path (no absolute-path normalization;
 *   the typed-name confirmation in the UI catches operator mistakes
 *   before the request reaches here)
 */
function sameAdapter(a: TransferConfig, b: TransferConfig): boolean {
  if (a.adapter !== b.adapter) return false;
  if (a.adapter === "pg" && b.adapter === "pg")
    return (
      a.host === b.host &&
      a.port === b.port &&
      a.database === b.database &&
      a.schema === b.schema &&
      a.table === b.table
    );
  if (a.adapter === "sqlite" && b.adapter === "sqlite")
    return a.file === b.file;
  if (a.adapter === "csv" && b.adapter === "csv") return a.file === b.file;
  return false;
}

/**
 * Restore progress pub-sub (ACT-1128).
 *
 * The `restore` mutation pushes a `{ processed, total? }` event each
 * time `Act.restore`'s `on_progress` fires; the `restoreProgress`
 * subscription is a server-sent-events stream that forwards them to
 * the client. Reactive (no polling), single-emitter (single-user
 * server), framework-aware (we already require Node, so `events.on`
 * with an `AbortSignal` is free).
 *
 * A multi-tenant deployment would need a per-session emitter map
 * keyed by request id; not in scope here.
 */
const restoreProgressEmitter = new EventEmitter();
restoreProgressEmitter.setMaxListeners(0);

/**
 * Test seam — direct read access to the connected store.
 *
 * Tests use this to seed events into the live `InMemoryStore` after a
 * `connect({ adapter: "inmemory" })` call without resorting to `vi.mock`
 * or module-private setters. Not part of the tRPC surface — production
 * callers go through `query` / `query_stats` etc.
 */
export function getActiveStore(): Store | null {
  return currentStore;
}

function getStore(): Store {
  if (!currentStore) throw new Error("Not connected to a store");
  return currentStore;
}

/** Drain all subscription positions from the store via query_streams pagination. */
async function loadAllStreamPositions(): Promise<{
  positions: StreamPosition[];
  maxEventId: number;
}> {
  const s = getStore();
  const pageSize = 1000;
  const fetchPage = async (after?: string) => {
    const page: StreamPosition[] = [];
    const result = await s.query_streams((p) => page.push(p), {
      after,
      limit: pageSize,
    });
    return { page, maxEventId: result.maxEventId };
  };

  const positions: StreamPosition[] = [];
  let { page, maxEventId } = await fetchPage();
  positions.push(...page);
  while (page.length === pageSize) {
    ({ page, maxEventId } = await fetchPage(page[page.length - 1].stream));
    positions.push(...page);
  }
  return { positions, maxEventId };
}

// --- Discovery ---
//
// The inline PG-only block that lived here pre-ACT-1122 has moved to
// `src/server/discovery/`. The router now dispatches to `runDiscovery`
// with a discriminated-union input that picks PG (port scan) or SQLite
// (directory glob) at the call site.

/** CSV column order for backup/restore */
const CSV_COLUMNS = [
  "id",
  "name",
  "data",
  "stream",
  "version",
  "created",
  "meta",
] as const;

/** Escape a value for CSV (RFC 4180) */
function csvEscape(value: string): string {
  if (value.includes('"') || value.includes(",") || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// CSV parsing for restore lives in the framework's `CsvFile` utility
// (libs/act/src/transfer.ts) as of ACT-1128. The inspector's restore
// endpoint constructs `new CsvFile({ blob })` and passes it as the
// source to `app.restore`. The old inline `csvParseLine` /
// `parseCsvRows` here was removed when the framework took over the
// shape; `csvEscape` + `CSV_COLUMNS` stay because the `backup`
// endpoint still emits CSV on its own (store → CSV string for
// download — distinct from the restore-source read path).

export const inspectorRouter = t.router({
  /**
   * Scan for Act event stores.
   *
   * Discriminated input — `{ kind: "pg" }` scans a TCP port range and
   * walks credentials; `{ kind: "sqlite" }` globs a directory for SQLite
   * files and probes each one's schema. The PG variant defaults its
   * `kind` so existing frontend payloads (`{ host, portFrom, portTo }`)
   * keep working unchanged.
   */
  discover: t.procedure
    .input(
      z.union([
        z.object({
          kind: z.literal("pg").default("pg"),
          host: z.string().default("localhost"),
          portFrom: z.number().min(1).max(65535).default(PG_PORT_RANGE_START),
          portTo: z.number().min(1).max(65535).default(PG_PORT_RANGE_END),
        }),
        z.object({
          kind: z.literal("sqlite"),
          dir: z.string().min(1),
          glob: z.string().optional(),
        }),
      ])
    )
    .mutation(async ({ input }) => {
      try {
        const stores = await runDiscovery(input);
        return { ok: true as const, stores };
      } catch (err) {
        throw new Error(
          `Discovery failed: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err }
        );
      }
    }),

  /**
   * Initialize a store connection.
   *
   * The input is a discriminated union over `adapter`:
   * - `pg` (default — backward-compatible with the existing frontend
   *   which doesn't send an `adapter` field) constructs a
   *   `PostgresStore` and verifies the connection with a 1-row probe.
   * - `sqlite` constructs a `SqliteStore` against the given file path.
   *   The file must already be an Act SQLite database (use the SQLite
   *   discovery probe to find candidates); we don't call `.seed()` on
   *   connect so a non-Act file fails the 1-row probe instead of being
   *   silently initialized.
   * - `inmemory` constructs an `InMemoryStore` — ephemeral, single
   *   process, no persistent config. Useful for demo / playground
   *   flows and for ACT-1131's test suite (real adapter, no mocking).
   */
  connect: t.procedure
    .input(
      z.union([
        z.object({
          adapter: z.literal("pg").default("pg"),
          host: z.string().default("localhost"),
          port: z.number().default(5432),
          database: z.string().default("postgres"),
          user: z.string().default("postgres"),
          password: z.string().default("postgres"),
          schema: z.string().default("public"),
          table: z.string().default("events"),
          ssl: z.boolean().default(false),
        }),
        z.object({
          adapter: z.literal("sqlite"),
          file: z.string().min(1),
          table: z.string().default("events"),
        }),
        z.object({
          adapter: z.literal("inmemory"),
        }),
      ])
    )
    .mutation(async ({ input }) => {
      try {
        if (currentStore) {
          await currentStore.dispose();
          currentStore = null;
        }
        if (input.adapter === "inmemory") {
          const newStore = new InMemoryStore();
          await newStore.seed();
          currentStore = newStore;
          currentConfig = { adapter: "inmemory" };
          return {
            ok: true as const,
            config: { adapter: "inmemory" as const },
          };
        }
        if (input.adapter === "sqlite") {
          const newStore = new SqliteStore({ url: `file:${input.file}` });
          // Verify the file is an Act-shaped database — the 1-row
          // probe throws on missing `events` table, which is exactly
          // what we want (a non-Act file fails connect rather than
          // being silently seeded).
          await newStore.query<Schemas>(() => {}, { limit: 1 });
          currentStore = newStore;
          currentConfig = {
            adapter: "sqlite",
            file: input.file,
            table: input.table,
          };
          return {
            ok: true as const,
            config: {
              adapter: "sqlite" as const,
              file: input.file,
              table: input.table,
            },
          };
        }
        const { adapter, ssl, ...pgConfig } = input;
        const storeConfig = ssl
          ? { ...pgConfig, ssl: { rejectUnauthorized: false } }
          : pgConfig;
        const newStore = new PostgresStore(storeConfig);
        // Test the connection
        await newStore.query<Schemas>(() => {}, { limit: 1 });
        currentStore = newStore;
        currentConfig = { adapter: "pg", ...pgConfig };
        return {
          ok: true as const,
          config: { adapter, ...pgConfig, ssl, password: "***" },
        };
      } catch (err) {
        currentStore = null;
        currentConfig = null;
        throw new Error(
          `Connection failed: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err }
        );
      }
    }),

  /** Disconnect from current store */
  disconnect: t.procedure.mutation(async () => {
    if (currentStore) {
      await currentStore.dispose();
      currentStore = null;
      currentConfig = null;
    }
    return { ok: true as const };
  }),

  /**
   * Check connection status.
   *
   * `adapter` is the kind of currently-connected store (null when not
   * connected). `target` is the connected store's discriminator — the
   * database name for PG, the file path for SQLite, `"memory"` for
   * the ephemeral InMemory adapter — used by the restore UI as the
   * typed-name gate on destructive operations (ACT-1128).
   */
  status: t.procedure.query(() => {
    const target = ((): string | null => {
      if (!currentConfig) return null;
      if (currentConfig.adapter === "pg") return currentConfig.database;
      if (currentConfig.adapter === "sqlite") return currentConfig.file;
      return "memory";
    })();
    return {
      connected: currentStore !== null,
      adapter: currentConfig?.adapter ?? null,
      target,
    };
  }),

  /** Query events using the Store interface */
  query: t.procedure
    .input(
      z.object({
        stream: z.string().optional(),
        names: z.string().array().optional(),
        before: z.number().optional(),
        after: z.number().optional(),
        limit: z.number().min(1).max(500).default(50),
        created_before: z.string().optional(),
        created_after: z.string().optional(),
        backward: z.boolean().optional(),
        correlation: z.string().optional(),
      })
    )
    .query(async ({ input }) => {
      const s = getStore();

      const events: AnyEvent[] = [];
      await s.query<Schemas>(collect(events), {
        ...input,
        created_before: toDate(input.created_before),
        created_after: toDate(input.created_after),
        with_snaps: true,
      });

      return { events };
    }),

  /** Get aggregate stats for current filters */
  stats: t.procedure
    .input(
      z.object({
        stream: z.string().optional(),
        names: z.string().array().optional(),
        created_before: z.string().optional(),
        created_after: z.string().optional(),
        correlation: z.string().optional(),
      })
    )
    .query(async ({ input }) => {
      const s = getStore();

      const events: AnyEvent[] = [];
      await s.query<Schemas>(collect(events), {
        ...input,
        created_before: toDate(input.created_before),
        created_after: toDate(input.created_after),
        with_snaps: true,
      });

      const streams = new Set<string>();
      const names = new Set<string>();
      let minTime: Date | undefined;
      let maxTime: Date | undefined;

      for (const e of events) {
        streams.add(e.stream);
        names.add(String(e.name));
        const created =
          e.created instanceof Date ? e.created : new Date(String(e.created));
        if (!minTime || created < minTime) minTime = created;
        if (!maxTime || created > maxTime) maxTime = created;
      }

      return {
        totalEvents: events.length,
        uniqueStreams: streams.size,
        uniqueEventNames: names.size,
        timeSpan:
          minTime && maxTime
            ? { from: minTime.toISOString(), to: maxTime.toISOString() }
            : null,
      };
    }),

  /** Get distinct event names for filter dropdown */
  eventNames: t.procedure.query(async () => {
    const s = getStore();

    const events: AnyEvent[] = [];
    await s.query<Schemas>(collect(events), { with_snaps: true });

    const names = new Set<string>();
    for (const e of events) names.add(String(e.name));
    return [...names].sort();
  }),

  /** Get distinct stream names with per-stream metadata for the streams view.
   *
   * Backed by `Store.query_stats` (ACT-639): one round trip per adapter,
   * returns per-stream aggregates instead of streaming every event row over
   * the wire. For a store with 1M events / 10K streams this is ~100×
   * less data transferred than the previous full-event-scan path.
   *
   * `names: true` is requested so the response also includes a per-stream
   * event-name → count map, surfaced as `nameCounts` for future UI uses
   * (schema-evolution view, drill-through to legacy-event filters).
   * Sorting + limit stay client-side (the DB returns all matched streams).
   */
  streams: t.procedure
    .input(
      z
        .object({
          limit: z.number().min(1).max(1000).default(100),
        })
        .optional()
    )
    .query(async ({ input }) => {
      const s = getStore();
      const stats = await s.query_stats<Schemas>(
        {},
        { count: true, names: true, tail: true }
      );
      return [...stats.entries()]
        .map(([stream, { head, tail, count, names }]) => ({
          stream,
          eventCount: count ?? 0,
          lastEvent: String(head.created),
          // Earliest event id + created (ACT-639 tail opt-in). Lets the
          // Streams view render an "age" column and filter for stale
          // streams that haven't committed in N days. `tail` is always
          // present in this response because the query requested it.
          firstEvent: tail ? String(tail.created) : null,
          currentVersion: head.version,
          isClosed: head.name === "__tombstone__",
          nameCounts: names ?? {},
        }))
        .sort((a, b) => b.eventCount - a.eventCount)
        .slice(0, input?.limit ?? 100);
    }),

  /**
   * Full per-stream stats for the detail panel (#698). Fetched on
   * demand when the operator opens a stream in the Streams view —
   * cheaper than including head + tail Committed bodies in the
   * page-wide `streams` query, which would 100× the payload for the
   * common "scan the list" case.
   *
   * Returns the head + tail Committed events (id, name, version,
   * created) plus the per-stream event-name → count map and the
   * total event count.
   */
  streamStats: t.procedure
    .input(
      z.object({
        stream: z.string().min(1),
        // Time-travel: include only events with `id < before` in the
        // aggregation (#708 slice 5). Lets the detail panel answer
        // "what did this stream look like before event N?". Default
        // (omitted) returns live stats — the full stream.
        before: z.number().int().positive().optional(),
      })
    )
    .query(async ({ input }) => {
      const s = getStore();
      const stats = await s.query_stats<Schemas>([input.stream], {
        count: true,
        names: true,
        tail: true,
        before: input.before,
      });
      const entry = stats.get(input.stream);
      if (!entry) return null;
      const { head, tail, count, names } = entry;
      const project = (e: typeof head | undefined) =>
        e
          ? {
              id: e.id,
              name: String(e.name),
              version: e.version,
              created: String(e.created),
            }
          : null;
      return {
        head: project(head)!,
        // `tail` is opt-in on the query; query_stats({tail:true}) yields
        // it for every stream, but defensively guard for the empty case.
        tail: project(tail),
        eventCount: count ?? 0,
        nameCounts: names ?? {},
        // Echoed back so the UI doesn't have to thread state through
        // its own cache key — `null` means "live, no time-travel".
        asOf: input.before ?? null,
      };
    }),

  /**
   * Workspace event-name rollup with deprecation status (#708).
   *
   * Aggregates per-stream event-name counts from
   * `query_stats({}, {names: true})` into a single workspace-wide
   * histogram, then applies the framework's `_v<digits>` deprecation
   * rule (ACT-403) to label each name as `current` / `deprecated` /
   * `active`. Returns one row per distinct event name, sorted with
   * deprecated rows first (operator's main concern) then by count
   * descending.
   *
   * Lazy-loaded — the Schema Evolution view opens this on demand,
   * not on every page load. `query_stats({}, …)` is a single round
   * trip on durable adapters (`SELECT … GROUP BY stream` with a CTE
   * aggregation), so the cost scales with the events table size
   * rather than fetching every row over the wire.
   */
  schemaEvolution: t.procedure.query(async () => {
    const s = getStore();
    const stats = await s.query_stats<Schemas>({}, { names: true });
    const totals = new Map<string, number>();
    for (const { names } of stats.values()) {
      for (const [name, n] of Object.entries(names ?? {})) {
        totals.set(name, (totals.get(name) ?? 0) + (n ?? 0));
      }
    }
    const classification = classifyEventVersions(totals.keys());
    return {
      events: [...totals.entries()]
        .map(([name, count]) => ({
          name,
          count,
          ...(classification.get(name) ?? {
            status: "active" as EventStatus,
            currentVersion: null,
          }),
        }))
        .sort((a, b) => {
          // Deprecated first — that's the migration backlog operators
          // want to see at a glance. Within each status, sort by count
          // desc so the heaviest tables surface first.
          if (a.status !== b.status) {
            if (a.status === "deprecated") return -1;
            if (b.status === "deprecated") return 1;
          }
          return b.count - a.count;
        }),
      // Headline totals — render above the table so an operator can
      // see "of the 5.2M total events, 4.2M are deprecated" at a
      // glance without summing rows mentally.
      summary: {
        totalEvents: [...totals.values()].reduce((s, n) => s + n, 0),
        deprecatedEvents: [...totals.entries()]
          .filter(([n]) => classification.get(n)?.status === "deprecated")
          .reduce((s, [, n]) => s + n, 0),
        distinctNames: totals.size,
        deprecatedNames: [...classification.values()].filter(
          (c) => c.status === "deprecated"
        ).length,
      },
    };
  }),

  /**
   * Drill-through query: streams that still hold a given event name
   * (#708). Used by the Schema Evolution view's modal — operator
   * clicks a deprecated event row, sees every stream where
   * `nameCounts[name] > 0`, sorted by per-stream count descending.
   *
   * The inspector itself doesn't close streams (no Act orchestrator
   * available); the modal surfaces the list + a "copy stream names"
   * affordance so the operator can run `app.close([...])` from their
   * application. Pure read surface — gated only by `getStore()`.
   *
   * Joins `query_stats({}, {names: true})` (events table aggregation)
   * with `loadAllStreamPositions` (streams table) so each row carries
   * the lane + priority operators care about when deciding what to
   * close.
   */
  streamsForEvent: t.procedure
    .input(z.object({ name: z.string().min(1) }))
    .query(async ({ input }) => {
      const s = getStore();
      const [stats, { positions }] = await Promise.all([
        s.query_stats<Schemas>({}, { count: true, names: true }),
        loadAllStreamPositions().catch(() => ({ positions: [] })),
      ]);
      const metaByStream = new Map(
        positions.map((p) => [
          p.stream,
          { lane: p.lane ?? null, priority: p.priority },
        ])
      );
      const rows: Array<{
        stream: string;
        eventCount: number;
        totalEvents: number;
        lane: string | null;
        priority: number;
      }> = [];
      let totalAcrossStreams = 0;
      for (const [stream, { count, names }] of stats.entries()) {
        const eventCount = names?.[input.name] ?? 0;
        if (eventCount === 0) continue;
        totalAcrossStreams += eventCount;
        const meta = metaByStream.get(stream);
        rows.push({
          stream,
          eventCount,
          totalEvents: count ?? 0,
          lane: meta?.lane ?? null,
          priority: meta?.priority ?? 0,
        });
      }
      rows.sort((a, b) => b.eventCount - a.eventCount);
      return {
        event: input.name,
        streams: rows,
        totalEventsOfName: totalAcrossStreams,
      };
    }),

  /** Get stream processing metadata from the streams table */
  streamMeta: t.procedure.query(async () => {
    try {
      const { positions } = await loadAllStreamPositions();
      return positions.map((p) => ({
        stream: p.stream,
        source: p.source ?? null,
        at: p.at,
        retry: p.retry,
        blocked: p.blocked,
        error: p.error || null,
        priority: p.priority,
        // ACT-1103: drain lane the stream is bound to. `undefined`
        // (the implicit "default" lane) surfaces as null for the UI;
        // the Streams view dims it so non-default lanes pop.
        lane: p.lane ?? null,
        leased_by: p.leased_by ?? null,
        leased_until: p.leased_until?.toISOString() ?? null,
      }));
    } catch {
      return [];
    }
  }),

  /** Get drain status: aggregate health + blocked streams + leases + watermark histogram */
  drainStatus: t.procedure.query(async () => {
    try {
      const { positions, maxEventId: rawMax } = await loadAllStreamPositions();
      const maxEventId = Math.max(0, rawMax);
      const now = new Date();

      // Aggregates
      let healthy = 0;
      let blocked = 0;
      let leased = 0;
      let lagging = 0;
      const blockedStreams: Array<{
        stream: string;
        source: string | null;
        error: string | null;
        retry: number;
        at: number;
        gap: number;
        priority: number;
        lane: string | null;
      }> = [];
      const activeLeases: Array<{
        stream: string;
        source: string | null;
        leased_by: string;
        leased_until: string;
        priority: number;
        lane: string | null;
      }> = [];
      const gaps: number[] = [];
      // Streams per priority lane — operators want a quick read of
      // "how many things are at priority > 0 right now."
      const priorityCounts = new Map<number, number>();
      // Streams per drain lane (ACT-1103). `undefined`/`"default"`
      // normalize to `"default"` so the histogram bucket renders one
      // consistent label.
      const laneCounts = new Map<string, number>();

      for (const p of positions) {
        const gap = Math.max(0, maxEventId - p.at);
        gaps.push(gap);
        priorityCounts.set(
          p.priority,
          (priorityCounts.get(p.priority) ?? 0) + 1
        );
        const laneKey = p.lane ?? "default";
        laneCounts.set(laneKey, (laneCounts.get(laneKey) ?? 0) + 1);

        if (p.blocked) {
          blocked++;
          blockedStreams.push({
            stream: p.stream,
            source: p.source ?? null,
            error: p.error || null,
            retry: p.retry,
            at: p.at,
            gap,
            priority: p.priority,
            lane: p.lane ?? null,
          });
        } else if (p.leased_by && p.leased_until && p.leased_until > now) {
          leased++;
          activeLeases.push({
            stream: p.stream,
            source: p.source ?? null,
            leased_by: p.leased_by,
            leased_until: p.leased_until.toISOString(),
            priority: p.priority,
            lane: p.lane ?? null,
          });
        } else if (gap > 10) {
          lagging++;
        } else {
          healthy++;
        }
      }

      // Watermark histogram
      const buckets = [
        { label: "0", min: 0, max: 0, count: 0 },
        { label: "1-10", min: 1, max: 10, count: 0 },
        { label: "11-50", min: 11, max: 50, count: 0 },
        { label: "51-100", min: 51, max: 100, count: 0 },
        { label: "100+", min: 101, max: Infinity, count: 0 },
      ];
      for (const gap of gaps) {
        for (const b of buckets) {
          if (gap >= b.min && gap <= b.max) {
            b.count++;
            break;
          }
        }
      }

      return {
        total: positions.length,
        healthy,
        blocked,
        leased,
        lagging,
        maxEventId,
        blockedStreams: blockedStreams.sort((a, b) => b.gap - a.gap),
        activeLeases,
        histogram: buckets,
        // Sorted highest-priority first so a UI can spot non-default
        // lanes at a glance.
        priorityCounts: [...priorityCounts.entries()]
          .sort((a, b) => b[0] - a[0])
          .map(([priority, count]) => ({ priority, count })),
        // Sorted by count desc so the busiest lane is the first chip.
        // Default lane sorts naturally alongside others — operators can
        // see "30 streams on writes, 5 on default" at a glance.
        laneCounts: [...laneCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([lane, count]) => ({ lane, count })),
        timestamp: new Date().toISOString(),
      };
    } catch {
      return {
        total: 0,
        healthy: 0,
        blocked: 0,
        leased: 0,
        lagging: 0,
        maxEventId: 0,
        blockedStreams: [],
        activeLeases: [],
        histogram: [],
        priorityCounts: [],
        laneCounts: [],
        timestamp: new Date().toISOString(),
      };
    }
  }),

  /** Export events as CSV rows */
  backup: t.procedure
    .input(
      z.object({
        stream: z.string().optional(),
        names: z.string().array().optional(),
        created_before: z.string().optional(),
        created_after: z.string().optional(),
        correlation: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const s = getStore();
      const events: AnyEvent[] = [];
      await s.query<Schemas>(collect(events), {
        ...input,
        created_before: toDate(input.created_before),
        created_after: toDate(input.created_after),
        with_snaps: true,
      });

      // Build CSV
      const header = CSV_COLUMNS.join(",");
      const rows = events.map((e) =>
        CSV_COLUMNS.map((col) => {
          const val = e[col];
          if (col === "data" || col === "meta")
            return csvEscape(JSON.stringify(val));
          if (val instanceof Date) return csvEscape(val.toISOString());
          return csvEscape(
            typeof val === "object" && val !== null
              ? JSON.stringify(val)
              : String(val)
          );
        }).join(",")
      );

      return { csv: [header, ...rows].join("\n"), count: events.length };
    }),

  /**
   * Inspector write-mode status (#698). Tells the UI whether mutation
   * controls should render. Read-only by default; flipped on via the
   * `ACT_INSPECTOR_WRITE=1` env var at server start. The flag is
   * server-static — the UI doesn't get to toggle it, so refresh of a
   * tab can't recover write access that the operator hasn't already
   * granted to the process.
   */
  writeMode: t.procedure.query(() => ({
    enabled: writeEnabled,
    reason: writeEnabled
      ? null
      : "Set ACT_INSPECTOR_WRITE=1 on the inspector server to enable mutations.",
  })),

  /**
   * Bulk-update the scheduling priority of streams matching a filter
   * (#698 / ACT-102). Wraps `Store.prioritize`. Filter shape mirrors
   * `query_streams` so the UI can preview affected counts via the
   * existing query before committing the mutation.
   *
   * Single-stream edits set `stream` + `stream_exact: true`; bulk
   * updates use regex with optional source / blocked / lane scoping.
   * Refuses to run when {@link writeEnabled} is false.
   */
  prioritize: t.procedure
    .input(
      z.object({
        priority: z.number().int(),
        filter: z
          .object({
            stream: z.string().optional(),
            stream_exact: z.boolean().optional(),
            source: z.string().optional(),
            source_exact: z.boolean().optional(),
            blocked: z.boolean().optional(),
            lane: z.string().optional(),
          })
          .default({}),
      })
    )
    .mutation(async ({ input }) => {
      if (!writeEnabled)
        throw new Error(
          "Inspector is in read-only mode. Set ACT_INSPECTOR_WRITE=1 on the server."
        );
      const s = getStore();
      const affected = await s.prioritize(input.filter, input.priority);
      recordAudit({
        timestamp: new Date().toISOString(),
        action: "prioritize",
        filter: input.filter,
        priority: input.priority,
        affected,
      });
      return { ok: true as const, affected };
    }),

  /** Last 100 mutations performed via the inspector (#698). */
  audit: t.procedure.query(() => ({
    entries: [...auditLog].reverse(),
    capacity: AUDIT_CAPACITY,
  })),

  /**
   * Restore events from a CSV blob via `Store.restore`.
   *
   * Pre-ACT-1127 this opened a raw `pg.Client` and ran TRUNCATE +
   * INSERT against PG only. Now it streams the CSV into the active
   * adapter's port-level restore, so every adapter that declares
   * the `restore` capability (today: InMemory, PG, SQLite) is
   * supported. The adapter handles atomicity, id-renumbering, and
   * causation-remap; the inspector just streams rows and records
   * the result in its audit log.
   *
   * Return shape carries both `count` (back-compat with pre-1127
   * callers) and the full `ScanResult` (for #787's UI to render
   * `duration_ms`, `dropped` counters, etc.).
   */
  restore: t.procedure
    .input(
      z.object({
        csv: z.string(),
        dry_run: z.boolean().optional(),
        drop_snapshots: z.boolean().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const s = getStore();
      // Dry-run skips the store contract entirely (no transaction, no
      // capability check). Only the live path requires `Store.restore`.
      if (!input.dry_run && !s.restore)
        throw new Error(
          "Active adapter does not support restore — see ACT-1124 for the capability contract"
        );
      // ACT-1128 — `on_progress` events stream out to the client via
      // the `restoreProgress` subscription. Reactive: subscribers
      // receive one event per `Act.restore` `on_progress` tick.
      try {
        // Build an empty scoped Act around the connected store so we
        // can go through the orchestrator's public `Act.restore` path.
        // No state/slice registration is needed — restore is
        // type-erased and the Act exists purely to host the scan loop.
        const cache = new InMemoryCache();
        const app = act().build({ scoped: { store: s, cache } });
        const source = new CsvFile({ blob: input.csv });
        const result = await app.restore(source, {
          dry_run: input.dry_run,
          drop_snapshots: input.drop_snapshots,
          on_progress: (p) => {
            restoreProgressEmitter.emit("progress", p);
          },
        });
        await cache.dispose();
        // Only the destructive path leaves an operational trace —
        // dry-runs are diagnostic and shouldn't pollute the audit log.
        if (!input.dry_run)
          recordAudit({
            timestamp: new Date().toISOString(),
            action: "restore",
            adapter: currentConfig!.adapter,
            result,
          });
        return { ok: true as const, count: result.kept, result };
      } catch (error) {
        throw new Error(
          `Restore failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      }
    }),

  /**
   * Server-sent stream of restore progress events (ACT-1128).
   *
   * Each `Act.restore` `on_progress` tick on the server pushes one
   * `{ processed, total? }` event to every active subscriber. The
   * client opens this subscription before kicking off the `restore`
   * mutation and renders the running `processed` count on a
   * progress bar; closing the connection cancels via `AbortSignal`
   * which detaches the listener cleanly.
   *
   * Both `restore` (CSV → connected store) and `transfer` (any →
   * any) wire their `on_progress` to the same emitter, so the
   * client uses one subscription regardless of which mutation
   * fired.
   */
  restoreProgress: t.procedure.subscription(async function* (opts) {
    for await (const [event] of on(restoreProgressEmitter, "progress", {
      signal: opts.signal,
    })) {
      yield event as { processed: number; total?: number };
    }
  }),

  /**
   * Cross-source / cross-target transfer (ACT-1128 + #788). Reads
   * events from `source` via `EventSource.query`, writes them
   * atomically into `target` via `EventSink.restore`. Source and
   * target are independent adapters — neither has to be the
   * inspector's connected store. Useful flows:
   *
   *   - PG → SQLite migration (and vice versa)
   *   - Store → CSV-on-disk backup
   *   - CSV-on-disk → Store rebuild from external dump
   *
   * Both ends are built ephemerally from the input configs and
   * disposed in a `finally`. The `currentStore` slot is untouched
   * so the operator can keep their inspector session pointing at a
   * third adapter while a transfer runs.
   *
   * Rejects:
   *   - source-config equals target-config (deep structural match
   *     on the discriminating fields) — would wipe the source
   *   - target adapter has no `restore` capability — the cast on
   *     `buildAdapter` for non-CSV adapters succeeds; this catches
   *     the rare case where someone wires a Store that omitted the
   *     optional `restore` method
   *
   * Progress events fan out through the same `restoreProgress`
   * subscription used by `restore`.
   */
  transfer: t.procedure
    .input(
      z.object({
        source: z.union([
          z.object({
            adapter: z.literal("pg"),
            host: z.string(),
            port: z.number(),
            database: z.string(),
            user: z.string(),
            password: z.string(),
            schema: z.string(),
            table: z.string(),
          }),
          z.object({
            adapter: z.literal("sqlite"),
            file: z.string().min(1),
            table: z.string().default("events"),
          }),
          z.object({
            adapter: z.literal("csv"),
            file: z.string().min(1),
          }),
        ]),
        target: z.union([
          z.object({
            adapter: z.literal("pg"),
            host: z.string(),
            port: z.number(),
            database: z.string(),
            user: z.string(),
            password: z.string(),
            schema: z.string(),
            table: z.string(),
          }),
          z.object({
            adapter: z.literal("sqlite"),
            file: z.string().min(1),
            table: z.string().default("events"),
          }),
          z.object({
            adapter: z.literal("csv"),
            file: z.string().min(1),
          }),
        ]),
        dry_run: z.boolean().optional(),
        drop_snapshots: z.boolean().optional(),
      })
    )
    .mutation(async ({ input }) => {
      if (sameAdapter(input.source, input.target))
        throw new Error(
          "Transfer source and target refer to the same store — refusing to self-overwrite"
        );
      const source = buildAdapter(input.source);
      const target = buildAdapter(input.target);
      // EventSink narrowing — every adapter we construct here
      // implements `restore`, but the type's optional `restore?`
      // forces an explicit guard. CsvFile guarantees it; the two
      // Store adapters declare it as optional but always ship it
      // in this codebase.
      if (!target.restore)
        throw new Error(
          `Target adapter '${input.target.adapter}' has no restore capability`
        );
      // Build a transfer-only Act with no scoped store — the source
      // and sink are passed explicitly so `Act.restore` never falls
      // back to the singleton.
      const app = act().build();
      try {
        const result = await app.restore(
          source,
          {
            dry_run: input.dry_run,
            drop_snapshots: input.drop_snapshots,
            on_progress: (p) => {
              restoreProgressEmitter.emit("progress", p);
            },
          },
          target as Parameters<typeof app.restore>[2]
        );
        if (!input.dry_run)
          recordAudit({
            timestamp: new Date().toISOString(),
            action: "restore",
            adapter: currentConfig?.adapter ?? "inmemory",
            result,
          });
        return { ok: true as const, count: result.kept, result };
      } catch (error) {
        throw new Error(
          `Transfer failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      } finally {
        await source.dispose();
        await target.dispose();
      }
    }),
});

export type InspectorRouter = typeof inspectorRouter;
