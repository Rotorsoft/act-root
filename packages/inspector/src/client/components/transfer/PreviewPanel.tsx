import { CheckCircle2 } from "lucide-react";
import { DroppedBreakdown } from "./DroppedBreakdown.js";
import type { ScanResult } from "./types.js";

/**
 * Dry-run preview panel — renders the `ScanResult` from a
 * `restore({ dry_run: true })` call so the operator sees what would
 * land before committing to the destructive path. No store touch,
 * no transaction, no audit-log entry on the server side.
 */
export function PreviewPanel({ result }: { result: ScanResult }) {
  return (
    <div className="mt-2 rounded-md border border-zinc-800 bg-zinc-950 p-3">
      <div className="flex items-center gap-2 text-xs">
        <CheckCircle2 size={14} className="text-emerald-400" />
        <span className="text-zinc-300">
          Source validates — {result.kept.toLocaleString()} events would land
        </span>
      </div>
      <DroppedBreakdown dropped={result.dropped} />
    </div>
  );
}
