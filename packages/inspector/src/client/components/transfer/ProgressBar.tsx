/**
 * In-flight restore progress display (ACT-1128).
 *
 * The source is async-iterable — we don't know the total event count
 * up front — so this renders an indeterminate animation with a
 * running `processed` counter rather than a percent-complete bar.
 * The counter updates at ~5Hz off the parent's poll on
 * `restoreProgress`, which is plenty for human-visible cadence on a
 * million-event restore without flooding the network.
 */
export function ProgressBar({ processed }: { processed: number }) {
  return (
    <div className="mt-4">
      <div className="flex items-center justify-between text-xs text-zinc-400">
        <span>Restoring…</span>
        <span className="font-mono text-zinc-300">
          {processed.toLocaleString()} events
        </span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-zinc-800">
        <div className="h-full w-1/3 animate-pulse rounded bg-red-500" />
      </div>
    </div>
  );
}
