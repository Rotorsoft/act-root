import { useFilterStore } from "../stores/filters.js";
import { trpc } from "../trpc.js";

export function StatsBar() {
  const [filters] = useFilterStore();

  const statsQuery = trpc.stats.useQuery(
    {
      stream: filters.stream,
      names: filters.names,
      created_after: filters.created_after,
      created_before: filters.created_before,
      correlation: filters.correlation,
    },
    { staleTime: 5_000 }
  );

  const stats = statsQuery.data;

  return (
    <div className="flex items-center gap-6 border-b border-zinc-800 bg-zinc-925 px-4 py-2 text-xs text-zinc-400">
      {statsQuery.isLoading ? (
        <span className="text-zinc-600">Loading stats...</span>
      ) : stats ? (
        <>
          <Stat label="Events" value={stats.totalEvents.toLocaleString()} />
          <Stat label="Streams" value={stats.uniqueStreams.toLocaleString()} />
          <Stat
            label="Event Types"
            value={stats.uniqueEventNames.toLocaleString()}
          />
          {stats.timeSpan && (
            <Stat
              label="Time Span"
              value={formatTimeSpan(stats.timeSpan.from, stats.timeSpan.to)}
            />
          )}
        </>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-zinc-500">{label}</span>
      <span className="font-medium text-zinc-200">{value}</span>
    </div>
  );
}

function formatTimeSpan(from: string, to: string): string {
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}
