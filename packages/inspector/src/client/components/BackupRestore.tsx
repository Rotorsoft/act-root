import { Download, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { useFilterStore } from "../stores/filters.js";
import { trpc } from "../trpc.js";
import { RestoreDialog } from "./restore/index.js";

/**
 * Toolbar entry point for backup + restore (ACT-1128).
 *
 * Thin shell that owns only the two toolbar buttons and the file
 * picker. The destructive flow — compaction toggles, dry-run
 * preview, typed-name gate, progress poll, post-restore summary —
 * lives in {@link RestoreDialog} so each concern is its own
 * component under `components/restore/`. Backup stays inline
 * because it's a single `useMutation` + download — no extra
 * components warrant their own file.
 */
export function BackupRestore() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [filters] = useFilterStore();
  const [file, setFile] = useState<{ name: string; csv: string } | null>(null);

  const { data: status } = trpc.status.useQuery();
  const restoreEnabled = status?.connected === true;
  const target = status?.target ?? "";

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
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      setFile({ name: f.name, csv: reader.result as string });
    };
    reader.readAsText(f);
    // Reset so the same file can be re-selected after a close.
    e.target.value = "";
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
          onClick={() => restoreEnabled && fileRef.current?.click()}
          disabled={!restoreEnabled}
          title={
            restoreEnabled
              ? "Restore events from CSV"
              : "Connect to a store to enable restore"
          }
          className="rounded p-1.5 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-300 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <Upload size={14} />
        </button>
      </div>
      {file && (
        <RestoreDialog
          file={file}
          target={target}
          onClose={() => setFile(null)}
        />
      )}
    </>
  );
}
