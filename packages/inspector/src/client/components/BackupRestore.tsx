import { Download, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { useFilterStore } from "../stores/filters.js";
import { queryClient, trpc } from "../trpc.js";

export function BackupRestore() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [filters] = useFilterStore();
  const [restoring, setRestoring] = useState(false);
  const [confirm, setConfirm] = useState<{
    fileName: string;
    csv: string;
  } | null>(null);

  const backupMutation = trpc.backup.useMutation({
    onSuccess(data) {
      const blob = new Blob([data.csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      a.download = `act-backup-${ts}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    },
  });

  const restoreMutation = trpc.restore.useMutation({
    onSuccess() {
      setConfirm(null);
      setRestoring(false);
      void queryClient.invalidateQueries();
    },
    onError() {
      setRestoring(false);
    },
  });

  const handleBackup = () => {
    const hasFilters =
      filters.stream ||
      (filters.names && filters.names.length > 0) ||
      filters.created_after ||
      filters.created_before ||
      filters.correlation;

    backupMutation.mutate({
      stream: filters.stream || undefined,
      names:
        filters.names && filters.names.length > 0 ? filters.names : undefined,
      created_after: hasFilters ? filters.created_after : undefined,
      created_before: hasFilters ? filters.created_before : undefined,
      correlation: filters.correlation || undefined,
    });
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setConfirm({ fileName: file.name, csv: reader.result as string });
    };
    reader.readAsText(file);
    // Reset so the same file can be re-selected
    e.target.value = "";
  };

  const handleRestore = () => {
    if (!confirm) return;
    setRestoring(true);
    restoreMutation.mutate({ csv: confirm.csv });
  };

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept=".csv"
        className="hidden"
        onChange={handleFileSelect}
      />

      <div className="flex items-center gap-1">
        <button
          onClick={handleBackup}
          disabled={backupMutation.isPending}
          title="Backup events to CSV"
          className="rounded p-1.5 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-300 disabled:opacity-50"
        >
          <Download size={14} />
        </button>
        <button
          onClick={() => fileRef.current?.click()}
          title="Restore events from CSV"
          className="rounded p-1.5 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-300"
        >
          <Upload size={14} />
        </button>
      </div>

      {/* Confirmation dialog */}
      {confirm && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/60"
            onClick={() => !restoring && setConfirm(null)}
          />
          <div className="fixed inset-0 z-50 flex items-center justify-center">
            <div className="w-96 rounded-lg border border-zinc-700 bg-zinc-900 p-6 shadow-xl">
              <h3 className="text-sm font-semibold text-zinc-200">
                Restore from CSV
              </h3>
              <p className="mt-2 text-xs text-zinc-400">
                This will{" "}
                <span className="font-semibold text-red-400">
                  delete all existing events
                </span>{" "}
                and replace them with the contents of:
              </p>
              <p className="mt-1 text-xs font-mono text-zinc-300">
                {confirm.fileName}
              </p>
              <p className="mt-2 text-xs text-zinc-500">
                Event IDs will be re-assigned starting from 1.
              </p>

              {restoreMutation.isError && (
                <p className="mt-2 text-xs text-red-400">
                  {restoreMutation.error.message}
                </p>
              )}

              <div className="mt-4 flex justify-end gap-2">
                <button
                  onClick={() => setConfirm(null)}
                  disabled={restoring}
                  className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 transition hover:bg-zinc-800 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleRestore}
                  disabled={restoring}
                  className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-red-500 disabled:opacity-50"
                >
                  {restoring ? "Restoring..." : "Delete & Restore"}
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}
