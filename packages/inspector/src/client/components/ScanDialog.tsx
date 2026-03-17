import { useState } from "react";
import { trpc } from "../trpc.js";

type DiscoveredStore = {
  host: string;
  port: number;
  user: string;
  database: string;
  schema: string;
  table: string;
  eventCount: number;
};

export type ScanResult = {
  host: string;
  port: number;
  user: string;
  database: string;
  schema: string;
  table: string;
};

type Props = {
  initialHost: string;
  onSelect: (result: ScanResult) => void;
  onClose: () => void;
};

export function ScanDialog({ initialHost, onSelect, onClose }: Props) {
  const [host, setHost] = useState(initialHost);
  const [portFrom, setPortFrom] = useState(5430);
  const [portTo, setPortTo] = useState(5480);
  const [stores, setStores] = useState<DiscoveredStore[]>([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState("");
  const [scanned, setScanned] = useState(false);

  const discoverMutation = trpc.discover.useMutation({
    onSuccess: (result) => {
      setStores(result.stores);
      setScanning(false);
      setScanned(true);
      if (result.stores.length === 0) {
        setError("No Act event stores found");
      } else if (result.stores.length === 1) {
        // Single result — auto-select it
        handleSelect(result.stores[0]);
      }
    },
    onError: (err) => {
      setError(err.message);
      setScanning(false);
      setScanned(true);
    },
  });

  const handleScan = () => {
    setError("");
    setStores([]);
    setScanning(true);
    setScanned(false);
    discoverMutation.mutate({ host, portFrom, portTo });
  };

  const handleSelect = (store: DiscoveredStore) => {
    onSelect({
      host: store.host,
      port: store.port,
      user: store.user,
      database: store.database,
      schema: store.schema,
      table: store.table,
    });
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-xl border border-zinc-700 bg-zinc-900 p-5 shadow-2xl">
        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-200">
            Scan for Act Stores
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
            <span className="text-xs text-zinc-400">Host</span>
            <input
              type="text"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100 outline-none transition focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600"
            />
          </label>
          <div className="flex items-end gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-zinc-400">Port from</span>
              <input
                type="number"
                value={portFrom}
                onChange={(e) => setPortFrom(Number(e.target.value))}
                className="w-24 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100 outline-none transition focus:border-emerald-600"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-zinc-400">Port to</span>
              <input
                type="number"
                value={portTo}
                onChange={(e) => setPortTo(Number(e.target.value))}
                className="w-24 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100 outline-none transition focus:border-emerald-600"
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
            Scanning {host} — ports {portFrom}–{portTo}...
          </div>
        )}

        {/* Results — one per port */}
        {stores.length > 0 && (
          <div className="max-h-56 overflow-y-auto">
            <span className="mb-2 block text-xs font-medium text-emerald-400">
              Found {stores.length} store{stores.length !== 1 ? "s" : ""}
            </span>
            <div className="flex flex-col gap-1.5">
              {stores.map((s) => (
                <button
                  key={`${s.port}:${s.schema}`}
                  onClick={() => handleSelect(s)}
                  className="flex items-center gap-2 rounded-md border border-zinc-700/50 bg-zinc-800 px-3 py-2.5 text-left text-xs transition hover:border-emerald-700 hover:bg-emerald-950/30"
                >
                  <span className="shrink-0 rounded bg-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-300">
                    :{s.port}
                  </span>
                  <span className="text-zinc-300">{s.database}</span>
                  <span className="text-zinc-600">/</span>
                  <span className="font-medium text-emerald-400">
                    {s.schema}.{s.table}
                  </span>
                  {s.eventCount > 0 && (
                    <span className="ml-auto rounded bg-zinc-700/50 px-1.5 py-0.5 text-[10px] text-zinc-400">
                      ~{s.eventCount.toLocaleString()} events
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
            No Act event stores found on {host}
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
