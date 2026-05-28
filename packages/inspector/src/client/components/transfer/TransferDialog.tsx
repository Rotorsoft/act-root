import { useEffect, useState } from "react";
import { queryClient, trpc } from "../../trpc.js";
import { CompactionToggles } from "../restore/CompactionToggles.js";
import { PreviewPanel } from "../restore/PreviewPanel.js";
import { ProgressBar } from "../restore/ProgressBar.js";
import { RestoreSummary } from "../restore/RestoreSummary.js";
import type { ScanResult } from "../restore/types.js";
import { AdapterPicker } from "./AdapterPicker.js";
import { TRANSFER_DEFAULTS, type TransferConfig } from "./types.js";

/**
 * Cross-source / cross-target transfer dialog (ACT-1128 + #788).
 *
 * Two `AdapterPicker` panels (source + target) feed a single
 * `transfer` tRPC mutation. Subcomponents from the existing
 * `components/restore/` module are reused for compaction toggles,
 * preview rendering, progress, and the post-transfer summary —
 * keeping a single visual language across both flows.
 *
 * No typed-name confirmation here: the transfer doesn't touch the
 * inspector's connected store, so a destructive "type the name"
 * gate would be misleading. The server-side `sameAdapter` guard
 * catches the only truly-destructive case (transfer onto self) by
 * deep-equaling the configs.
 */
export function TransferDialog({ onClose }: { onClose: () => void }) {
  const [source, setSource] = useState<TransferConfig>(TRANSFER_DEFAULTS.pg);
  const [target, setTarget] = useState<TransferConfig>(TRANSFER_DEFAULTS.csv);
  const [dropSnapshots, setDropSnapshots] = useState(false);
  const [preview, setPreview] = useState<ScanResult | null>(null);
  const [summary, setSummary] = useState<ScanResult | null>(null);

  const transferMutation = trpc.transfer.useMutation({
    onSuccess(data) {
      setSummary(data.result);
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

  // Reactive progress — same SSE subscription as `restore`.
  const [processed, setProcessed] = useState(0);
  trpc.restoreProgress.useSubscription(undefined, {
    enabled: transferMutation.isPending,
    onData: (event) => setProcessed(event.processed),
  });

  // Invalidate the preview when the configs or compaction toggles
  // change — counts assumed the old shape.
  useEffect(() => {
    setPreview(null);
  }, [source, target, dropSnapshots]);

  const inFlight = transferMutation.isPending;
  const sameStore = JSON.stringify(source) === JSON.stringify(target);
  const sourceValid = configValid(source);
  const targetValid = configValid(target);
  const canRun = !sameStore && sourceValid && targetValid && !inFlight;

  const handlePreview = () => {
    setPreview(null);
    previewMutation.mutate({
      source,
      target,
      dry_run: true,
      drop_snapshots: dropSnapshots,
    });
  };

  const handleRun = () => {
    setProcessed(0);
    transferMutation.mutate({
      source,
      target,
      drop_snapshots: dropSnapshots,
    });
  };

  const safeClose = () => {
    if (inFlight) return;
    transferMutation.reset();
    previewMutation.reset();
    onClose();
  };

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/60" onClick={safeClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="w-[36rem] max-h-[90vh] overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900 p-6 shadow-xl">
          {summary ? (
            <RestoreSummary result={summary} onClose={safeClose} />
          ) : (
            <>
              <h3 className="text-sm font-semibold text-zinc-200">
                Transfer events between adapters
              </h3>
              <p className="mt-1 text-xs text-zinc-500">
                Both ends are accessed ephemerally — your active store
                connection is untouched.
              </p>

              <div className="mt-4 space-y-3">
                <AdapterPicker
                  label="Source"
                  config={source}
                  onChange={setSource}
                  disabled={inFlight}
                />
                <AdapterPicker
                  label="Target"
                  config={target}
                  onChange={setTarget}
                  disabled={inFlight}
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
                    ? "Previewing..."
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
                  enable transfer.
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
                  {inFlight ? "Transferring..." : "Transfer"}
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
 * Client-side validation for the run-button enable state. Server-
 * side Zod is the source of truth; this is just to avoid pinging
 * the API with obviously-incomplete forms. Mirrors the required
 * fields on each adapter shape.
 */
function configValid(c: TransferConfig): boolean {
  if (c.adapter === "csv") return c.file.trim().length > 0;
  if (c.adapter === "sqlite") return c.file.trim().length > 0;
  return (
    c.host.trim().length > 0 &&
    c.database.trim().length > 0 &&
    c.user.trim().length > 0 &&
    c.schema.trim().length > 0 &&
    c.table.trim().length > 0
  );
}
