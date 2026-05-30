/**
 * Compaction toggles section of the restore dialog (ACT-1128, ACT-1126).
 *
 * `drop_snapshots` drops `__snapshot__` events so the next snap policy
 * regenerates them with current state. `drop_closed_streams` walks the
 * source once upfront for tombstone events and, in the main pass, drops
 * every **pre-close event** for those streams while **keeping the
 * tombstone** — preserving the close gate in the rebuilt store.
 */
export function CompactionToggles({
  dropSnapshots,
  onChangeDropSnapshots,
  dropClosedStreams,
  onChangeDropClosedStreams,
  disabled,
}: {
  dropSnapshots: boolean;
  onChangeDropSnapshots: (v: boolean) => void;
  dropClosedStreams: boolean;
  onChangeDropClosedStreams: (v: boolean) => void;
  disabled: boolean;
}) {
  return (
    <div className="rounded-md border border-zinc-800 p-3">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
        Compaction
      </h4>
      <label className="mt-2 flex cursor-pointer items-start gap-2 text-xs text-zinc-300">
        <input
          type="checkbox"
          checked={dropSnapshots}
          onChange={(e) => onChangeDropSnapshots(e.target.checked)}
          disabled={disabled}
          className="mt-0.5 h-3 w-3 shrink-0"
        />
        <span>Drop snapshots (regenerate on next snap policy)</span>
      </label>
      <label className="mt-1 flex cursor-pointer items-start gap-2 text-xs text-zinc-300">
        <input
          type="checkbox"
          checked={dropClosedStreams}
          onChange={(e) => onChangeDropClosedStreams(e.target.checked)}
          disabled={disabled}
          className="mt-0.5 h-3 w-3 shrink-0"
        />
        <span>Drop closed streams (pre-close events; tombstone preserved)</span>
      </label>
    </div>
  );
}
