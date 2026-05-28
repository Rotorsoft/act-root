/**
 * Adapter config shapes accepted by the `transfer` tRPC mutation
 * (ACT-1128 + #788). Mirrors the server-side discriminated union
 * locally so the picker components don't drag a server type
 * through tRPC inference paths.
 */
export type TransferPgConfig = {
  adapter: "pg";
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  schema: string;
  table: string;
};

export type TransferSqliteConfig = {
  adapter: "sqlite";
  file: string;
  table: string;
};

export type TransferCsvConfig = {
  adapter: "csv";
  file: string;
};

export type TransferConfig =
  | TransferPgConfig
  | TransferSqliteConfig
  | TransferCsvConfig;

/**
 * Defaults used by the picker the first time the operator switches
 * to a given adapter kind. PG defaults match the existing
 * connect-form defaults; SQLite + CSV have no host/port so they
 * only carry the file slot.
 */
export const TRANSFER_DEFAULTS: {
  pg: TransferPgConfig;
  sqlite: TransferSqliteConfig;
  csv: TransferCsvConfig;
} = {
  pg: {
    adapter: "pg",
    host: "localhost",
    port: 5432,
    database: "postgres",
    user: "postgres",
    password: "postgres",
    schema: "public",
    table: "events",
  },
  sqlite: { adapter: "sqlite", file: "", table: "events" },
  csv: { adapter: "csv", file: "" },
};
