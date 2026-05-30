/**
 * In-flight restore progress display.
 *
 * When the source is indexed (PostgresStore / SqliteStore), `scan`
 * probes the max id up front (ACT-1133) and the progress events
 * carry `{ processed, id, max_id }` — we render a determinate
 * `id / max_id` bar. Sources that can't expose `max_id` (`CsvFile`)
 * fall back to the running `processed` counter against an
 * indeterminate animation.
 */
export function ProgressBar({
  processed,
  id,
  max_id,
}: {
  processed: number;
  id?: number;
  max_id?: number;
}) {
  const fraction =
    max_id && id ? Math.min(1, Math.max(0, id / max_id)) : undefined;
  return (
    <div className="mt-4">
      <div className="flex items-center justify-between text-xs text-zinc-400">
        <span>
          {fraction !== undefined
            ? `Restoring ${Math.round(fraction * 100)}%`
            : "Restoring…"}
        </span>
        <span className="font-mono text-zinc-300">
          {processed.toLocaleString()}
          {max_id ? ` / ~${max_id.toLocaleString()}` : ""} events
        </span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-zinc-800">
        {fraction !== undefined ? (
          <div
            className="h-full rounded bg-red-500 transition-[width] duration-150"
            style={{ width: `${(fraction * 100).toFixed(1)}%` }}
          />
        ) : (
          <div className="h-full w-1/3 animate-pulse rounded bg-red-500" />
        )}
      </div>
    </div>
  );
}
