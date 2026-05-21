import { useMemo, useState } from "react";
import { EventRow } from "../components/EventRow.js";
import { trpc } from "../trpc.js";

type StreamRow = {
  stream: string;
  eventCount: number;
  lastEvent: string;
  firstEvent: string | null;
  currentVersion: number;
  isClosed?: boolean;
  // Joined from streamMeta (#698 slice 2). Null when the stream has no
  // subscription row yet — i.e., no reaction targets it, so it has no
  // priority or lane assignment. Default zero / "default" inferred.
  priority: number;
  lane: string | null;
};

type SortKey =
  | "stream"
  | "eventCount"
  | "currentVersion"
  | "lastEvent"
  | "firstEvent"
  | "priority"
  | "lane";

const STALE_DAY_OPTIONS = [7, 14, 30, 90];

/**
 * Inline-editable scheduling priority cell on the Streams view (#698
 * slice 5). Click the value to switch into a numeric input;
 * Enter / blur commits via `Store.prioritize({stream_exact:true})`.
 * Esc reverts. When write mode is off the cell stays display-only and
 * surfaces the reason in the tooltip.
 *
 * Width stays fixed across the display and edit modes so the row
 * doesn't reflow mid-edit.
 */
function PriorityCell({
  stream,
  priority,
  writeEnabled,
  writeDisabledReason,
  pending,
  onCommit,
}: {
  stream: string;
  priority: number;
  writeEnabled: boolean;
  writeDisabledReason: string;
  pending: boolean;
  onCommit: (value: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(priority));

  const baseClass = `w-12 shrink-0 text-right font-mono ${priority !== 0 ? "text-amber-400" : "text-zinc-700"}`;

  if (!writeEnabled) {
    return (
      <span
        className={baseClass}
        title={`priority: ${priority} — ${writeDisabledReason}`}
      >
        {priority}
      </span>
    );
  }

  if (!editing) {
    return (
      <span
        role="button"
        tabIndex={0}
        onClick={(e) => {
          e.stopPropagation();
          setDraft(String(priority));
          setEditing(true);
        }}
        className={`${baseClass} cursor-text hover:text-emerald-300 hover:underline`}
        title={
          pending
            ? `Updating priority for ${stream}…`
            : `priority: ${priority} — click to edit`
        }
      >
        {pending ? "…" : priority}
      </span>
    );
  }

  const commit = () => {
    const parsed = Number.parseInt(draft, 10);
    if (Number.isFinite(parsed) && parsed !== priority) onCommit(parsed);
    setEditing(false);
  };

  return (
    <input
      type="number"
      autoFocus
      value={draft}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          setEditing(false);
        }
      }}
      className="w-12 shrink-0 rounded border border-emerald-700 bg-zinc-900 px-1 py-0 text-right font-mono text-xs text-emerald-300 outline-none"
    />
  );
}

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return "—";
  const deltaMs = Date.now() - ts;
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(months / 12);
  return `${years}y ago`;
}

