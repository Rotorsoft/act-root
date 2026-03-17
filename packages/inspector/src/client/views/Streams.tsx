import { useState } from "react";
import { EventRow } from "../components/EventRow.js";
import { trpc } from "../trpc.js";

type StreamRow = {
  stream: string;
  eventCount: number;
  lastEvent: string;
  currentVersion: number;
};

type SortKey = "stream" | "eventCount" | "currentVersion" | "lastEvent";

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

  const streamsQuery = trpc.streams.useQuery(
    { limit: 1000 },
    { staleTime: 10_000 }
  );

  const streams = (streamsQuery.data ?? []) as StreamRow[];

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

  const sortArrow = (key: SortKey) =>
    sortKey === key ? (sortAsc ? " ▴" : " ▾") : "";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Summary + Filter */}
      <div className="flex items-center gap-4 border-b border-zinc-800 bg-zinc-925 px-4 py-2">
        <span className="text-xs text-zinc-400">
          <span className="font-medium text-zinc-200">{streams.length}</span>{" "}
          streams
        </span>
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter..."
          className="w-56 rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-200 outline-none transition placeholder:text-zinc-600 focus:border-emerald-600"
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
            <button
              onClick={() => handleSort("lastEvent")}
              className="w-40 shrink-0 whitespace-nowrap text-right hover:text-zinc-300"
            >
              Last Event{sortArrow("lastEvent")}
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
                <span className="w-16 shrink-0 text-right font-mono text-zinc-500">
                  {s.eventCount}
                </span>
                <span className="w-14 shrink-0 text-right font-mono text-zinc-500">
                  v{s.currentVersion}
                </span>
                <span className="w-40 shrink-0 whitespace-nowrap text-right text-zinc-500">
                  {s.lastEvent ? new Date(s.lastEvent).toLocaleString() : "—"}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-zinc-300">
                  {s.stream}
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
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-300"
          >
            &times;
          </button>
        </div>
      </div>

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
