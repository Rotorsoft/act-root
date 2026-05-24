import { useState } from "react";
import { trpc } from "../trpc.js";

// Mirrors the server's `DiscoveredSqliteStore` shape. See
// `server/discovery/types.ts` — we narrow the `discover` response to
// just the SQLite variant inside this dialog.
type DiscoveredSqliteStore = {
  kind: "sqlite";
  file: string;
  table: string;
  eventCount: number;
};

export type SqliteScanResult = {
  file: string;
  table: string;
};

type Props = {
  initialDir: string;
  onSelect: (result: SqliteScanResult) => void;
  onClose: () => void;
};

export function SqliteScanDialog({ initialDir, onSelect, onClose }: Props) {
  const [dir, setDir] = useState(initialDir);
  const [glob, setGlob] = useState("");
  const [stores, setStores] = useState<DiscoveredSqliteStore[]>([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState("");
  const [scanned, setScanned] = useState(false);

  const discoverMutation = trpc.discover.useMutation({
    onSuccess: (result) => {
      const sqliteStores = result.stores.filter(
        (s): s is DiscoveredSqliteStore => s.kind === "sqlite"
      );
      setStores(sqliteStores);
      setScanning(false);
      setScanned(true);
      if (sqliteStores.length === 0) {
        setError("No Act SQLite stores found");
      } else if (sqliteStores.length === 1) {
        handleSelect(sqliteStores[0]);
      }
    },
    onError: (err) => {
      setError(err.message);
      setScanning(false);
      setScanned(true);
    },
  });

  const handleScan = () => {
    if (!dir.trim()) {
      setError("Directory is required");
      return;
    }
    setError("");
    setStores([]);
    setScanning(true);
    setScanned(false);
    discoverMutation.mutate({
      kind: "sqlite",
      dir,
      glob: glob.trim() || undefined,
    });
  };

  const handleSelect = (store: DiscoveredSqliteStore) => {
    onSelect({ file: store.file, table: store.table });
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-xl border border-zinc-700 bg-zinc-900 p-5 shadow-2xl">
        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-200">
            Scan Directory for SQLite Stores
          </h3>
          <button
            onClick={onClose}
            className="text-zinc-500 transition hover:text-zinc-300"
          >
            &times;
          </button>
        </div>

        {/* Scan options */}
        <div className="mb-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-zinc-400">Directory</span>
            <input
              type="text"
              value={dir}
              onChange={(e) => setDir(e.target.value)}
              placeholder="/path/to/db/dir"
              className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100 outline-none transition focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600"
            />
          </label>
          <div className="flex items-end gap-3">
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-xs text-zinc-400">
                File pattern (regex, optional)
              </span>
              <input
                type="text"
                value={glob}
                onChange={(e) => setGlob(e.target.value)}
                placeholder="\.(db|sqlite|sqlite3)$"
                className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100 outline-none transition focus:border-emerald-600"
              />
            </label>
            <button
              onClick={handleScan}
              disabled={scanning}
              className="rounded-md bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-emerald-500 disabled:opacity-50"
            >
              {scanning ? "Scanning..." : "Scan"}
            </button>
          </div>
        </div>

        {/* Scanning indicator */}
        {scanning && (
          <div className="mb-3 rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-[10px] text-zinc-500">
            Scanning {dir}...
          </div>
        )}

        {/* Results */}
        {stores.length > 0 && (
          <div className="max-h-56 overflow-y-auto">
            <span className="mb-2 block text-xs font-medium text-emerald-400">
              Found {stores.length} store{stores.length !== 1 ? "s" : ""}
            </span>
            <div className="flex flex-col gap-1.5">
              {stores.map((s) => (
                <button
                  key={s.file}
                  onClick={() => handleSelect(s)}
                  className="flex items-center gap-2 rounded-md border border-zinc-700/50 bg-zinc-800 px-3 py-2.5 text-left text-xs transition hover:border-emerald-700 hover:bg-emerald-950/30"
                >
                  <span className="shrink-0 rounded bg-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-300">
                    sqlite
                  </span>
                  <span className="truncate font-mono text-zinc-300">
                    {s.file}
                  </span>
                  {s.eventCount > 0 && (
                    <span className="ml-auto shrink-0 rounded bg-zinc-700/50 px-1.5 py-0.5 text-[10px] text-zinc-400">
                      {s.eventCount.toLocaleString()} events
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* No results */}
        {scanned && !scanning && stores.length === 0 && !error && (
          <div className="rounded-md border border-zinc-800 bg-zinc-950 px-3 py-4 text-center text-xs text-zinc-500">
            No Act SQLite stores found in {dir}
          </div>
        )}

        {error && (
          <div className="mt-2 rounded-md border border-red-900 bg-red-950 px-3 py-2 text-xs text-red-400">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
