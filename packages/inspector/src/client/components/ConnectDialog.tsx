import { useState } from "react";
import { trpc } from "../trpc.js";
import { Logo } from "./Logo.js";
import { ScanDialog, type ScanResult } from "./ScanDialog.js";
import {
  SqliteScanDialog,
  type SqliteScanResult,
} from "./SqliteScanDialog.js";

/**
 * Connection persistence (ACT-1123).
 *
 * Saved connections widen to a discriminated union so SQLite entries
 * can live alongside PG ones in the same localStorage list. Pre-1.1
 * payloads (no `kind` field) are migrated as PG on load so existing
 * users don't lose their bookmarks.
 */
type PgConnection = {
  kind: "pg";
  name: string;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  schema: string;
  table: string;
  ssl: boolean;
};

type SqliteConnection = {
  kind: "sqlite";
  name: string;
  file: string;
  table: string;
};

type Connection = PgConnection | SqliteConnection;

const defaultPg: PgConnection = {
  kind: "pg",
  name: "Local PG",
  host: "localhost",
  port: 5432,
  database: "postgres",
  user: "postgres",
  password: "postgres",
  schema: "public",
  table: "events",
  ssl: false,
};

const defaultSqlite: SqliteConnection = {
  kind: "sqlite",
  name: "Local SQLite",
  file: "./events.db",
  table: "events",
};

function loadSaved(): Connection[] {
  try {
    const raw = localStorage.getItem("inspector:connections");
    if (!raw) return [];
    const parsed: unknown[] = JSON.parse(raw);
    // Migrate legacy entries (no `kind` field) — these predate ACT-1123
    // and are always PG.
    return parsed.map((c) => {
      if (
        typeof c === "object" &&
        c !== null &&
        "kind" in (c as Record<string, unknown>)
      ) {
        return c as Connection;
      }
      return { kind: "pg", ...(c as Omit<PgConnection, "kind">) };
    });
  } catch {
    return [];
  }
}

function saveConnections(conns: Connection[]) {
  // Drop the PG `password` field entirely before persisting — never
  // serialize sensitive data into localStorage. Operator re-enters on
  // connect. The destructure-omit pattern (rather than overriding
  // `password = ""`) is what CodeQL's `js/clear-text-storage-of-
  // sensitive-data` rule recognizes as a real strip. SQLite has no
  // password to strip.
  const safe = conns.map((c) => {
    if (c.kind === "pg") {
      const { password: _pw, ...rest } = c;
      return rest;
    }
    return c;
  });
  localStorage.setItem("inspector:connections", JSON.stringify(safe));
}

type Props = {
  onConnected: (name: string) => void;
  onClose?: () => void;
};

