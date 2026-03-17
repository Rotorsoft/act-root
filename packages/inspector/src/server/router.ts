import type { Committed, Schemas, Store } from "@rotorsoft/act";
import { PostgresStore } from "@rotorsoft/act-pg";
import { initTRPC } from "@trpc/server";
import { createConnection, type Socket } from "net";
import pg from "pg";
import { z } from "zod";

const t = initTRPC.create();

/** Loosely-typed committed event for inspector queries */
type AnyEvent = Committed<Schemas, string>;

/** Collect events into an array */
const collect =
  (target: AnyEvent[]) =>
  (event: AnyEvent): void => {
    target.push(event);
  };

/** Parse optional ISO string to Date */
const toDate = (iso: string | undefined): Date | undefined =>
  iso ? new Date(iso) : undefined;

/** Managed store instance — not the singleton, so we can reconnect */
let currentStore: Store | null = null;
let currentConfig: {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  schema: string;
  table: string;
} | null = null;

function getStore(): Store {
  if (!currentStore) throw new Error("Not connected to a store");
  return currentStore;
}

/** Get a raw pg client for streams table queries */
async function getStreamsClient(): Promise<{ client: pg.Client; fqs: string }> {
  if (!currentConfig) throw new Error("Not connected to a store");
  const client = new pg.Client({
    host: currentConfig.host,
    port: currentConfig.port,
    database: currentConfig.database,
    user: currentConfig.user,
    password: currentConfig.password,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  const fqs = `"${currentConfig.schema}"."${currentConfig.table}_streams"`;
  return { client, fqs };
}

// --- Discovery ---

/** PG port range to scan: 5430–5480 */
const PORT_RANGE_START = 5430;
const PORT_RANGE_END = 5480;

/** Common credential combos to try */
const COMMON_CREDS = [
  { user: "postgres", password: "postgres" },
  { user: "postgres", password: "" },
  { user: "postgres", password: "password" },
  { user: "root", password: "root" },
  { user: "admin", password: "admin" },
];

/** One discovered store per port — the best candidate */
type DiscoveredStore = {
  host: string;
  port: number;
  user: string;
  database: string;
  schema: string;
  table: string;
  eventCount: number;
};

/** Check if a TCP port is open */
function probePort(
  host: string,
  port: number,
  timeoutMs = 500
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket: Socket = createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.on("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/** Try to authenticate with a PG server using given credentials */
async function tryConnect(
  host: string,
  port: number,
  user: string,
  password: string
): Promise<pg.Client | null> {
  const client = new pg.Client({
    host,
    port,
    user,
    password,
    database: "postgres",
    connectionTimeoutMillis: 2000,
  });
  try {
    await client.connect();
    return client;
  } catch {
    return null;
  }
}

/** Find the best Act event table per schema in a database (non-empty) */
async function findEventTables(
  config: { host: string; port: number; user: string; password: string },
  dbName: string
): Promise<{ schema: string; table: string; count: number }[]> {
  const client = new pg.Client({
    ...config,
    database: dbName,
    connectionTimeoutMillis: 2000,
  });
  try {
    await client.connect();
    // Find all Act-shaped tables, one best per schema
    const result = await client.query<{
      table_schema: string;
      table_name: string;
      row_estimate: string;
    }>(
      `SELECT DISTINCT ON (t.table_schema)
              t.table_schema, t.table_name,
              (SELECT reltuples::bigint FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = t.table_schema AND c.relname = t.table_name) AS row_estimate
       FROM information_schema.tables t
       WHERE t.table_type = 'BASE TABLE'
         AND t.table_schema NOT IN ('pg_catalog', 'information_schema')
         AND EXISTS (SELECT 1 FROM information_schema.columns c
           WHERE c.table_schema = t.table_schema AND c.table_name = t.table_name AND c.column_name = 'stream')
         AND EXISTS (SELECT 1 FROM information_schema.columns c
           WHERE c.table_schema = t.table_schema AND c.table_name = t.table_name AND c.column_name = 'meta')
         AND EXISTS (SELECT 1 FROM information_schema.columns c
           WHERE c.table_schema = t.table_schema AND c.table_name = t.table_name AND c.column_name = 'version')
       ORDER BY t.table_schema,
         (t.table_name = 'events') DESC,
         row_estimate DESC NULLS LAST`
    );

    // Filter out truly empty tables — reltuples can be -1 (no stats) or 0
    const tables: { schema: string; table: string; count: number }[] = [];
    for (const r of result.rows) {
      const estimate = Number(r.row_estimate);
      if (estimate > 0) {
        tables.push({
          schema: r.table_schema,
          table: r.table_name,
          count: estimate,
        });
      } else {
        // Stats not gathered or zero — check for actual rows
        const check = await client.query(
          `SELECT EXISTS (SELECT 1 FROM "${r.table_schema}"."${r.table_name}" LIMIT 1) AS has_rows`
        );
        if (check.rows[0]?.has_rows) {
          tables.push({
            schema: r.table_schema,
            table: r.table_name,
            count: 0,
          });
        }
      }
    }
    return tables;
  } catch {
    return [];
  } finally {
    await client.end();
  }
}

/** Full discovery: scan ports, try credentials, pick best Act store per port */
async function discover(
  host: string,
  portFrom: number,
  portTo: number
): Promise<DiscoveredStore[]> {
  // 1. Scan port range in parallel
  const ports = Array.from(
    { length: portTo - portFrom + 1 },
    (_, i) => portFrom + i
  );
  const portResults = await Promise.all(
    ports.map(async (port) => ({ port, open: await probePort(host, port) }))
  );
  const openPorts = portResults.filter((r) => r.open).map((r) => r.port);

  if (openPorts.length === 0) return [];

  // 2. For each open port, try credential combos and find best table
  const stores: DiscoveredStore[] = [];

  for (const port of openPorts) {
    for (const creds of COMMON_CREDS) {
      const client = await tryConnect(host, port, creds.user, creds.password);
      if (!client) continue;

      try {
        const dbResult = await client.query<{ datname: string }>(
          `SELECT datname FROM pg_database
           WHERE datistemplate = false AND datallowconn = true
           ORDER BY datname`
        );

        // Find best table per schema across all databases on this port
        for (const row of dbResult.rows) {
          const tables = await findEventTables(
            { host, port, user: creds.user, password: creds.password },
            row.datname
          );
          for (const t of tables) {
            stores.push({
              host,
              port,
              user: creds.user,
              database: row.datname,
              schema: t.schema,
              table: t.table,
              eventCount: t.count,
            });
          }
        }
      } finally {
        await client.end();
      }

      // Found working creds for this port, move to next port
      break;
    }
  }

  return stores;
}

export const inspectorRouter = t.router({
  /** Scan host for PG servers and discover Act event stores */
  discover: t.procedure
    .input(
      z.object({
        host: z.string().default("localhost"),
        portFrom: z.number().min(1).max(65535).default(PORT_RANGE_START),
        portTo: z.number().min(1).max(65535).default(PORT_RANGE_END),
      })
    )
    .mutation(async ({ input }) => {
      try {
        const stores = await discover(input.host, input.portFrom, input.portTo);
        return { ok: true as const, stores };
      } catch (err) {
        throw new Error(
          `Discovery failed: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err }
        );
      }
    }),

  /** Initialize a PostgresStore connection */
  connect: t.procedure
    .input(
      z.object({
        host: z.string().default("localhost"),
        port: z.number().default(5432),
        database: z.string().default("postgres"),
        user: z.string().default("postgres"),
        password: z.string().default("postgres"),
        schema: z.string().default("public"),
        table: z.string().default("events"),
      })
    )
    .mutation(async ({ input }) => {
      try {
        if (currentStore) {
          await currentStore.dispose();
          currentStore = null;
        }
        const newStore = new PostgresStore(input);
        // Test the connection
        await newStore.query<Schemas>(() => {}, { limit: 1 });
        currentStore = newStore;
        currentConfig = input;
        return { ok: true as const, config: { ...input, password: "***" } };
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

  /** Check connection status */
  status: t.procedure.query(() => ({ connected: currentStore !== null })),

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

  /** Get distinct stream names for filter suggestions */
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

      const events: AnyEvent[] = [];
      await s.query<Schemas>(collect(events), { with_snaps: true });

      const streamMap = new Map<
        string,
        { count: number; lastEvent: string; lastVersion: number }
      >();

      for (const e of events) {
        const existing = streamMap.get(e.stream);
        if (!existing || e.version > existing.lastVersion) {
          streamMap.set(e.stream, {
            count: (existing?.count ?? 0) + 1,
            lastEvent: String(e.created),
            lastVersion: e.version,
          });
        } else {
          existing.count++;
        }
      }

      return [...streamMap.entries()]
        .map(([stream, info]) => ({
          stream,
          eventCount: info.count,
          lastEvent: info.lastEvent,
          currentVersion: info.lastVersion,
        }))
        .sort((a, b) => b.eventCount - a.eventCount)
        .slice(0, input?.limit ?? 100);
    }),

  /** Get stream processing metadata from the streams table (PG-specific) */
  streamMeta: t.procedure.query(async () => {
    let pgClient: pg.Client | undefined;
    try {
      const { client, fqs } = await getStreamsClient();
      pgClient = client;
      const result = await client.query<{
        stream: string;
        source: string | null;
        at: number;
        retry: number;
        blocked: boolean;
        error: string | null;
        leased_at: number | null;
        leased_by: string | null;
        leased_until: string | null;
      }>(
        `SELECT stream, source, at, retry, blocked, error, leased_at, leased_by, leased_until FROM ${fqs} ORDER BY stream`
      );
      return result.rows;
    } catch {
      return [];
    } finally {
      if (pgClient) await pgClient.end();
    }
  }),

  /** Get drain status: aggregate health + blocked streams + leases + watermark histogram */
  drainStatus: t.procedure.query(async () => {
    const s = getStore();
    let pgClient: pg.Client | undefined;
    try {
      const { client, fqs } = await getStreamsClient();
      pgClient = client;

      // Get max event ID
      const events: AnyEvent[] = [];
      await s.query<Schemas>(collect(events), {
        limit: 1,
        backward: true,
        with_snaps: true,
      });
      const maxEventId = events.length > 0 ? events[0].id : 0;

      // Get all stream rows
      const result = await client.query<{
        stream: string;
        source: string | null;
        at: number;
        retry: number;
        blocked: boolean;
        error: string | null;
        leased_at: number | null;
        leased_by: string | null;
        leased_until: string | null;
      }>(
        `SELECT stream, source, at, retry, blocked, error, leased_at, leased_by, leased_until FROM ${fqs} ORDER BY stream`
      );

      const rows = result.rows;
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
      }> = [];
      const activeLeases: Array<{
        stream: string;
        source: string | null;
        leased_by: string;
        leased_at: number;
        leased_until: string;
      }> = [];
      const gaps: number[] = [];

      for (const r of rows) {
        const gap = Math.max(0, maxEventId - r.at);
        gaps.push(gap);

        if (r.blocked) {
          blocked++;
          blockedStreams.push({
            stream: r.stream,
            source: r.source,
            error: r.error,
            retry: r.retry,
            at: r.at,
            gap,
          });
        } else if (
          r.leased_by &&
          r.leased_until &&
          new Date(r.leased_until) > now
        ) {
          leased++;
          activeLeases.push({
            stream: r.stream,
            source: r.source,
            leased_by: r.leased_by,
            leased_at: r.leased_at ?? 0,
            leased_until: r.leased_until,
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
        total: rows.length,
        healthy,
        blocked,
        leased,
        lagging,
        maxEventId,
        blockedStreams: blockedStreams.sort((a, b) => b.gap - a.gap),
        activeLeases,
        histogram: buckets,
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
        timestamp: new Date().toISOString(),
      };
    } finally {
      if (pgClient) await pgClient.end();
    }
  }),

  /** Generate Act code from natural language prompt using Claude API */
  generate: t.procedure
    .input(
      z.object({
        prompt: z.string().min(1),
        currentCode: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error(
          "ANTHROPIC_API_KEY not set. Export it before starting the inspector server.",
          { cause: "missing_key" }
        );
      }

      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey });

      const systemPrompt = `You are an expert Act framework developer. Generate TypeScript code using the @rotorsoft/act event sourcing framework.

## Architecture
- **State**: Domain entity defined with \`state({ Name: schema })\`. Has \`.init()\`, \`.emits()\`, optional \`.patch()\` for custom reducers, \`.on()\` for actions, \`.emit()\` for event emission, \`.given()\` for invariants, \`.build()\`.
- **Slice**: Vertical feature grouping with \`slice()\`. Groups partial states + reactions. Uses \`.withState(State)\`, \`.withProjection(Proj)\`, \`.on("EventName").do(handler).to(resolver)\`, \`.build()\`.
- **Projection**: Read model with \`projection("name")\`. Uses \`.on({ Event: schema }).do(handler)\`, \`.build()\`.
- **Act**: Orchestrator with \`act()\`. Uses \`.withSlice(Slice)\`, \`.withProjection(Proj)\`, \`.build()\`.

## Builder Patterns
\`\`\`typescript
// State with partial state pattern (multiple states can share the same aggregate name)
const MyState = state({ Aggregate: z.object({ field: z.string() }) })
  .init(() => ({ field: "" }))
  .emits({ EventHappened: z.object({ value: z.string() }) })
  .patch({ EventHappened: ({ data }) => ({ field: data.value }) }) // optional — passthrough is default
  .on({ DoSomething: z.object({ value: z.string() }) })
    .given([{ description: "Must be valid", valid: (state) => state.field !== "" }])
    .emit("EventHappened") // string passthrough when payload matches
  .build();

// Slice groups states + reactions
const MySlice = slice()
  .withState(MyState)
  .withProjection(MyProjection)
  .on("EventHappened")
    .do(async function handleEvent(event, _stream, app) {
      await app.do("OtherAction", { stream: target, actor: { id: "system", name: "System" } }, payload, event);
    })
    .to((event) => ({ target: event.stream }))
  .build();

// Projection for read models
const MyProjection = projection("myview")
  .on({ EventHappened: z.object({ value: z.string() }) })
    .do(async ({ stream, data }) => { /* update read model */ })
  .build();

// Act orchestrator
const app = act()
  .withSlice(MySlice)
  .withProjection(MyProjection)
  .build();
\`\`\`

## Rules
- Import from "@rotorsoft/act" and "zod"
- Use \`z\` for all schemas, \`ZodEmpty\` for empty payloads
- Partial states: multiple \`state({ SameName: ... })\` merge automatically in slices
- Each slice should own its partial states and reactions — separate concerns into slices
- Reactions MUST call \`app.do("ActionName", target, payload, event)\` — pass event for causation tracking
- Use \`.to(resolver)\` for reactions that need drain processing, \`.void()\` only for side effects
- Use \`type Invariant\` for business rules: \`{ description: string; valid: (state) => boolean }\`
- Name reaction handlers with \`async function name(...)\` for readability
- Always include the \`act()\` orchestrator wiring slices and projections
- Return ONLY TypeScript code, no markdown fences, no explanation

${input.currentCode ? `Current code to refine:\n\`\`\`typescript\n${input.currentCode}\n\`\`\`\n\nModify the existing code based on the user's request. Return the complete updated code.` : "Generate complete Act TypeScript code from scratch."}`;

      const response = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: "user", content: input.prompt }],
      });

      const textBlock = response.content.find((b) => b.type === "text");
      let code = textBlock?.text ?? "";

      // Strip markdown fences if present
      code = code
        .replace(/^```(?:typescript|ts)?\n?/m, "")
        .replace(/\n?```$/m, "")
        .trim();

      return { code };
    }),

  /** Fetch source files from a GitHub repo, following local imports */
  fetchFromGit: t.procedure
    .input(
      z.object({
        owner: z.string(),
        repo: z.string(),
        branch: z.string().default("master"),
        entryPath: z.string(),
      })
    )
    .mutation(async ({ input }) => {
      const { owner, repo, branch, entryPath } = input;
      const fetched = new Map<string, string>();
      const queue = [entryPath];

      while (queue.length > 0) {
        const filePath = queue.shift()!;
        if (fetched.has(filePath)) continue;

        const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`;
        const res = await fetch(url);
        if (!res.ok) {
          if (fetched.size === 0) {
            throw new Error(`Failed to fetch ${url}: ${res.status}`, {
              cause: "fetch_error",
            });
          }
          continue; // skip missing optional imports
        }
        const content = await res.text();
        fetched.set(filePath, content);

        // Follow local relative imports: import ... from "./foo.js" or "../bar.js"
        const importRe = /from\s+["'](\.[^"']+)["']/g;
        let m: RegExpExecArray | null;
        while ((m = importRe.exec(content)) !== null) {
          const importPath = m[1];
          // Resolve relative to current file's directory
          const dir = filePath.includes("/")
            ? filePath.slice(0, filePath.lastIndexOf("/"))
            : "";
          // Normalize: ./foo.js or ../bar/baz.js
          const parts = (dir ? dir + "/" + importPath : importPath).split("/");
          const resolved: string[] = [];
          for (const p of parts) {
            if (p === "." || p === "") continue;
            if (p === "..") resolved.pop();
            else resolved.push(p);
          }
          let resolvedPath = resolved.join("/");
          // Ensure .ts extension (raw files on GitHub are .ts, imports use .js)
          resolvedPath = resolvedPath.replace(/\.js$/, ".ts");
          if (!resolvedPath.endsWith(".ts")) resolvedPath += ".ts";
          queue.push(resolvedPath);
        }
      }

      // Concatenate all files with headers
      const files = [...fetched.entries()].map(([path, content]) => ({
        path,
        content,
      }));

      const code = files
        .map((f) => `// === ${f.path} ===\n${f.content}`)
        .join("\n\n");

      return { files, code };
    }),
});

export type InspectorRouter = typeof inspectorRouter;