export function Streams({
  initialStream,
  onTrace,
  onStream,
}: {
  initialStream?: string;
  onTrace?: (id: string) => void;
  onStream?: (stream: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("eventCount");
  const [sortAsc, setSortAsc] = useState(false);
  const [selected, setSelected] = useState<string | null>(
    initialStream ?? null
  );
  // "Stale" filter — hide any stream whose head was committed within
  // `staleDays` days. 0 disables the filter (default). The Streams
  // view's value as an operational tool comes from quickly spotting
  // long-lived streams that have gone quiet; this turns that into one
  // click.
  const [staleDays, setStaleDays] = useState(0);

  const streamsQuery = trpc.streams.useQuery(
    { limit: 1000 },
    { staleTime: 3_000 }
  );
  // Per-stream subscription metadata (priority + lane + watermark)
  // lives in the `streams` table, queried separately. Joined into the
  // row list below by stream name. `streamMeta` is cheap on real
  // adapters (no event scan) so the second query is fine.
  const metaQuery = trpc.streamMeta.useQuery(undefined, {
    staleTime: 3_000,
  });
  // Write-mode probe (#698 slice 4). Drives whether the inline
  // priority editor is interactive or display-only. Cached for the
  // session — flipping the env var requires a server restart anyway.
  const writeModeQuery = trpc.writeMode.useQuery(undefined, {
    staleTime: Infinity,
  });
  const writeEnabled = writeModeQuery.data?.enabled ?? false;
  const writeDisabledReason =
    writeModeQuery.data?.reason ?? "Read-only mode";

  // Mutation for per-row priority edits. On success, invalidate the
  // joined queries so the new value renders without a full reload.
  const utils = trpc.useUtils();
  const prioritizeMutation = trpc.prioritize.useMutation({
    onSuccess: () => {
      void utils.streamMeta.invalidate();
      void utils.drainStatus.invalidate();
      void utils.audit.invalidate();
    },
  });

  const streams = useMemo<StreamRow[]>(() => {
    const metaByStream = new Map<
      string,
      { priority: number; lane: string | null }
    >();
    for (const m of metaQuery.data ?? [])
      metaByStream.set(m.stream, { priority: m.priority, lane: m.lane });
    return (streamsQuery.data ?? []).map((s) => {
      const meta = metaByStream.get(s.stream);
      return {
        stream: s.stream,
        eventCount: s.eventCount,
        lastEvent: s.lastEvent,
        firstEvent: s.firstEvent,
        currentVersion: s.currentVersion,
        isClosed: s.isClosed,
        priority: meta?.priority ?? 0,
        lane: meta?.lane ?? null,
      };
    });
  }, [streamsQuery.data, metaQuery.data]);

  const filtered = useMemo(() => {
    const cutoff =
      staleDays > 0 ? Date.now() - staleDays * 24 * 60 * 60 * 1000 : null;
    return streams
      .filter(
        (s) => !filter || s.stream.toLowerCase().includes(filter.toLowerCase())
      )
      .filter((s) => {
        if (!cutoff) return true;
        const headTs = s.lastEvent ? new Date(s.lastEvent).getTime() : null;
        return headTs !== null && headTs < cutoff;
      })
      .sort((a, b) => {
        const dir = sortAsc ? 1 : -1;
        switch (sortKey) {
          case "stream":
            return dir * a.stream.localeCompare(b.stream);
          case "lastEvent":
            return dir * (a.lastEvent ?? "").localeCompare(b.lastEvent ?? "");
          case "firstEvent":
            return dir * (a.firstEvent ?? "").localeCompare(b.firstEvent ?? "");
          case "lane": {
            // Default ("default" / null) sorts last so non-default lanes
            // surface first when ascending. Use the visible label for
            // localeCompare so the column reads as displayed.
            const al = a.lane ?? "default";
            const bl = b.lane ?? "default";
            return dir * al.localeCompare(bl);
          }
          default:
            return dir * (a[sortKey] - b[sortKey]);
        }
      });
  }, [streams, filter, staleDays, sortKey, sortAsc]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc(!sortAsc);
    else {
      setSortKey(key);
      setSortAsc(false);
    }
  };

  const sortArrow = (key: SortKey) =>
    sortKey === key ? (sortAsc ? " ▴" : " ▾") : "";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Summary + Filter */}
      <div className="flex items-center gap-4 border-b border-zinc-800 bg-zinc-925 px-4 py-2">
        <span className="text-xs text-zinc-400">
          <span className="font-medium text-zinc-200">{filtered.length}</span>
          {staleDays > 0 && (
            <span className="text-zinc-500"> / {streams.length}</span>
          )}{" "}
          streams
        </span>
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter..."
          className="w-56 rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-200 outline-none transition placeholder:text-zinc-600 focus:border-emerald-600"
        />
        <label className="flex items-center gap-1.5 text-[11px] text-zinc-400">
          <span>Stale</span>
          <select
            value={staleDays}
            onChange={(e) => setStaleDays(Number(e.target.value))}
            className="rounded-md border border-zinc-700 bg-zinc-800 px-1.5 py-1 text-[11px] text-zinc-200 outline-none focus:border-emerald-600"
          >
            <option value={0}>off</option>
            {STALE_DAY_OPTIONS.map((d) => (
              <option key={d} value={d}>
                ≥ {d}d
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Stream list */}
        <div
          className={`flex flex-col overflow-y-auto ${selected ? "w-1/3 border-r border-zinc-800" : "flex-1"}`}
        >
          {/* Column headers */}
          <div className="sticky top-0 flex items-center gap-3 border-b border-zinc-800 bg-zinc-925 px-4 py-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
            <button
              onClick={() => handleSort("eventCount")}
              className="w-14 shrink-0 text-right hover:text-zinc-300"
            >
              Events{sortArrow("eventCount")}
            </button>
            <button
              onClick={() => handleSort("currentVersion")}
              className="w-12 shrink-0 text-right hover:text-zinc-300"
            >
              Ver{sortArrow("currentVersion")}
            </button>
            <button
              onClick={() => handleSort("priority")}
              className="w-12 shrink-0 text-right hover:text-zinc-300"
              title="Scheduling priority — higher claims first under saturation"
            >
              Pri{sortArrow("priority")}
            </button>
            <button
              onClick={() => handleSort("lane")}
              className="w-20 shrink-0 text-left hover:text-zinc-300"
              title="Drain lane (ACT-1103)"
            >
              Lane{sortArrow("lane")}
            </button>
            <button
              onClick={() => handleSort("firstEvent")}
              className="w-20 shrink-0 whitespace-nowrap text-right hover:text-zinc-300"
              title="When the stream first committed"
            >
              Age{sortArrow("firstEvent")}
            </button>
            <button
              onClick={() => handleSort("lastEvent")}
              className="w-32 shrink-0 whitespace-nowrap text-right hover:text-zinc-300"
            >
              Last{sortArrow("lastEvent")}
            </button>
            <button
              onClick={() => handleSort("stream")}
              className="min-w-0 flex-1 text-left hover:text-zinc-300"
            >
              Stream{sortArrow("stream")}
            </button>
          </div>

          {streamsQuery.isLoading ? (
            <div className="flex h-48 items-center justify-center text-sm text-zinc-600">
              Loading...
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex h-48 items-center justify-center text-sm text-zinc-600">
              No streams found
            </div>
          ) : (
            filtered.map((s) => (
              <button
                key={s.stream}
                onClick={() =>
                  setSelected(s.stream === selected ? null : s.stream)
                }
                className={`flex items-center gap-3 border-b border-zinc-800/50 px-4 py-2 text-left text-xs transition hover:bg-zinc-900/50 ${selected === s.stream ? "bg-zinc-900" : ""}`}
              >
                <span className="w-14 shrink-0 text-right font-mono text-zinc-500">
                  {s.eventCount}
                </span>
                <span className="w-12 shrink-0 text-right font-mono text-zinc-500">
                  v{s.currentVersion}
                </span>
                <PriorityCell
                  stream={s.stream}
                  priority={s.priority}
                  writeEnabled={writeEnabled}
                  writeDisabledReason={writeDisabledReason}
                  pending={
                    prioritizeMutation.isPending &&
                    prioritizeMutation.variables?.filter?.stream === s.stream
                  }
                  onCommit={(value) =>
                    prioritizeMutation.mutate({
                      priority: value,
                      filter: { stream: s.stream, stream_exact: true },
                    })
                  }
                />
                <span
                  className={`w-20 shrink-0 truncate font-mono text-[10px] ${s.lane ? "text-violet-300" : "text-zinc-700"}`}
                  title={s.lane ? `lane: ${s.lane}` : "default lane"}
                >
                  {s.lane ?? "default"}
                </span>
                <span
                  className="w-20 shrink-0 whitespace-nowrap text-right text-zinc-500"
                  title={s.firstEvent ?? undefined}
                >
                  {relativeTime(s.firstEvent)}
                </span>
                <span
                  className="w-32 shrink-0 whitespace-nowrap text-right text-zinc-500"
                  title={
                    s.lastEvent
                      ? new Date(s.lastEvent).toLocaleString()
                      : undefined
                  }
                >
                  {relativeTime(s.lastEvent)}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-zinc-300">
                  {s.stream}
                  {s.isClosed && (
                    <span className="ml-2 inline-block rounded border border-red-800 bg-red-900/50 px-1.5 py-0 text-[9px] font-medium text-red-400">
                      closed
                    </span>
                  )}
                </span>
              </button>
            ))
          )}
        </div>

        {/* Stream detail panel */}
        {selected && (
          <StreamDetail
            stream={selected}
            onTrace={onTrace}
            onStream={onStream}
            onClose={() => setSelected(null)}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Head / tail indicators rendered above the event list when a stream
 * is selected (#698 follow-up). Two compact cards sharing the same
 * font + spacing, one per end of the stream:
 *
 *   ┌──────────────────────────┬──────────────────────────┐
 *   │ Tail (oldest)            │ Head (latest)            │
 *   │ #42 DigitPressed v1      │ #519 OperatorPressed v17 │
 *   │ 12d ago                  │ 3m ago                   │
 *   └──────────────────────────┴──────────────────────────┘
 *
 * Single-event streams omit the tail card and render a "single-event
 * stream" hint instead, since head and tail coincide. The card row
 * collapses entirely while stats are still loading.
 */
function StreamStatsHeader({
  stats,
}: {
  stats: {
    head: { id: number; name: string; version: number; created: string };
    tail: {
      id: number;
      name: string;
      version: number;
      created: string;
    } | null;
    eventCount: number;
    nameCounts: Record<string, number | undefined>;
  } | null;
}) {
  if (!stats) return null;
  const sameEvent = stats.tail && stats.tail.id === stats.head.id;
  return (
    <div className="grid grid-cols-2 gap-3 border-b border-zinc-800 bg-zinc-950 px-4 py-3">
      <EndpointCard
        label="Tail (oldest)"
        endpoint={sameEvent ? null : stats.tail}
        muted
      />
      <EndpointCard label="Head (latest)" endpoint={stats.head} />
      <div className="col-span-2 flex items-center gap-3 text-[10px] text-zinc-500">
        <span className="font-mono">
          {stats.eventCount} event{stats.eventCount === 1 ? "" : "s"}
        </span>
        {Object.keys(stats.nameCounts).length > 0 && (
          <span className="truncate" title={JSON.stringify(stats.nameCounts)}>
            {Object.entries(stats.nameCounts)
              .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
              .slice(0, 4)
              .map(([n, c]) => `${n}·${c ?? 0}`)
              .join("  ")}
          </span>
        )}
      </div>
    </div>
  );
}

function EndpointCard({
  label,
  endpoint,
  muted,
}: {
  label: string;
  endpoint: {
    id: number;
    name: string;
    version: number;
    created: string;
  } | null;
  muted?: boolean;
}) {
  return (
    <div
      className={`rounded border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 ${
        muted ? "opacity-60" : ""
      }`}
    >
      <div className="mb-1 text-[9px] uppercase tracking-wider text-zinc-500">
        {label}
      </div>
      {endpoint ? (
        <>
          <div className="flex items-baseline gap-2 font-mono">
            <span className="text-[10px] text-zinc-500">#{endpoint.id}</span>
            <span className="truncate text-xs text-zinc-200">
              {endpoint.name}
            </span>
            <span className="text-[10px] text-zinc-500">
              v{endpoint.version}
            </span>
          </div>
          <div
            className="font-mono text-[10px] text-zinc-500"
            title={endpoint.created}
          >
            {relativeTime(endpoint.created)}
          </div>
        </>
      ) : (
        <div className="font-mono text-[10px] italic text-zinc-600">
          single-event stream
        </div>
      )}
    </div>
  );
}

function StreamDetail({
  stream,
  onTrace,
  onStream,
  onClose,
}: {
  stream: string;
  onTrace?: (id: string) => void;
  onStream?: (stream: string) => void;
  onClose: () => void;
}) {
  const eventsQuery = trpc.query.useQuery(
    { stream, limit: 100, backward: true },
    { staleTime: 3_000 }
  );
  // Head + tail stats on demand (#698). Fetched only when the detail
  // panel is open — the page-wide `streams` query doesn't carry the
  // full Committed bodies because that'd 100× the payload for the
  // common scan-the-list case.
  const statsQuery = trpc.streamStats.useQuery(
    { stream },
    { staleTime: 5_000 }
  );

  const events = (eventsQuery.data?.events ?? []) as any[];

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      {/* Detail header */}
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-zinc-800 bg-zinc-925 px-4 py-2">
        <div className="flex items-center gap-2">
          <h3 className="truncate font-mono text-xs font-medium text-zinc-200">
            {stream}
          </h3>
          <button
            onClick={() => void navigator.clipboard.writeText(stream)}
            className="text-[10px] text-zinc-600 hover:text-zinc-400"
          >
            copy
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-300"
          >
            &times;
          </button>
        </div>
      </div>

      {/* Head + Tail indicators (on-demand stats) */}
      <StreamStatsHeader stats={statsQuery.data ?? null} />

      {/* Event history */}
      <div className="flex-1">
        <div className="border-b border-zinc-800 bg-zinc-925 px-4 py-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
          Events ({events.length})
        </div>
        {eventsQuery.isLoading ? (
          <div className="flex h-24 items-center justify-center text-sm text-zinc-600">
            Loading...
          </div>
        ) : events.length === 0 ? (
          <div className="flex h-24 items-center justify-center text-sm text-zinc-600">
            No events
          </div>
        ) : (
          <div>
            {events.map((event: any) => (
              <EventRow
                key={event.id}
                event={event}
                defaultExpanded
                compact
                hideStream
                onTrace={onTrace}
                onStream={onStream}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
