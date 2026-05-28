/**
 * Compaction toggles section of the restore dialog (ACT-1128).
 *
 * Only `drop_snapshots` is wired today — `drop_closed_streams` and
 * `drop_empty_streams` are reserved fields in `ScanOptions` that
 * land with ACT-1126 (#785). Rendering them as disabled-with-tooltip
 * is intentional: it tells the operator the toggle exists in the UI
 * surface before the underlying flag does, and the eventual wiring
 * is a one-line change here rather than a dialog re-layout.
 */
export function CompactionToggles({
  dropSnapshots,
  onChangeDropSnapshots,
  disabled,
}: {
  dropSnapshots: boolean;
  onChangeDropSnapshots: (v: boolean) => void;
  disabled: boolean;
}) {
  return (
    <div className="mt-4 rounded-md border border-zinc-800 p-3">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
        Compaction
      </h4>
      <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs text-zinc-300">
        <input
          type="checkbox"
          checked={dropSnapshots}
          onChange={(e) => onChangeDropSnapshots(e.target.checked)}
          disabled={disabled}
          className="h-3 w-3"
        />
        Drop snapshots (regenerate on next snap policy)
      </label>
      <label
        className="mt-1 flex items-center gap-2 text-xs text-zinc-600"
        title="Reserved for ACT-1126 (#785)"
      >
        <input
          type="checkbox"
          disabled
          className="h-3 w-3 cursor-not-allowed"
        />
        Drop closed streams (deferred — #785)
      </label>
      <label
        className="mt-1 flex items-center gap-2 text-xs text-zinc-600"
        title="Reserved for ACT-1126 (#785)"
      >
        <input
          type="checkbox"
          disabled
          className="h-3 w-3 cursor-not-allowed"
        />
        Drop empty streams (deferred — #785)
      </label>
    </div>
  );
}
