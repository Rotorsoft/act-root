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
    }
  | { readonly adapter: "sqlite"; readonly file: string };

/**
 * Read every correlator the connected store knows about.
 *
 * Returns an empty list rather than throwing when there is nothing to read —
 * an in-memory store keeps this in memory with no table behind it, and a
 * store that predates [#1532] has the older single-row shape. Neither is an
 * error worth interrupting the page for; both simply have nothing to show.
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
  } catch {
    // Missing table, older single-row shape, or an unreachable server.
    return [];
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
  } catch {
    return [];
  } finally {
    client.close();
  }
}
