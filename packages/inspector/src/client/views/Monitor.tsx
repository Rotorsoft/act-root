import { Database } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { trpc } from "../trpc.js";

type MonitorProps = {
  onStream?: (stream: string) => void;
  onBlockedCount?: (count: number) => void;
};

export function Monitor({ onStream, onBlockedCount }: MonitorProps) {
  const statusQuery = trpc.drainStatus.useQuery(undefined, {
    staleTime: 2_000,
  });
  // Write-mode + audit log (#698 slice 5). Both refresh on a mutation
  // commit through `useUtils().audit.invalidate()` from the
  // PriorityCell on the Streams view.
  const writeModeQuery = trpc.writeMode.useQuery(undefined, {
    staleTime: Infinity,
  });
  const auditQuery = trpc.audit.useQuery(undefined, {
    staleTime: 2_000,
    refetchInterval: 5_000,
  });
  const writeEnabled = writeModeQuery.data?.enabled ?? false;

  // Active priority + lane filters. Clicking a badge in the histogram
  // row sets the filter; clicking it again (or the "all" chip) clears
  // it. Filters apply to both the blocked-streams and active-leases
  // lists below so an operator can drill from "5 streams at priority
  // 10" to the actual rows.
  const [priorityFilter, setPriorityFilter] = useState<number | null>(null);
  const [laneFilter, setLaneFilter] = useState<string | null>(null);

  const data = statusQuery.data;

  // Report blocked count for tab badge
  useEffect(() => {
    onBlockedCount?.(data?.blocked ?? 0);
  }, [data?.blocked, onBlockedCount]);

  const matches = (row: { priority: number; lane: string | null }) =>
    (priorityFilter === null || row.priority === priorityFilter) &&
    (laneFilter === null || (row.lane ?? "default") === laneFilter);

  const filteredBlocked = useMemo(
    () => (data?.blockedStreams ?? []).filter(matches),
    [data?.blockedStreams, priorityFilter, laneFilter]
  );
  const filteredLeases = useMemo(
    () => (data?.activeLeases ?? []).filter(matches),
    [data?.activeLeases, priorityFilter, laneFilter]
  );

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

      {/* Priority + lane filter chips. Skip the row entirely when there's
          nothing interesting to show — i.e., everything is on default
          priority 0 AND lane "default". */}
      {(data.priorityCounts.length > 1 || data.laneCounts.length > 1) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-zinc-800 bg-zinc-925 px-4 py-2">
          {data.priorityCounts.length > 1 && (
            <FilterChips
              label="Priority"
              entries={data.priorityCounts.map(({ priority, count }) => ({
                key: priority,
                label: priority === 0 ? "p=0" : `p=${priority}`,
                count,
                tone: priority === 0 ? "muted" : "amber",
              }))}
              active={priorityFilter}
              onPick={setPriorityFilter}
            />
          )}
          {data.laneCounts.length > 1 && (
            <FilterChips
              label="Lane"
              entries={data.laneCounts.map(({ lane, count }) => ({
                key: lane,
                label: lane,
                count,
                tone: lane === "default" ? "muted" : "violet",
              }))}
              active={laneFilter}
              onPick={setLaneFilter}
            />
          )}
        </div>
      )}

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
          {filteredBlocked.length === 0 ? (
            <div className="flex h-24 items-center justify-center text-xs text-zinc-600">
              {data.blockedStreams.length === 0
                ? "No blocked streams"
                : "None match the active filter"}
            </div>
          ) : (
            filteredBlocked.map((s) => (
              <BlockedRow
                key={s.stream}
                stream={s.stream}
                source={s.source}
                error={s.error}
                retry={s.retry}
                at={s.at}
                gap={s.gap}
                priority={s.priority}
                lane={s.lane}
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
          {filteredLeases.length === 0 ? (
            <div className="flex h-24 items-center justify-center text-xs text-zinc-600">
              {data.activeLeases.length === 0
                ? "No active leases"
                : "None match the active filter"}
            </div>
          ) : (
            filteredLeases.map((l) => (
              <LeaseRow
                key={l.stream}
                stream={l.stream}
                source={l.source}
                leasedBy={l.leased_by}
                leasedUntil={l.leased_until}
                priority={l.priority}
                lane={l.lane}
                onStream={onStream}
              />
            ))
          )}
        </div>

        {/* Right: watermark histogram + audit log */}
        <div className="flex w-72 shrink-0 flex-col gap-3 px-4 py-3">
          <div className="flex flex-col">
            <span className="mb-3 text-[10px] uppercase tracking-wider text-zinc-500">
              Watermark gap distribution
            </span>
            <div className="h-32">
              <Histogram buckets={data.histogram} />
            </div>
            <div className="mt-2 text-[10px] text-zinc-600">
              Max event ID: {data.maxEventId.toLocaleString()}
            </div>
          </div>
          <AuditPanel
            writeEnabled={writeEnabled}
            entries={auditQuery.data?.entries ?? []}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Right-side panel surfacing inspector-driven mutations (#698 slice
 * 5). Shows the read-only-mode reason when writes are gated; otherwise
 * lists the last 10 audit entries with timestamp + action + affected
 * count. Cleared on server restart — this is operational breadcrumbs,
 * not a compliance log.
 */
function AuditPanel({
  writeEnabled,
  entries,
}: {
  writeEnabled: boolean;
  entries: ReadonlyArray<{
    timestamp: string;
    action: string;
    filter: Record<string, unknown>;
    priority: number;
    affected: number;
  }>;
}) {
  return (
    <div className="flex flex-1 flex-col border-t border-zinc-800 pt-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-zinc-500">
          Recent mutations
        </span>
        <span
          className={`rounded-full border px-1.5 py-0 text-[9px] font-mono ${
            writeEnabled
              ? "border-emerald-700 bg-emerald-950/40 text-emerald-300"
              : "border-zinc-700 bg-zinc-900 text-zinc-500"
          }`}
          title={
            writeEnabled
              ? "Inspector is in write mode"
              : "Set ACT_INSPECTOR_WRITE=1 on the server to enable mutations"
          }
        >
          {writeEnabled ? "write" : "read-only"}
        </span>
      </div>
      {entries.length === 0 ? (
        <div className="text-[10px] text-zinc-600">
          {writeEnabled
            ? "No mutations recorded this session."
            : "Read-only — no mutations possible."}
        </div>
      ) : (
        <ul className="flex flex-col gap-1.5 overflow-y-auto text-[10px]">
          {entries.slice(0, 10).map((e, i) => (
            <li
              key={`${e.timestamp}-${i}`}
              className="rounded border border-zinc-800 bg-zinc-950 px-2 py-1.5"
            >
              <div className="flex items-center justify-between text-zinc-500">
                <span className="font-mono">{e.action}</span>
                <span>{new Date(e.timestamp).toLocaleTimeString()}</span>
              </div>
              <div className="mt-1 font-mono text-zinc-300">
                p={e.priority}{" "}
                <span className="text-zinc-600">→</span>{" "}
                <span className="text-amber-300">{e.affected} streams</span>
              </div>
              <div
                className="truncate font-mono text-[9px] text-zinc-600"
                title={JSON.stringify(e.filter)}
              >
                {Object.keys(e.filter).length === 0
                  ? "all streams"
                  : JSON.stringify(e.filter)}
              </div>
            </li>
          ))}
        </ul>
      )}
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

/**
 * Histogram-as-filter chip group. Renders a "Priority" or "Lane"
 * label followed by one chip per (key, count) pair. Clicking a chip
 * sets the parent's filter; clicking the active chip clears it.
 *
 * Tone drives the colour family: "muted" (default lane / priority 0)
 * uses zinc so it sinks; "amber" (non-default priority) and "violet"
 * (non-default lane) match the corresponding column hues on the
 * Streams view, so the same concept reads the same across views.
 */
function FilterChips<K extends string | number>({
  label,
  entries,
  active,
  onPick,
}: {
  label: string;
  entries: Array<{
    key: K;
    label: string;
    count: number;
    tone: "muted" | "amber" | "violet";
  }>;
  active: K | null;
  onPick: (value: K | null) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] uppercase tracking-wider text-zinc-500">
        {label}
      </span>
      {entries.map((e) => {
        const isActive = active === e.key;
        const base =
          e.tone === "muted"
            ? "border-zinc-700 bg-zinc-900 text-zinc-500"
            : e.tone === "amber"
              ? "border-amber-800 bg-amber-950/40 text-amber-300"
              : "border-violet-800 bg-violet-950/40 text-violet-300";
        return (
          <button
            key={String(e.key)}
            onClick={() => onPick(isActive ? null : e.key)}
            className={`rounded-full border px-2 py-0.5 text-[10px] font-mono transition ${base} ${
              isActive ? "ring-1 ring-emerald-500/70" : "opacity-80 hover:opacity-100"
            }`}
            title={isActive ? "Click to clear filter" : "Click to filter"}
          >
            {e.label} <span className="opacity-60">·{e.count}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Inline chip for a stream's lane on Monitor rows. Default lane sinks
 * to muted grey; non-default lanes render in the same violet hue used
 * on the Streams view and in the drain trace, so "this lane" reads the
 * same everywhere. Always renders so the row width stays stable.
 */
function LaneChip({ lane }: { lane: string | null }) {
  const name = lane ?? "default";
  const styled =
    lane && lane !== "default"
      ? "border-violet-800 bg-violet-950/40 text-violet-300"
      : "border-zinc-800 bg-zinc-900 text-zinc-600";
  return (
    <span
      className={`w-20 shrink-0 truncate rounded border px-1.5 py-0 text-center font-mono text-[10px] ${styled}`}
      title={lane ? `lane: ${lane}` : "default lane"}
    >
      {name}
    </span>
  );
}

/**
 * Inline chip for a stream's scheduling priority. Default 0 sinks to
 * muted grey; non-zero pops in amber to match the Streams view column.
 */
function PriorityChip({ priority }: { priority: number }) {
  const styled =
    priority !== 0
      ? "border-amber-800 bg-amber-950/40 text-amber-300"
      : "border-zinc-800 bg-zinc-900 text-zinc-600";
  return (
    <span
      className={`w-12 shrink-0 rounded border px-1.5 py-0 text-center font-mono text-[10px] ${styled}`}
      title={`priority: ${priority}`}
    >
      p={priority}
    </span>
  );
}

function BlockedRow({
  stream,
  source,
  error,
  retry,
  at,
  gap,
  priority,
  lane,
  onStream,
}: {
  stream: string;
  source: string | null;
  error: string | null;
  retry: number;
  at: number;
  gap: number;
  priority: number;
  lane: string | null;
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
        <LaneChip lane={lane} />
        <PriorityChip priority={priority} />
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
  priority,
  lane,
  onStream,
}: {
  stream: string;
  source: string | null;
  leasedBy: string;
  leasedUntil: string;
  priority: number;
  lane: string | null;
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
      <LaneChip lane={lane} />
      <PriorityChip priority={priority} />
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
