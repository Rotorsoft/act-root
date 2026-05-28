import { CheckCircle2 } from "lucide-react";
import { DroppedBreakdown } from "./DroppedBreakdown.js";
import type { ScanResult } from "./types.js";

/**
 * Post-transfer summary panel (ACT-1128).
 *
 * Renders the final `ScanResult` plus the post-transfer operator
 * reminder when the target was the connected store: rebuildable
 * projections still carry pre-transfer watermarks and need
 * `app.reset(targets)` from app code to replay against the new
 * event log. The framework can't do this from the inspector —
 * `Act.reset` is the orchestrator's job — so the UI surfaces the
 * obligation when it applies.
 */
export function TransferSummary({
  result,
  onClose,
  targetTouchedConnected,
}: {
  result: ScanResult;
  onClose: () => void;
  targetTouchedConnected: boolean;
}) {
  const totalDropped =
    result.dropped.closed_streams +
    result.dropped.snapshots +
    result.dropped.empty_streams;
  return (
    <>
      <div className="flex items-center gap-2">
        <CheckCircle2 size={18} className="text-emerald-400" />
        <h3 className="text-sm font-semibold text-zinc-200">
          Transfer complete
        </h3>
      </div>
      <div className="mt-3 space-y-1 text-xs text-zinc-300">
        <p>
          Kept:{" "}
          <span className="font-mono text-zinc-100">
            {result.kept.toLocaleString()}
          </span>{" "}
          events
        </p>
        {totalDropped > 0 && (
          <p>
            Dropped:{" "}
            <span className="font-mono text-zinc-100">
              {totalDropped.toLocaleString()}
            </span>{" "}
            events
          </p>
        )}
        <p>
          Duration:{" "}
          <span className="font-mono text-zinc-100">
            {result.duration_ms.toLocaleString()}ms
          </span>
        </p>
      </div>
      <DroppedBreakdown dropped={result.dropped} />
      {targetTouchedConnected && (
        <div className="mt-4 rounded-md border border-amber-900/40 bg-amber-950/20 p-3 text-xs text-amber-200">
          <p className="font-semibold">Post-transfer reminder</p>
          <p className="mt-1 text-amber-300/80">
            The connected store was rewritten. Rebuildable projections may
            carry pre-transfer watermarks — call{" "}
            <span className="font-mono">app.reset(targets)</span> from your app
            code to replay them against the new event log.
          </p>
        </div>
      )}
      <div className="mt-4 flex justify-end">
        <button
          onClick={onClose}
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition hover:bg-zinc-800"
        >
          Close
        </button>
      </div>
    </>
  );
}
