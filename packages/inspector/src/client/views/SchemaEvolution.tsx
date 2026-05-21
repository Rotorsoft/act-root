import { ArrowRight, Check, Copy, RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { trpc } from "../trpc.js";

type EventRow = {
  name: string;
  count: number;
  status: "current" | "deprecated" | "active";
  currentVersion: string | null;
};

type SortKey = "name" | "status" | "count";

/**
 * Schema Evolution view (#708).
 *
 * Renders the workspace event-name rollup with deprecation status —
 * derived from the framework's `_v<digits>` convention. Operators
 * land here to answer the post-migration question "how big is the
 * legacy event backlog on disk?".
 *
 * Lazy-loaded: the query fires once on view-open and stays cached
 * until the operator clicks Refresh. `query_stats({}, {names:true})`
 * is cheap on durable adapters but not free; on-demand keeps it from
 * running every time the page polls.
 */
export function SchemaEvolution() {
  const [sortKey, setSortKey] = useState<SortKey>("status");
  const [sortAsc, setSortAsc] = useState(false);
  const [filter, setFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<
    "all" | "deprecated" | "current" | "active"
  >("all");
  // Open drill-through modal for the clicked event row. Operators only
  // really want to drill into *deprecated* rows ("which streams still
  // carry the legacy event?"), but every row supports it — `active`
  // and `current` drill-through is useful for "which streams use this
  // event" forensics too.
  const [selectedEvent, setSelectedEvent] = useState<string | null>(null);

  const query = trpc.schemaEvolution.useQuery(undefined, {
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const utils = trpc.useUtils();

  const rows: EventRow[] = (query.data?.events ?? []) as EventRow[];
  const summary = query.data?.summary;

  const filtered = useMemo(() => {
    const dir = sortAsc ? 1 : -1;
    // Stable status ordering for the "status" sort:
    // deprecated (most operator-relevant) > current > active
    const statusRank = (s: EventRow["status"]) =>
      s === "deprecated" ? 0 : s === "current" ? 1 : 2;
    return rows
      .filter((r) => !filter || r.name.toLowerCase().includes(filter.toLowerCase()))
      .filter((r) => statusFilter === "all" || r.status === statusFilter)
      .sort((a, b) => {
        switch (sortKey) {
          case "name":
            return dir * a.name.localeCompare(b.name);
          case "status":
            return dir * (statusRank(a.status) - statusRank(b.status));
          case "count":
            return dir * (a.count - b.count);
        }
      });
  }, [rows, filter, statusFilter, sortKey, sortAsc]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc(!sortAsc);
    else {
      setSortKey(key);
      // Sensible default: descending for count + status (highest impact
      // first), ascending for name (alphabetical).
      setSortAsc(key === "name");
    }
  };

  const sortArrow = (key: SortKey) =>
    sortKey === key ? (sortAsc ? " ▴" : " ▾") : "";

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {/* Summary cards */}
      {summary && (
        <div className="grid grid-cols-4 gap-3 border-b border-zinc-800 bg-zinc-925 px-4 py-3">
          <SummaryCard
            label="Total events"
            value={summary.totalEvents.toLocaleString()}
            color="text-zinc-200"
          />
          <SummaryCard
            label="Deprecated events"
            value={summary.deprecatedEvents.toLocaleString()}
            color={
              summary.deprecatedEvents > 0 ? "text-amber-400" : "text-zinc-500"
            }
          />
          <SummaryCard
            label="Distinct names"
            value={String(summary.distinctNames)}
            color="text-zinc-200"
          />
          <SummaryCard
            label="Deprecated names"
            value={String(summary.deprecatedNames)}
            color={
              summary.deprecatedNames > 0 ? "text-amber-400" : "text-zinc-500"
            }
          />
        </div>
      )}

      {/* Filter bar */}
      <div className="flex items-center gap-3 border-b border-zinc-800 bg-zinc-925 px-4 py-2">
        <span className="text-xs text-zinc-400">
          <span className="font-medium text-zinc-200">{filtered.length}</span>
          {filtered.length !== rows.length && (
            <span className="text-zinc-500"> / {rows.length}</span>
          )}{" "}
          events
        </span>
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by name..."
          className="w-56 rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-emerald-600"
        />
        <label className="flex items-center gap-1.5 text-[11px] text-zinc-400">
          Status
          <select
            value={statusFilter}
            onChange={(e) =>
              setStatusFilter(
                e.target.value as "all" | "deprecated" | "current" | "active"
              )
            }
            className="rounded-md border border-zinc-700 bg-zinc-800 px-1.5 py-1 text-[11px] text-zinc-200 outline-none focus:border-emerald-600"
          >
            <option value="all">all</option>
            <option value="deprecated">deprecated</option>
            <option value="current">current</option>
            <option value="active">active</option>
          </select>
        </label>
        <button
          type="button"
          onClick={() => void utils.schemaEvolution.invalidate()}
          disabled={query.isFetching}
          className="ml-auto flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-[11px] text-zinc-300 transition hover:border-emerald-600 hover:text-emerald-300 disabled:opacity-50"
          title="Re-run the workspace event-name aggregation"
        >
          <RefreshCw
            size={12}
            className={query.isFetching ? "animate-spin" : ""}
          />
          {query.isFetching ? "Loading…" : "Refresh"}
        </button>
      </div>

      {/* Table */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="sticky top-0 flex items-center gap-3 border-b border-zinc-800 bg-zinc-925 px-4 py-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
          <button
            onClick={() => handleSort("status")}
            className="w-24 shrink-0 text-left hover:text-zinc-300"
          >
            Status{sortArrow("status")}
          </button>
          <button
            onClick={() => handleSort("name")}
            className="min-w-0 flex-1 text-left hover:text-zinc-300"
          >
            Event name{sortArrow("name")}
          </button>
          <span className="w-48 shrink-0 text-left">Current version</span>
          <button
            onClick={() => handleSort("count")}
            className="w-32 shrink-0 text-right hover:text-zinc-300"
          >
            On-disk count{sortArrow("count")}
          </button>
        </div>

        {query.isLoading ? (
          <div className="flex h-48 items-center justify-center text-sm text-zinc-600">
            Loading workspace event aggregation…
          </div>
        ) : query.isError ? (
          <div className="flex h-48 items-center justify-center text-sm text-red-400">
            Failed to load: {query.error?.message ?? "unknown error"}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex h-48 items-center justify-center text-sm text-zinc-600">
            {rows.length === 0
              ? "No events in this store yet."
              : "No events match the active filter."}
          </div>
        ) : (
          filtered.map((row) => (
            <EventNameRow
              key={row.name}
              row={row}
              onSelect={() => setSelectedEvent(row.name)}
            />
          ))
        )}
      </div>

      {selectedEvent && (
        <StreamsForEventModal
          eventName={selectedEvent}
          onClose={() => setSelectedEvent(null)}
        />
      )}
    </div>
  );
}

function SummaryCard({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
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

function EventNameRow({
  row,
  onSelect,
}: {
  row: EventRow;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      title="Drill into streams holding this event"
      className={`flex w-full items-center gap-3 border-b border-zinc-800/50 px-4 py-2 text-left text-xs transition hover:bg-zinc-900/50 ${
        row.status === "deprecated" ? "bg-amber-950/10" : ""
      }`}
    >
      <span className="w-24 shrink-0">
        <StatusBadge status={row.status} />
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-zinc-200">
        {row.name}
      </span>
      <span className="w-48 shrink-0 truncate font-mono text-zinc-500">
        {row.currentVersion ? (
          <span className="inline-flex items-center gap-1">
            <ArrowRight size={10} className="text-zinc-600" />
            <span className="text-emerald-400">{row.currentVersion}</span>
          </span>
        ) : (
          <span className="text-zinc-700">—</span>
        )}
      </span>
      <span className="w-32 shrink-0 text-right font-mono text-zinc-300">
        {row.count.toLocaleString()}
      </span>
    </button>
  );
}

/**
 * Modal listing every stream that holds at least one event of the
 * named type (#708 slice 4). Built from the `streamsForEvent` tRPC
 * query — pure read, no destructive actions from the inspector.
 *
 * Operators select rows + copy stream names (or a ready-to-paste
 * `app.close([...])` snippet) so they can run the actual close from
 * their own application code. The inspector doesn't have an Act
 * orchestrator to call `app.close()` itself; see slice-3 commit and
 * the PR body for the rationale.
 */
function StreamsForEventModal({
  eventName,
  onClose,
}: {
  eventName: string;
  onClose: () => void;
}) {
  const query = trpc.streamsForEvent.useQuery(
    { name: eventName },
    { staleTime: 30_000, refetchOnWindowFocus: false }
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState<"names" | "snippet" | null>(null);

  // Auto-dismiss the "copied" toast after a beat so repeated copies
  // give visual feedback each time.
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  // Esc closes the modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const rows = query.data?.streams ?? [];
  const totalOfName = query.data?.totalEventsOfName ?? 0;

  const toggle = (stream: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(stream)) next.delete(stream);
      else next.add(stream);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected((prev) =>
      prev.size === rows.length ? new Set() : new Set(rows.map((r) => r.stream))
    );
  };

  const selectedStreams = rows
    .filter((r) => selected.has(r.stream))
    .map((r) => r.stream);

  const copyNames = () => {
    void navigator.clipboard.writeText(selectedStreams.join("\n"));
    setCopied("names");
  };

  const copySnippet = () => {
    const targets = selectedStreams
      .map((s) => `  { stream: ${JSON.stringify(s)} }`)
      .join(",\n");
    const snippet = `await app.close([\n${targets}\n]);`;
    void navigator.clipboard.writeText(snippet);
    setCopied("snippet");
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-[min(900px,90vw)] flex-col rounded-lg border border-zinc-700 bg-zinc-925 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between border-b border-zinc-800 px-4 py-3">
          <div>
            <h3 className="font-mono text-sm text-zinc-200">{eventName}</h3>
            <p className="mt-0.5 text-[11px] text-zinc-500">
              {rows.length === 0
                ? "No streams hold this event."
                : `${rows.length} streams hold ${totalOfName.toLocaleString()} ${eventName} events`}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-zinc-500 transition hover:text-zinc-300"
            title="Close (Esc)"
          >
            <X size={18} />
          </button>
        </div>

        {/* Table */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <div className="sticky top-0 flex items-center gap-3 border-b border-zinc-800 bg-zinc-925 px-4 py-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
            <button
              type="button"
              onClick={toggleAll}
              className="w-6 shrink-0 text-left hover:text-zinc-300"
              title={
                selected.size === rows.length && rows.length > 0
                  ? "Clear selection"
                  : "Select all"
              }
            >
              {selected.size === rows.length && rows.length > 0 ? "☑" : "☐"}
            </button>
            <span className="w-20 shrink-0 truncate">Lane</span>
            <span className="w-12 shrink-0 text-right">Pri</span>
            <span className="min-w-0 flex-1">Stream</span>
            <span className="w-24 shrink-0 text-right">
              {eventName.length > 8 ? "Event #" : `${eventName}`}
            </span>
            <span className="w-24 shrink-0 text-right">Total events</span>
          </div>
          {query.isLoading ? (
            <div className="flex h-48 items-center justify-center text-sm text-zinc-600">
              Loading streams…
            </div>
          ) : rows.length === 0 ? (
            <div className="flex h-48 items-center justify-center text-sm text-zinc-600">
              No streams currently hold this event.
            </div>
          ) : (
            rows.map((r) => (
              <button
                key={r.stream}
                type="button"
                onClick={() => toggle(r.stream)}
                className={`flex w-full items-center gap-3 border-b border-zinc-800/50 px-4 py-2 text-left text-xs transition hover:bg-zinc-900/50 ${
                  selected.has(r.stream) ? "bg-emerald-950/30" : ""
                }`}
              >
                <span className="w-6 shrink-0 font-mono text-zinc-400">
                  {selected.has(r.stream) ? (
                    <Check size={12} className="text-emerald-400" />
                  ) : (
                    <span className="text-zinc-700">☐</span>
                  )}
                </span>
                <span
                  className={`w-20 shrink-0 truncate font-mono text-[10px] ${r.lane ? "text-violet-300" : "text-zinc-700"}`}
                  title={r.lane ? `lane: ${r.lane}` : "default lane"}
                >
                  {r.lane ?? "default"}
                </span>
                <span
                  className={`w-12 shrink-0 text-right font-mono ${r.priority !== 0 ? "text-amber-400" : "text-zinc-700"}`}
                >
                  {r.priority}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-zinc-200">
                  {r.stream}
                </span>
                <span className="w-24 shrink-0 text-right font-mono text-amber-300">
                  {r.eventCount.toLocaleString()}
                </span>
                <span className="w-24 shrink-0 text-right font-mono text-zinc-500">
                  {r.totalEvents.toLocaleString()}
                </span>
              </button>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-zinc-800 px-4 py-2.5">
          <div className="text-[11px] text-zinc-500">
            <span className="font-mono text-zinc-300">
              {selected.size}
            </span>{" "}
            selected
            {copied && (
              <span className="ml-3 inline-flex items-center gap-1 text-emerald-400">
                <Check size={11} />
                {copied === "names"
                  ? "Stream names copied"
                  : "app.close() snippet copied"}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={copyNames}
              disabled={selected.size === 0}
              className="flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-[11px] text-zinc-300 transition hover:border-emerald-600 hover:text-emerald-300 disabled:cursor-not-allowed disabled:opacity-40"
              title="Copy newline-separated stream names"
            >
              <Copy size={12} />
              Copy names
            </button>
            <button
              type="button"
              onClick={copySnippet}
              disabled={selected.size === 0}
              className="flex items-center gap-1.5 rounded-md border border-emerald-700 bg-emerald-900/40 px-2 py-1 text-[11px] text-emerald-200 transition hover:border-emerald-600 hover:bg-emerald-900/60 disabled:cursor-not-allowed disabled:opacity-40"
              title="Copy a ready-to-paste app.close([...]) snippet"
            >
              <Copy size={12} />
              Copy app.close()
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: EventRow["status"] }) {
  const className =
    status === "deprecated"
      ? "border-amber-700 bg-amber-950/50 text-amber-300"
      : status === "current"
        ? "border-violet-700 bg-violet-950/50 text-violet-300"
        : "border-zinc-700 bg-zinc-900 text-zinc-500";
  return (
    <span
      className={`inline-block rounded border px-1.5 py-0 text-[10px] font-mono ${className}`}
    >
      {status}
    </span>
  );
}
