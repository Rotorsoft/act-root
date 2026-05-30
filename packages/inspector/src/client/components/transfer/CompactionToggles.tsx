/**
 * Compaction toggles section of the restore dialog (ACT-1128, ACT-1126).
 *
 * `drop_snapshots` drops `__snapshot__` events so the next snap policy
 * regenerates them with current state. `drop_closed_streams` walks the
 * source once upfront for tombstone events and drops every event from
 * those streams in the main pass (including the tombstones themselves).
 *
 * There is no `drop_empty_streams` — empty streams have zero events
 * and never appear in an event scan to begin with.
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
      <label className="mt-1 flex cursor-pointer items-center gap-2 text-xs text-zinc-300">
        <input
          type="checkbox"
          checked={dropClosedStreams}
          onChange={(e) => onChangeDropClosedStreams(e.target.checked)}
          disabled={disabled}
          className="h-3 w-3"
        />
        Drop closed streams (tombstoned + all pre-close events)
      </label>
    </div>
  );
}