export function ConnectDialog({ onConnected, onClose }: Props) {
  const [saved, setSaved] = useState<Connection[]>(loadSaved);
  const initialConn = saved[0] ?? defaultPg;
  const [conn, setConn] = useState<Connection>(initialConn);
  const [error, setError] = useState("");
  const [testing, setTesting] = useState(false);
  const [showScan, setShowScan] = useState(false);
  const [connString, setConnString] = useState("");

  // The active tab follows the current `conn.kind`. Switching tabs
  // swaps in the appropriate default (or the most recently used saved
  // connection of that kind, if any).
  const handleSwitchTab = (kind: Connection["kind"]) => {
    if (conn.kind === kind) return;
    const recent = saved.find((s) => s.kind === kind);
    setConn(recent ?? (kind === "pg" ? defaultPg : defaultSqlite));
  };

  const connectMutation = trpc.connect.useMutation({
    onSuccess: () => {
      const existing = saved.filter((s) => s.name !== conn.name);
      const updated = [conn, ...existing];
      setSaved(updated);
      saveConnections(updated);
      onConnected(conn.name);
    },
    onError: (err) => {
      setError(err.message);
      setTesting(false);
    },
  });

  const handlePgScanSelect = (result: ScanResult) => {
    const isDefault = result.schema === "public" && result.table === "events";
    const label = isDefault
      ? result.database
      : `${result.schema}.${result.table}`;
    setConn({
      kind: "pg",
      name: label,
      host: result.host,
      port: result.port,
      user: result.user,
      database: result.database,
      schema: result.schema,
      table: result.table,
      password: conn.kind === "pg" ? conn.password : "",
      ssl: conn.kind === "pg" ? conn.ssl : false,
    });
    setShowScan(false);
  };

  const handleSqliteScanSelect = (result: SqliteScanResult) => {
    // Use the file's basename as a friendlier default name.
    const base = result.file.split(/[/\\]/).pop() ?? result.file;
    setConn({
      kind: "sqlite",
      name: base,
      file: result.file,
      table: result.table,
    });
    setShowScan(false);
  };

  const handleConnect = () => {
    setError("");
    setTesting(true);
    if (conn.kind === "sqlite") {
      connectMutation.mutate({
        adapter: "sqlite",
        file: conn.file,
        table: conn.table,
      });
      return;
    }
    connectMutation.mutate({
      adapter: "pg",
      host: conn.host,
      port: conn.port,
      database: conn.database,
      user: conn.user,
      password: conn.password,
      schema: conn.schema,
      table: conn.table,
      ssl: conn.ssl,
    });
  };

  const handleSavedSelect = (name: string) => {
    const found = saved.find((s) => s.name === name);
    if (found) setConn(found);
  };

  const handleDelete = (name: string) => {
    const updated = saved.filter((s) => s.name !== name);
    setSaved(updated);
    saveConnections(updated);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-xl border border-zinc-800 bg-zinc-900 p-6 shadow-2xl">
        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Logo size={24} />
            <h2 className="text-lg font-semibold text-zinc-100">
              Connect to Act Store
            </h2>
          </div>
          {onClose && (
            <button
              onClick={onClose}
              className="text-zinc-500 transition hover:text-zinc-300"
            >
              &times;
            </button>
          )}
        </div>

        {/* Adapter tabs */}
        <div className="mb-4 flex gap-1 border-b border-zinc-800">
          {([
            ["pg", "Postgres"],
            ["sqlite", "SQLite"],
          ] as const).map(([kind, label]) => (
            <button
              key={kind}
              onClick={() => handleSwitchTab(kind)}
              className={`-mb-px border-b-2 px-3 py-1.5 text-xs font-medium transition ${
                conn.kind === kind
                  ? "border-emerald-500 text-emerald-400"
                  : "border-transparent text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Saved connections */}
        {saved.length > 0 && (
          <div className="mb-4">
            <span className="mb-1.5 block text-[10px] uppercase tracking-wider text-zinc-500">
              Saved connections
            </span>
            <div className="flex flex-wrap gap-2">
              {saved.map((s) => (
                <div key={s.name} className="flex items-center gap-1">
                  <button
                    onClick={() => handleSavedSelect(s.name)}
                    className={`flex items-center gap-1.5 rounded-md border px-3 py-1 text-xs transition ${
                      conn.name === s.name
                        ? "border-emerald-600 bg-emerald-950 text-emerald-400"
                        : "border-zinc-700 bg-zinc-800 text-zinc-300 hover:border-zinc-600"
                    }`}
                  >
                    <span className="rounded bg-zinc-700/60 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wider text-zinc-400">
                      {s.kind}
                    </span>
                    {s.name}
                  </button>
                  <button
                    onClick={() => handleDelete(s.name)}
                    className="text-xs text-zinc-600 transition hover:text-red-400"
                  >
                    &times;
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* PG form */}
        {conn.kind === "pg" && (
          <>
            <div className="mb-3">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-zinc-400">Connection String</span>
                <input
                  type="text"
                  value={connString}
                  onChange={(e) => {
                    setConnString(e.target.value);
                    try {
                      const url = new URL(e.target.value);
                      const sslMode = url.searchParams.get("sslmode");
                      setConn({
                        kind: "pg",
                        name: url.pathname.slice(1) || conn.name,
                        host: url.hostname,
                        port: Number(url.port) || 5432,
                        database: url.pathname.slice(1) || "postgres",
                        user: url.username || "postgres",
                        password: decodeURIComponent(url.password || ""),
                        schema: url.searchParams.get("schema") || "public",
                        table: url.searchParams.get("table") || "events",
                        ssl:
                          sslMode === "require" ||
                          sslMode === "prefer" ||
                          url.hostname.includes("neon") ||
                          url.hostname.includes("supabase"),
                      });
                    } catch {
                      // Not a valid URL yet, ignore
                    }
                  }}
                  placeholder="postgresql://user:pass@host:port/database"
                  className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600"
                />
              </label>
            </div>

            <div className="grid grid-cols-2 gap-3">
              {(
                [
                  ["Connection Name", "name", "text"],
                  ["Host", "host", "text"],
                  ["Port", "port", "number"],
                  ["Database", "database", "text"],
                  ["User", "user", "text"],
                  ["Password", "password", "password"],
                  ["Schema", "schema", "text"],
                  ["Table", "table", "text"],
                ] as const
              ).map(([label, key, type]) => (
                <label key={key} className="flex flex-col gap-1">
                  <span className="text-xs text-zinc-400">{label}</span>
                  <input
                    type={type}
                    value={String(conn[key] ?? "")}
                    onChange={(e) =>
                      setConn({
                        ...conn,
                        [key]:
                          type === "number"
                            ? Number(e.target.value)
                            : e.target.value,
                      })
                    }
                    className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100 outline-none transition focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600"
                  />
                </label>
              ))}
            </div>

            <label className="mt-2 flex items-center gap-2">
              <input
                type="checkbox"
                checked={conn.ssl}
                onChange={(e) => setConn({ ...conn, ssl: e.target.checked })}
                className="h-3.5 w-3.5 rounded border-zinc-600 bg-zinc-800 text-emerald-600"
              />
              <span className="text-xs text-zinc-400">
                SSL (required for Neon, Supabase, etc.)
              </span>
            </label>
          </>
        )}

        {/* SQLite form */}
        {conn.kind === "sqlite" && (
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-zinc-400">Connection Name</span>
              <input
                type="text"
                value={conn.name}
                onChange={(e) => setConn({ ...conn, name: e.target.value })}
                className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100 outline-none transition focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-zinc-400">File path</span>
              <input
                type="text"
                value={conn.file}
                onChange={(e) => setConn({ ...conn, file: e.target.value })}
                placeholder="/absolute/path/to/store.db"
                className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 font-mono text-sm text-zinc-100 outline-none transition focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-zinc-400">Table</span>
              <input
                type="text"
                value={conn.table}
                onChange={(e) => setConn({ ...conn, table: e.target.value })}
                className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100 outline-none transition focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600"
              />
            </label>
          </div>
        )}

        {error && (
          <div className="mt-3 rounded-md border border-red-900 bg-red-950 px-3 py-2 text-xs text-red-400">
            {error}
          </div>
        )}

        {/* Actions */}
        <div className="mt-4 flex justify-between">
          <button
            onClick={() => setShowScan(true)}
            className="rounded-md border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm text-zinc-300 transition hover:border-emerald-700 hover:text-emerald-400"
          >
            Scan...
          </button>
          <div className="flex gap-2">
            {onClose && (
              <button
                onClick={onClose}
                className="rounded-md border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm text-zinc-400 transition hover:border-zinc-600"
              >
                Cancel
              </button>
            )}
            <button
              onClick={handleConnect}
              disabled={testing}
              className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-500 disabled:opacity-50"
            >
              {testing ? "Connecting..." : "Connect"}
            </button>
          </div>
        </div>
      </div>

      {/* Adapter-specific scanner */}
      {showScan && conn.kind === "pg" && (
        <ScanDialog
          initialHost={conn.host}
          onSelect={handlePgScanSelect}
          onClose={() => setShowScan(false)}
        />
      )}
      {showScan && conn.kind === "sqlite" && (
        <SqliteScanDialog
          initialDir={conn.file.replace(/[^/\\]+$/, "") || "."}
          onSelect={handleSqliteScanSelect}
          onClose={() => setShowScan(false)}
        />
      )}
    </div>
  );
}
