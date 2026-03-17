import { Database } from "lucide-react";
import { useEffect, useState } from "react";
import { trpc } from "../trpc.js";

type MonitorProps = {
  onStream?: (stream: string) => void;
  onBlockedCount?: (count: number) => void;
};

export function Monitor({ onStream, onBlockedCount }: MonitorProps) {
  const statusQuery = trpc.drainStatus.useQuery(undefined, {
    staleTime: 2_000,
  });

  const data = statusQuery.data;

  // Report blocked count for tab badge
  useEffect(() => {
    onBlockedCount?.(data?.blocked ?? 0);
  }, [data?.blocked, onBlockedCount]);

  if (!data) {
    return (
      <div className="flex h-48 items-center justify-center text-sm text-zinc-600">
        {statusQuery.isLoading ? "Loading..." : "No drain data available"}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {/* Overview cards */}
      <div className="grid grid-cols-5 gap-3 border-b border-zinc-800 bg-zinc-925 px-4 py-3">
        <Card label="Total" value={data.total} color="text-zinc-200" />
        <Card label="Healthy" value={data.healthy} color="text-emerald-400" />
        <Card
          label="Blocked"
          value={data.blocked}
          color={data.blocked > 0 ? "text-red-400" : "text-zinc-500"}
        />
        <Card
          label="Leased"
          value={data.leased}
          color={data.leased > 0 ? "text-amber-400" : "text-zinc-500"}
        />
        <Card
          label="Lagging"
          value={data.lagging}
          color={data.lagging > 0 ? "text-yellow-400" : "text-zinc-500"}
        />
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Left: blocked + leases */}
        <div className="flex flex-1 flex-col overflow-y-auto border-r border-zinc-800">
          {/* Blocked streams */}
          <div className="border-b border-zinc-800 px-4 py-2">
            <span className="text-[10px] uppercase tracking-wider text-zinc-500">
              Blocked streams
              {data.blockedStreams.length > 0 && (
                <span className="ml-1.5 rounded-full bg-red-900 px-1.5 py-0.5 text-[9px] text-red-400">
                  {data.blockedStreams.length}
                </span>
              )}
            </span>
          </div>
          {data.blockedStreams.length === 0 ? (
            <div className="flex h-24 items-center justify-center text-xs text-zinc-600">
              No blocked streams
            </div>
          ) : (
            data.blockedStreams.map((s) => (
              <BlockedRow
                key={s.stream}
                stream={s.stream}
                source={s.source}
                error={s.error}
                retry={s.retry}
                at={s.at}
                gap={s.gap}
                onStream={onStream}
              />
            ))
          )}

          {/* Active leases */}
          <div className="border-b border-t border-zinc-800 px-4 py-2">
            <span className="text-[10px] uppercase tracking-wider text-zinc-500">
              Active leases
              {data.activeLeases.length > 0 && (
                <span className="ml-1.5 rounded-full bg-amber-900 px-1.5 py-0.5 text-[9px] text-amber-400">
                  {data.activeLeases.length}
                </span>
              )}
            </span>
          </div>
          {data.activeLeases.length === 0 ? (
            <div className="flex h-24 items-center justify-center text-xs text-zinc-600">
              No active leases
            </div>
          ) : (
            data.activeLeases.map((l) => (
              <LeaseRow
                key={l.stream}
                stream={l.stream}
                source={l.source}
                leasedBy={l.leased_by}
                leasedUntil={l.leased_until}
                onStream={onStream}
              />
            ))
          )}
        </div>

        {/* Right: watermark histogram */}
        <div className="flex w-72 shrink-0 flex-col px-4 py-3">
          <span className="mb-3 text-[10px] uppercase tracking-wider text-zinc-500">
            Watermark gap distribution
          </span>
          <div className="flex-1">
            <Histogram buckets={data.histogram} />
          </div>
          <div className="mt-2 text-[10px] text-zinc-600">
            Max event ID: {data.maxEventId.toLocaleString()}
          </div>
        </div>
      </div>
    </div>
  );
}

function Card({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">
        {label}
      </div>
      <div className={`text-2xl font-semibold ${color}`}>{value}</div>
    </div>
  );
}

