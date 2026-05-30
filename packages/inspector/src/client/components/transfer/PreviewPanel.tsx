import { CheckCircle2, X } from "lucide-react";
import { EventTable } from "../EventTable.js";
import { DroppedBreakdown } from "./DroppedBreakdown.js";
import type { ScanResult } from "./types.js";

type SampleEvent = {
  id: number;
  name: string;
  stream: string;
  version: number;
  created: string;
  data: unknown;
  meta: Record<string, unknown>;
};

/**
 * Dry-run preview modal — opens *over* the restore wizard so the
 * sample event table has room to breathe. Shows the `ScanResult`
 * counts on top, then the first N post-transform events captured
 * by the server's `PreviewSink`. The configured target is never
 * touched: no file written, no transaction opened.
 *
 * The wizard stays mounted underneath, so closing the preview
 * returns the operator straight to the Summary step with the same
 * selections.
 */
export function PreviewPanel({
  result,
  sample,
  onClose,
}: {
  result: ScanResult;
  sample: SampleEvent[];
  onClose: () => void;
}) {
  return (
    <>
      <div
        className="fixed inset-0 z-[60] bg-black/70"
        onClick={onClose}
      />
      <div className="fixed inset-0 z-[70] flex items-center justify-center p-6">
        <div
          className="flex h-[80vh] w-[min(64rem,95vw)] flex-col overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
            <div className="flex items-center gap-2 text-xs">
              <CheckCircle2 size={14} className="text-emerald-400" />
              <span className="font-semibold text-zinc-200">
                Dry-run preview
              </span>
              <span className="text-zinc-500">
                · {result.kept.toLocaleString()} events would land
              </span>
            </div>
            <button
              onClick={onClose}
              className="rounded p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-300"
              aria-label="Close preview"
            >
              <X size={14} />
            </button>
          </div>

          <div className="border-b border-zinc-800 px-4 py-3">
            <DroppedBreakdown dropped={result.dropped} />
          </div>

          <div className="border-b border-zinc-800 px-4 py-2 text-[10px] uppercase tracking-wider text-zinc-500">
            {sample.length > 0
              ? `Sample — first ${sample.length} of ${result.kept.toLocaleString()} (post-migration)`
              : "Sample"}
          </div>

          <div className="flex min-h-0 flex-1 flex-col">
            <EventTable
              events={sample}
              emptyMessage="No events captured in the dry-run sample."
            />
          </div>
        </div>
      </div>
    </>
  );
}
