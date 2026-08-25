/**
 * Reading who is looking for work, and how far they have got (#1539).
 *
 * The inspector can show how far each reaction has progressed, but nothing
 * about the step *before* that: something has to read new events and note
 * which reactions care. Since [#1532] one worker does that on behalf of the
 * rest, holding a short claim on the job — so if it dies, nothing is noticed
 * until the claim lapses. That is bounded and self-healing, and until now
 * completely invisible.
 *
 * The framework keeps this in its own small table rather than on the `Store`
 * interface, so there is no port method to call. Reading it directly is the
 * same thing the connection probes already do, using the connection details
 * the inspector already holds — no framework change, and nothing here is
 * reachable that `discover` could not already reach.
 */
import { createClient } from "@libsql/client";
import pg from "pg";

/** One correlator: a set of reactions that are looked for together. */
export type Correlator = {
  /**
   * Which correlator. An empty key is the shared row — the position a
   * brand-new correlator starts from, not a worker.
   */
  readonly key: string;
  /** How far into the event log this correlator has read. */
  readonly at: number;
  /** The worker currently doing the reading, if any. */
  readonly leasedBy: string | null;
  /** When that worker's turn runs out, as epoch milliseconds. */
  readonly leasedUntil: number | null;
};

export type CorrelatorsConfig =
  | {
      readonly adapter: "pg";
      readonly host: string;
      readonly port: number;
      readonly database: string;
      readonly user: string;
      readonly password: string;
      readonly schema: string;
      readonly table: string;
      /**
       * TLS, on the same terms the store connects with (#1554). Without
       * these the reader could never reach a Postgres that requires TLS —
       * RDS, Neon, Supabase — while the store connected fine, leaving the
       * panel permanently dark on exactly the deployments where its
       * "nothing to record here" message is most likely to be believed.
       */
      readonly ssl?: boolean;
      readonly sslInsecure?: boolean;
    }
  | { readonly adapter: "sqlite"; readonly file: string };

/**
 * Is this failure the benign one — no such table, or the older shape?
 *
 * An in-memory store keeps this in memory with no table behind it, and a
 * store that predates [#1532] has the older single-row shape. Those two are
 * worth nothing more than an empty panel. A refused connection, a
 * permission error or a wrong schema are not, and used to arrive at the
 * operator wearing the same clothes (#1554).
 *
 * Postgres says so by error code — undefined table, undefined column, or a
 * schema that isn't there; SQLite says so in the message.
 */
const MISSING_RELATION_CODES = new Set(["42P01", "42703", "3F000"]);
function is_missing_relation(error: unknown): boolean {
  // `Object(error)` so a thrown non-object still lands somewhere with no
  // `code`, and the message test below decides.
  const code = (Object(error) as { code?: unknown }).code;
  if (typeof code === "string" && MISSING_RELATION_CODES.has(code)) return true;
  return /no such (table|column)/i.test(String(error));
}

/**
 * Read every correlator the connected store knows about.
 *
 * Returns an empty list when the table simply isn't there — see
 * {@link is_missing_relation}. Every other failure is raised, so the panel
 * can say it couldn't read rather than naming a cause nothing verified.
 */
export async function readCorrelators(
  config: CorrelatorsConfig
): Promise<Correlator[]> {
  return config.adapter === "pg" ? read_pg(config) : read_sqlite(config);
}

async function read_pg(
  config: Extract<CorrelatorsConfig, { adapter: "pg" }>
): Promise<Correlator[]> {
  const client = new pg.Client({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    connectionTimeoutMillis: 3_000,
    // Mapped here rather than shared with the router's `resolveSslConfig`
    // on purpose: that one warns about the verification opt-out, and this
    // client is rebuilt on every poll of the panel.
    ...(config.ssl ? { ssl: { rejectUnauthorized: !config.sslInsecure } } : {}),
  });
  try {
    await client.connect();
    const { rows } = await client.query<{
      key: string;
      at: string;
      leased_by: string | null;
      leased_until: Date | null;
    }>(
      `SELECT key, at, leased_by, leased_until
         FROM "${config.schema}"."${config.table}_correlated"
        ORDER BY key`
    );
    return rows.map((r) => ({
      key: r.key,
      at: Number(r.at),
      leasedBy: r.leased_by,
      leasedUntil: r.leased_until ? r.leased_until.getTime() : null,
    }));
  } catch (error) {
    if (is_missing_relation(error)) return [];
    throw error;
  } finally {
    await client.end().catch(() => {});
  }
}

async function read_sqlite(
  config: Extract<CorrelatorsConfig, { adapter: "sqlite" }>
): Promise<Correlator[]> {
  const client = createClient({ url: `file:${config.file}` });
  try {
    const { rows } = await client.execute(
      "SELECT key, at, leased_by, leased_until FROM correlated ORDER BY key"
    );
    return rows.map((r) => ({
      key: String(r.key),
      at: Number(r.at),
      leasedBy: r.leased_by === null ? null : String(r.leased_by),
      leasedUntil: r.leased_until === null ? null : Number(r.leased_until),
    }));
  } catch (error) {
    if (is_missing_relation(error)) return [];
    throw error;
  } finally {
    client.close();
  }
}
