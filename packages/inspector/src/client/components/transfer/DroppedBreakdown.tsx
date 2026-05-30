import { XCircle } from "lucide-react";
import type { ScanResult } from "./types.js";

/**
 * Per-category dropped-counter list. Shared between the dry-run
 * preview panel and the post-restore summary panel — both render
 * the same `dropped` shape with the same human framing. Categories
 * with zero counters are hidden so a clean restore doesn't show a
 * row of "Snapshots: 0" lines.
 */
export function DroppedBreakdown({
  dropped,
}: {
  dropped: ScanResult["dropped"];
}) {
  const items = [
    { label: "Snapshots", n: dropped.snapshots },
    { label: "Closed streams", n: dropped.closed_streams },
  ].filter((d) => d.n > 0);
  if (items.length === 0) return null;
  return (
    <ul className="mt-2 space-y-0.5 text-xs text-zinc-400">
      {items.map((d) => (
        <li key={d.label} className="flex items-center gap-2">
          <XCircle size={12} className="text-zinc-500" />
          <span>
            {d.label}: <span className="font-mono">{d.n.toLocaleString()}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
