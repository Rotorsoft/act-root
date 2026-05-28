import { useEffect, useState } from "react";
import { queryClient, trpc } from "../../trpc.js";
import { CompactionToggles } from "./CompactionToggles.js";
import { DestructiveGate } from "./DestructiveGate.js";
import { PreviewPanel } from "./PreviewPanel.js";
import { ProgressBar } from "./ProgressBar.js";
import { RestoreSummary } from "./RestoreSummary.js";
import type { ScanResult } from "./types.js";

/**
 * Stateful restore dialog (ACT-1128).
 *
 * Drives the four stages of a restore — toggle, preview, confirm,
 * progress, summary — by composing the per-concern subcomponents
 * around the two tRPC mutations (`restore` for both dry-run and
 * destructive paths) and the `restoreProgress` poll. The dialog
 * itself owns no event-shape knowledge; it just shuffles strings
 * and counts between the children.
 *
 * Closed by the parent when `file === null`; the parent reopens it
 * by selecting a new CSV.
 */
export function RestoreDialog({
  file,
  target,
  onClose,
}: {
  file: { name: string; csv: string };
  target: string;
  onClose: () => void;
}) {
  const [dropSnapshots, setDropSnapshots] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [preview, setPreview] = useState<ScanResult | null>(null);
  const [summary, setSummary] = useState<ScanResult | null>(null);

  const restoreMutation = trpc.restore.useMutation({
    onSuccess(data) {
      setSummary(data.result);
      void queryClient.invalidateQueries();
    },
  });
  const previewMutation = trpc.restore.useMutation({
    onSuccess(data) {
      setPreview(data.result);
    },
    onError() {
      setPreview(null);
    },
  });

  // Reactive progress via SSE — server pushes a `{ processed }`
  // event on every `Act.restore` `on_progress` tick. We subscribe
  // only while the destructive mutation is in flight; the
  // subscription tears down via `AbortSignal` once enabled flips
  // false (e.g., on dialog close or completion).
  const [processed, setProcessed] = useState(0);
  trpc.restoreProgress.useSubscription(undefined, {
    enabled: restoreMutation.isPending,
    onData: (event) => setProcessed(event.processed),
  });

  // Compaction-toggle changes invalidate any prior preview, since
  // the preview's counts assumed the old flag values. Forcing a
  // re-preview is cheaper than rendering stale data.
  useEffect(() => {
    setPreview(null);
  }, [dropSnapshots]);

  const inFlight = restoreMutation.isPending;
  const nameMatches = confirmName === target && target.length > 0;

  const handlePreview = () => {
    setPreview(null);
    previewMutation.mutate({
      csv: file.csv,
      dry_run: true,
      drop_snapshots: dropSnapshots,
    });
  };

  const handleRestore = () => {
    // Reset the progress counter — a previous failed run's last
    // reading shouldn't leak into the new run's progress bar.
    setProcessed(0);
    restoreMutation.mutate({
      csv: file.csv,
      drop_snapshots: dropSnapshots,
    });
  };

  const safeClose = () => {
    if (inFlight) return;
    restoreMutation.reset();
    previewMutation.reset();
    onClose();
  };

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/60" onClick={safeClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="w-[28rem] max-h-[90vh] overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900 p-6 shadow-xl">
          {summary ? (
            <RestoreSummary result={summary} onClose={safeClose} />
          ) : (
            <>
              <h3 className="text-sm font-semibold text-zinc-200">
                Restore from CSV
              </h3>
              <p className="mt-1 text-xs text-zinc-500">
                Source:{" "}
                <span className="font-mono text-zinc-300">{file.name}</span>
              </p>

              <CompactionToggles
                dropSnapshots={dropSnapshots}
                onChangeDropSnapshots={setDropSnapshots}
                disabled={inFlight}
              />

              <div className="mt-4">
                <button
                  onClick={handlePreview}
                  disabled={previewMutation.isPending || inFlight}
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

              <DestructiveGate
                target={target}
                value={confirmName}
                onChange={setConfirmName}
                disabled={inFlight}
              />

              {inFlight && <ProgressBar processed={processed} />}

              {restoreMutation.isError && (
                <p className="mt-2 text-xs text-red-400">
                  {restoreMutation.error.message}
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
                  onClick={handleRestore}
                  disabled={!nameMatches || inFlight}
                  className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {inFlight ? "Restoring..." : "Wipe & Restore"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
