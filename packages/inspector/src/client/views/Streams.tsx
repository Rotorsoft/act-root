import { useState } from "react";
import { EventRow } from "../components/EventRow.js";
import { setFilters } from "../stores/filters.js";
import { trpc } from "../trpc.js";

type StreamRow = {
  stream: string;
  eventCount: number;
  lastEvent: string;
  currentVersion: number;
};

type StreamMetaRow = {
  stream: string;
  source: string | null;
  at: number;
  retry: number;
  blocked: boolean;
  error: string | null;
  leased_at: number | null;
  leased_by: string | null;
  leased_until: string | null;
};

type SortKey = "stream" | "eventCount" | "currentVersion" | "lastEvent";

function statusBadge(meta: StreamMetaRow | undefined) {
  if (!meta)
    return (
      <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-500">
        unknown
      </span>
    );
  if (meta.blocked)
    return (
      <span className="rounded bg-red-950 px-1.5 py-0.5 text-[10px] text-red-400">
        blocked
      </span>
    );
  if (meta.leased_by)
    return (
      <span className="rounded bg-amber-950 px-1.5 py-0.5 text-[10px] text-amber-400">
        leased
      </span>
    );
  if (meta.retry > 0)
    return (
      <span className="rounded bg-yellow-950 px-1.5 py-0.5 text-[10px] text-yellow-400">
        retry:{meta.retry}
      </span>
    );
  return (
    <span className="rounded bg-emerald-950 px-1.5 py-0.5 text-[10px] text-emerald-400">
      healthy
    </span>
  );
}

export function Streams({ onNavigateToLog }: { onNavigateToLog: () => void }) {
  const [filter, setFilter] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("eventCount");
  const [sortAsc, setSortAsc] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const streamsQuery = trpc.streams.useQuery(
    { limit: 1000 },
    { staleTime: 10_000 }
  );
  const metaQuery = trpc.streamMeta.useQuery(undefined, { staleTime: 10_000 });

  const streams = (streamsQuery.data ?? []) as StreamRow[];
  const metaMap = new Map<string, StreamMetaRow>();
  for (const m of (metaQuery.data ?? []) as StreamMetaRow[]) {
    metaMap.set(m.stream, m);
  }

  // Filter and sort
  const filtered = streams
    .filter(
      (s) => !filter || s.stream.toLowerCase().includes(filter.toLowerCase())
    )
    .sort((a, b) => {
      const dir = sortAsc ? 1 : -1;
      if (sortKey === "stream") return dir * a.stream.localeCompare(b.stream);
      if (sortKey === "lastEvent")
        return dir * a.lastEvent.localeCompare(b.lastEvent);
      return dir * (a[sortKey] - b[sortKey]);
    });

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc(!sortAsc);
    else {
      setSortKey(key);
      setSortAsc(false);
    }
  };

  // Health summary
  const healthy = streams.filter((s) => {
    const m = metaMap.get(s.stream);
    return m && !m.blocked && !m.leased_by && m.retry === 0;
  }).length;
  const blocked = streams.filter((s) => metaMap.get(s.stream)?.blocked).length;
  const leased = streams.filter((s) => metaMap.get(s.stream)?.leased_by).length;

  const sortArrow = (key: SortKey) =>
    sortKey === key ? (sortAsc ? " ▴" : " ▾") : "";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Health summary */}
      <div className="flex items-center gap-6 border-b border-zinc-800 bg-zinc-925 px-4 py-2 text-xs text-zinc-400">
        <span>
          Total{" "}
          <span className="font-medium text-zinc-200">{streams.length}</span>
        </span>
        <span>
          Healthy{" "}
          <span className="font-medium text-emerald-400">{healthy}</span>
        </span>
        {blocked > 0 && (
          <span>
            Blocked <span className="font-medium text-red-400">{blocked}</span>
          </span>
        )}
        {leased > 0 && (
          <span>
            Leased <span className="font-medium text-amber-400">{leased}</span>
          </span>
        )}
      </div>

      {/* Filter */}
      <div className="border-b border-zinc-800 bg-zinc-925 px-4 py-2">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter streams..."
          className="w-64 rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-200 outline-none transition placeholder:text-zinc-600 focus:border-emerald-600"
        />
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Stream list */}
        <div
          className={`flex flex-col overflow-y-auto ${selected ? "w-1/3 border-r border-zinc-800" : "flex-1"}`}
        >
          {/* Column headers */}
          <div className="sticky top-0 flex items-center gap-3 border-b border-zinc-800 bg-zinc-925 px-4 py-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
            <button
              onClick={() => handleSort("stream")}
              className="min-w-0 flex-1 text-left hover:text-zinc-300"
            >
              Stream{sortArrow("stream")}
            </button>
            <button
              onClick={() => handleSort("eventCount")}
              className="w-16 shrink-0 text-right hover:text-zinc-300"
            >
              Events{sortArrow("eventCount")}
            </button>
            <button
              onClick={() => handleSort("currentVersion")}
              className="w-14 shrink-0 text-right hover:text-zinc-300"
            >
              Version{sortArrow("currentVersion")}
            </button>
            <span className="w-16 shrink-0 text-center">Status</span>
            <button
              onClick={() => handleSort("lastEvent")}
              className="w-28 shrink-0 text-right hover:text-zinc-300"
            >
              Last Event{sortArrow("lastEvent")}
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
            filtered.map((s) => {
              const meta = metaMap.get(s.stream);
              return (
                <button
                  key={s.stream}
                  onClick={() =>
                    setSelected(s.stream === selected ? null : s.stream)
                  }
                  className={`flex items-center gap-3 border-b border-zinc-800/50 px-4 py-2 text-left text-xs transition hover:bg-zinc-900/50 ${selected === s.stream ? "bg-zinc-900" : ""}`}
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-zinc-300">
                    {s.stream}
                  </span>
                  <span className="w-16 shrink-0 text-right font-mono text-zinc-500">
                    {s.eventCount}
                  </span>
                  <span className="w-14 shrink-0 text-right font-mono text-zinc-500">
                    v{s.currentVersion}
                  </span>
                  <span className="w-16 shrink-0 text-center">
                    {statusBadge(meta)}
                  </span>
                  <span className="w-28 shrink-0 text-right text-zinc-500">
                    {s.lastEvent ? new Date(s.lastEvent).toLocaleString() : "—"}
                  </span>
                </button>
              );
            })
          )}
        </div>

        {/* Stream detail panel */}
        {selected && (
          <StreamDetail
            stream={selected}
            meta={metaMap.get(selected)}
            onOpenInLog={() => {
              setFilters({ stream: selected });
              onNavigateToLog();
            }}
            onClose={() => setSelected(null)}
          />
        )}
      </div>
    </div>
  );
}

