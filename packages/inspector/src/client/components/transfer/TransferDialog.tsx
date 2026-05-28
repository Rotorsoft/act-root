import { useEffect, useState } from "react";
import { queryClient, trpc } from "../../trpc.js";
import { AdapterPicker } from "./AdapterPicker.js";
import { CompactionToggles } from "./CompactionToggles.js";
import { PreviewPanel } from "./PreviewPanel.js";
import { ProgressBar } from "./ProgressBar.js";
import { TransferSummary } from "./TransferSummary.js";
import {
  type ScanResult,
  TRANSFER_DEFAULTS,
  type TransferEndpoint,
} from "./types.js";

/**
 * The one transfer dialog (ACT-1128 / #788). Subsumes the prior
 * backup, restore, and cross-adapter UIs — the operator picks any
 * source and any target from the unified `TransferEndpoint` set.
 *
 * Default selection is `current → download` (the common backup
 * case). Operators swap as needed.
 *
 * The Run button's label adapts to the selection so the same
 * widget reads as "Save backup" / "Restore" / "Transfer" without
 * three separate dialogs.
 */
export function TransferDialog({ onClose }: { onClose: () => void }) {
  const { data: status } = trpc.status.useQuery();
  const connectedSummary = status?.connected
    ? `${status.adapter}: ${status.target}`
    : "Not connected";

  const [source, setSource] = useState<TransferEndpoint>(
    TRANSFER_DEFAULTS.current
  );
  const [target, setTarget] = useState<TransferEndpoint>(
    TRANSFER_DEFAULTS.download
  );
  const [dropSnapshots, setDropSnapshots] = useState(false);
  const [preview, setPreview] = useState<ScanResult | null>(null);
  const [summary, setSummary] = useState<{
    result: ScanResult;
    targetTouchedConnected: boolean;
  } | null>(null);

  const transferMutation = trpc.transfer.useMutation({
    onSuccess(data) {
      setSummary({
        result: data.result,
        targetTouchedConnected: target.adapter === "current",
      });
      if (target.adapter === "download" && data.csv) {
        // Download path: drop the bytes into a browser file save.
        const blob = new Blob([data.csv], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        a.download = `act-events-${ts}.csv`;
        a.click();
        URL.revokeObjectURL(url);
      }
      void queryClient.invalidateQueries();
    },
  });
  const previewMutation = trpc.transfer.useMutation({
    onSuccess(data) {
      setPreview(data.result);
    },
    onError() {
      setPreview(null);
    },
  });

  // Reactive progress — same SSE subscription as everything else
  // that calls `Act.restore` server-side.
  const [processed, setProcessed] = useState(0);
  trpc.restoreProgress.useSubscription(undefined, {
    enabled: transferMutation.isPending,
    onData: (event) => setProcessed(event.processed),
  });

  // Invalidate the preview if any input changes — the counts
  // assumed the old shape.
  useEffect(() => {
    setPreview(null);
  }, [source, target, dropSnapshots]);

  const inFlight = transferMutation.isPending;
  const sameStore = endpointsEqual(source, target);
  const sourceReady = endpointReady(source);
  const targetReady = endpointReady(target);
  const connectedNeededButMissing =
    (source.adapter === "current" || target.adapter === "current") &&
    !status?.connected;
  const canRun =
    !inFlight &&
    !sameStore &&
    sourceReady &&
    targetReady &&
    !connectedNeededButMissing;

  // The narrow source/target schemas on the server reject some
  // kinds per slot (`upload` is source-only, `download` is target
  // only). The UI-side `TransferEndpoint` union is symmetric — the
  // mutation's input type narrows per slot; `as any` here is the
  // boundary cast. Server-side Zod is the source of truth, and the
  // AdapterPicker already filters the off-slot kinds out of the
  // radio so this can't fire in practice.
  // biome-ignore lint/suspicious/noExplicitAny: see comment above
  const wireSource = source as any;
  // biome-ignore lint/suspicious/noExplicitAny: see comment above
  const wireTarget = target as any;

  const handlePreview = () => {
    setPreview(null);
    previewMutation.mutate({
      source: wireSource,
      target: wireTarget,
      dry_run: true,
      drop_snapshots: dropSnapshots,
    });
  };

  const handleRun = () => {
    setProcessed(0);
    transferMutation.mutate({
      source: wireSource,
      target: wireTarget,
      drop_snapshots: dropSnapshots,
    });
  };

  const safeClose = () => {
    if (inFlight) return;
    transferMutation.reset();
    previewMutation.reset();
    onClose();
  };

  const runLabel = inFlight
    ? "Transferring…"
    : target.adapter === "download"
      ? "Save backup"
      : source.adapter === "upload"
        ? "Restore"
        : "Transfer";

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/60" onClick={safeClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="w-[36rem] max-h-[90vh] overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900 p-6 shadow-xl">
          {summary ? (
            <TransferSummary
              result={summary.result}
              onClose={safeClose}
              targetTouchedConnected={summary.targetTouchedConnected}
            />
          ) : (
            <>
              <h3 className="text-sm font-semibold text-zinc-200">
                Transfer events
              </h3>
              <p className="mt-1 text-xs text-zinc-500">
                Pick a source and a target. Both can be the connected store,
                a CSV file, or per-call PostgreSQL / SQLite credentials.
              </p>

              <div className="mt-4 space-y-3">
                <AdapterPicker
                  role="source"
                  config={source}
                  onChange={setSource}
                  disabled={inFlight}
                  connectedSummary={connectedSummary}
                />
                <AdapterPicker
                  role="target"
                  config={target}
                  onChange={setTarget}
                  disabled={inFlight}
                  connectedSummary={connectedSummary}
                />
              </div>

              <CompactionToggles
                dropSnapshots={dropSnapshots}
                onChangeDropSnapshots={setDropSnapshots}
                disabled={inFlight}
              />

              <div className="mt-4">
                <button
                  onClick={handlePreview}
                  disabled={!canRun || previewMutation.isPending}
                  className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition hover:bg-zinc-800 disabled:opacity-50"
                >
                  {previewMutation.isPending
                    ? "Previewing…"
                    : "Preview (dry-run)"}
                </button>
                {previewMutation.isError && (
                  <p className="mt-2 text-xs text-red-400">
                    {previewMutation.error.message}
                  </p>
                )}
                {preview && <PreviewPanel result={preview} />}
              </div>

              {sameStore && (
                <p className="mt-3 text-xs text-amber-400">
                  Source and target refer to the same store — change one to
                  enable the transfer.
                </p>
              )}
              {connectedNeededButMissing && (
                <p className="mt-3 text-xs text-amber-400">
                  "Connected store" is selected, but no store is connected.
                  Open the connect form first.
                </p>
              )}

              {inFlight && <ProgressBar processed={processed} />}

              {transferMutation.isError && (
                <p className="mt-2 text-xs text-red-400">
                  {transferMutation.error.message}
                </p>
              )}

              <div className="mt-4 flex justify-end gap-2">
                <button
                  onClick={safeClose}
                  disabled={inFlight}
                  className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 transition hover:bg-zinc-800 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleRun}
                  disabled={!canRun}
                  className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {runLabel}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * Structural equality check matching the server's `sameEndpoint`.
 * Two `current` endpoints always match; `upload` and `download` are
 * never reachable on both sides simultaneously; otherwise compare
 * the discriminating fields.
 */
function endpointsEqual(a: TransferEndpoint, b: TransferEndpoint): boolean {
  if (a.adapter !== b.adapter) return false;
  if (a.adapter === "current") return true;
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
 * Whether an endpoint's required fields are populated. Server-side
 * Zod is the source of truth; this is just the run-button gate so
 * we don't ping the API with obviously-incomplete forms.
 */
function endpointReady(c: TransferEndpoint): boolean {
  switch (c.adapter) {
    case "current":
    case "download":
      return true;
    case "upload":
      return c.csv.length > 0;
    case "csv":
    case "sqlite":
      return c.file.trim().length > 0;
    case "pg":
      return (
        c.host.trim().length > 0 &&
        c.database.trim().length > 0 &&
        c.user.trim().length > 0 &&
        c.schema.trim().length > 0 &&
        c.table.trim().length > 0
      );
  }
}