function BlockedRow({
  stream,
  source,
  error,
  retry,
  at,
  gap,
  onStream,
}: {
  stream: string;
  source: string | null;
  error: string | null;
  retry: number;
  at: number;
  gap: number;
  onStream?: (s: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border-b border-red-900/20 bg-red-950/10">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-3 px-4 py-2 text-left text-xs"
      >
        <span className="min-w-0 flex-1 truncate font-mono text-zinc-300">
          {stream}
          {onStream && (
            <span
              role="button"
              title="Open in Streams"
              className="ml-1 inline-block text-emerald-400/70 transition hover:text-emerald-300"
              onClick={(e) => {
                e.stopPropagation();
                onStream(stream);
              }}
            >
              <Database size={10} className="inline" />
            </span>
          )}
        </span>
        {source && (
          <span className="w-20 shrink-0 truncate text-zinc-600" title={source}>
            ←{source}
          </span>
        )}
        <span className="w-14 shrink-0 text-right font-mono text-yellow-400">
          retry:{retry}
        </span>
        <span className="w-14 shrink-0 text-right font-mono text-zinc-500">
          at:{at}
        </span>
        <span className="w-14 shrink-0 text-right font-mono text-red-400">
          gap:{gap}
        </span>
        <span className="w-4 shrink-0 text-zinc-600">
          {expanded ? "▾" : "▸"}
        </span>
      </button>
      {expanded && error && (
        <div className="border-t border-red-900/20 bg-red-950/20 px-4 py-2">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wider text-zinc-500">
              Error
            </span>
            <button
              onClick={() => void navigator.clipboard.writeText(error)}
              className="text-[10px] text-zinc-600 hover:text-zinc-400"
            >
              Copy
            </button>
          </div>
          <pre className="whitespace-pre-wrap font-mono text-[10px] text-red-300">
            {error}
          </pre>
        </div>
      )}
    </div>
  );
}

function LeaseRow({
  stream,
  source,
  leasedBy,
  leasedUntil,
  onStream,
}: {
  stream: string;
  source: string | null;
  leasedBy: string;
  leasedUntil: string;
  onStream?: (s: string) => void;
}) {
  const until = new Date(leasedUntil);
  const now = new Date();
  const remaining = Math.max(0, until.getTime() - now.getTime());
  const expired = remaining === 0;

  return (
    <div
      className={`flex items-center gap-3 border-b border-zinc-800/50 px-4 py-2 text-xs ${
        expired ? "opacity-50" : ""
      }`}
    >
      <span className="min-w-0 flex-1 truncate font-mono text-zinc-300">
        {stream}
        {onStream && (
          <button
            title="Open in Streams"
            className="ml-1 text-emerald-400/70 transition hover:text-emerald-300"
            onClick={() => onStream(stream)}
          >
            <Database size={10} className="inline" />
          </button>
        )}
      </span>
      {source && (
        <span className="w-20 shrink-0 truncate text-zinc-600" title={source}>
          ←{source}
        </span>
      )}
      <span
        className="w-24 shrink-0 truncate font-mono text-zinc-500"
        title={leasedBy}
      >
        {leasedBy.slice(0, 8)}
      </span>
      <span
        className={`w-16 shrink-0 text-right font-mono ${
          expired
            ? "text-zinc-600"
            : remaining < 2000
              ? "text-orange-400"
              : "text-amber-400"
        }`}
      >
        {expired ? "expired" : `${Math.ceil(remaining / 1000)}s`}
      </span>
    </div>
  );
}

function Histogram({
  buckets,
}: {
  buckets: Array<{ label: string; count: number }>;
}) {
  if (buckets.length === 0) return null;
  const maxCount = Math.max(...buckets.map((b) => b.count), 1);
  const colors = ["#34d399", "#fbbf24", "#f97316", "#ef4444", "#dc2626"];

  return (
    <div className="flex h-full items-end gap-2">
      {buckets.map((b, i) => {
        const height = Math.max(4, (b.count / maxCount) * 100);
        return (
          <div
            key={b.label}
            className="flex flex-1 flex-col items-center gap-1"
          >
            <span className="text-[9px] text-zinc-500">{b.count}</span>
            <div
              className="w-full rounded-t"
              style={{
                height: `${height}%`,
                backgroundColor: colors[Math.min(i, colors.length - 1)],
                opacity: b.count > 0 ? 0.7 : 0.15,
                minHeight: 4,
              }}
            />
            <span className="text-[8px] text-zinc-500">{b.label}</span>
          </div>
        );
      })}
    </div>
  );
}