function StreamDetail({
  stream,
  meta,
  onOpenInLog,
  onClose,
}: {
  stream: string;
  meta: StreamMetaRow | undefined;
  onOpenInLog: () => void;
  onClose: () => void;
}) {
  const eventsQuery = trpc.query.useQuery(
    { stream, limit: 100, backward: true },
    { staleTime: 10_000 }
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
            onClick={onOpenInLog}
            className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-[10px] text-zinc-400 hover:text-emerald-400"
          >
            Open in Log
          </button>
          <button
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-300"
          >
            &times;
          </button>
        </div>
      </div>

      {/* Processing metadata */}
      {meta && (
        <div className="border-b border-zinc-800 bg-zinc-950 px-4 py-3">
          <span className="mb-2 block text-[10px] uppercase tracking-wider text-zinc-500">
            Processing
          </span>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
            <MetaField label="Watermark (at)" value={String(meta.at)} />
            <MetaField
              label="Retry"
              value={String(meta.retry)}
              warn={meta.retry > 0}
            />
            <MetaField
              label="Blocked"
              value={meta.blocked ? "Yes" : "No"}
              error={meta.blocked}
            />
            {meta.error && <MetaField label="Error" value={meta.error} error />}
            {meta.source && <MetaField label="Source" value={meta.source} />}
            {meta.leased_by && (
              <>
                <MetaField label="Leased by" value={meta.leased_by} />
                <MetaField
                  label="Leased until"
                  value={
                    meta.leased_until
                      ? new Date(meta.leased_until).toLocaleString()
                      : "—"
                  }
                />
              </>
            )}
          </div>
        </div>
      )}

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
            {events.map((event: any, i: number) => (
              <div key={event.id}>
                <EventRow event={event} />
                {/* State diff between consecutive events */}
                {i < events.length - 1 && (
                  <StateDiff
                    current={event.data}
                    previous={events[i + 1]?.data}
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MetaField({
  label,
  value,
  warn,
  error,
}: {
  label: string;
  value: string;
  warn?: boolean;
  error?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-zinc-500">{label}</span>
      <span
        className={`font-mono ${error ? "text-red-400" : warn ? "text-yellow-400" : "text-zinc-300"}`}
      >
        {value}
      </span>
    </div>
  );
}

function StateDiff({
  current,
  previous,
}: {
  current: unknown;
  previous: unknown;
}) {
  if (!current || !previous) return null;
  if (typeof current !== "object" || typeof previous !== "object") return null;

  const curObj = current as Record<string, unknown>;
  const prevObj = previous as Record<string, unknown>;
  const allKeys = [
    ...new Set([...Object.keys(curObj), ...Object.keys(prevObj)]),
  ];
  const changes: { key: string; from: unknown; to: unknown }[] = [];

  for (const key of allKeys) {
    if (JSON.stringify(curObj[key]) !== JSON.stringify(prevObj[key])) {
      changes.push({ key, from: prevObj[key], to: curObj[key] });
    }
  }

  if (changes.length === 0) return null;

  return (
    <div className="border-b border-zinc-800/30 bg-zinc-950/50 px-4 py-1.5">
      <div className="flex flex-wrap gap-3 text-[10px]">
        {changes.map((c) => (
          <span key={c.key} className="flex items-center gap-1">
            <span className="text-zinc-500">{c.key}:</span>
            <span className="text-red-400/60 line-through">
              {JSON.stringify(c.from)}
            </span>
            <span className="text-emerald-400">{JSON.stringify(c.to)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
