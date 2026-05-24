/**
 * Shared types for the discovery module (ACT-1122).
 *
 * `DiscoveredStore` is the response shape the inspector hands back to
 * the UI — a discriminated union over `kind` so the connection panel
 * can render adapter-specific badges (port + db vs. file path).
 *
 * The input shape is also discriminated so `runDiscovery` can dispatch
 * to the right probe with one branch. Defaults on the PG variant keep
 * existing frontend payloads working without changes — a call with
 * `{ host, portFrom, portTo }` (no `kind` field) parses as PG.
 */

/** Result row for a Postgres-backed Act store. */
export type DiscoveredPgStore = {
  readonly kind: "pg";
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly database: string;
  readonly schema: string;
  readonly table: string;
  readonly eventCount: number;
};

/** Result row for a SQLite-backed Act store. */
export type DiscoveredSqliteStore = {
  readonly kind: "sqlite";
  readonly file: string;
  readonly table: string;
  readonly eventCount: number;
};

/** Discriminated union: any adapter the inspector knows how to probe. */
export type DiscoveredStore = DiscoveredPgStore | DiscoveredSqliteStore;

/** Input for the PG port-range probe. */
export type PgDiscoveryInput = {
  readonly host: string;
  readonly portFrom: number;
  readonly portTo: number;
};

/** Input for the SQLite directory probe. */
export type SqliteDiscoveryInput = {
  readonly dir: string;
  /** Regex (as a string) used to filter directory entries.
   *  Default: `\.(db|sqlite|sqlite3)$` (case-insensitive). */
  readonly glob?: string;
};

/** Top-level discriminated input accepted by `runDiscovery`. */
export type DiscoveryInput =
  | ({ readonly kind: "pg" } & PgDiscoveryInput)
  | ({ readonly kind: "sqlite" } & SqliteDiscoveryInput);
