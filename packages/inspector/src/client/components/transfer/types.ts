/**
 * Local mirrors of the server's `TransferEndpoint` shape — the
 * unified transfer mutation accepts the same discriminated union on
 * both sides. Some kinds are slot-restricted (`upload` only valid as
 * source, `download` only valid as target) but the type allows both
 * to keep the picker components symmetrical; the dialog rejects the
 * invalid combinations client-side and the server schema enforces
 * it again.
 *
 * Mirrors `TransferSource` / `TransferTarget` in router.ts.
 */
export type TransferEndpoint =
  | { adapter: "current" }
  | { adapter: "upload"; csv: string }
  | { adapter: "download" }
  | { adapter: "csv"; file: string }
  | {
      adapter: "pg";
      host: string;
      port: number;
      database: string;
      user: string;
      password: string;
      schema: string;
      table: string;
    }
  | { adapter: "sqlite"; file: string; table: string };

/**
 * Default fields the picker fills in when the operator first
 * switches to a given adapter kind. Matches the connect form's
 * defaults so muscle memory carries over.
 */
export const TRANSFER_DEFAULTS = {
  current: { adapter: "current" } as const,
  upload: { adapter: "upload", csv: "" } as const,
  download: { adapter: "download" } as const,
  csv: { adapter: "csv", file: "" } as const,
  pg: {
    adapter: "pg",
    host: "localhost",
    port: 5432,
    database: "postgres",
    user: "postgres",
    password: "postgres",
    schema: "public",
    table: "events",
  } as const,
  sqlite: { adapter: "sqlite", file: "", table: "events" } as const,
} satisfies Record<string, TransferEndpoint>;

/**
 * Wire-shape mirror of `ScanResult` from `@rotorsoft/act`, kept
 * local to the transfer UI so the components don't drag the
 * framework type through tRPC inference paths.
 */
export type ScanResult = {
  kept: number;
  duration_ms: number;
  dropped: {
    closed_streams: number;
    snapshots: number;
  };
};
