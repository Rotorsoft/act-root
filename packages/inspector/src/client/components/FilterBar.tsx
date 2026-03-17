import { useRef, useState } from "react";
import { useFilterStore } from "../stores/filters.js";
import { trpc } from "../trpc.js";

const TIME_PRESETS = [
  { label: "5m", ms: 5 * 60_000 },
  { label: "15m", ms: 15 * 60_000 },
  { label: "1h", ms: 60 * 60_000 },
  { label: "24h", ms: 24 * 60 * 60_000 },
  { label: "7d", ms: 7 * 24 * 60 * 60_000 },
] as const;

export function FilterBar() {
  const [filters, setFilters, clearFilters] = useFilterStore();
  const [streamInput, setStreamInput] = useState(filters.stream ?? "");
  const [corrInput, setCorrInput] = useState(filters.correlation ?? "");
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const eventNamesQuery = trpc.eventNames.useQuery(undefined, {
    staleTime: 10_000,
  });
  const allNames = eventNamesQuery.data ?? [];

  const handleStreamChange = (value: string) => {
    setStreamInput(value);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setFilters({ stream: value || undefined });
    }, 400);
  };

  const handleCorrChange = (value: string) => {
    setCorrInput(value);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setFilters({ correlation: value || undefined });
    }, 400);
  };

  const toggleName = (name: string) => {
    const current = filters.names ?? [];
    const next = current.includes(name)
      ? current.filter((n) => n !== name)
      : [...current, name];
    setFilters({ names: next.length ? next : undefined });
  };

  const setTimePreset = (ms: number) => {
    setFilters({
      created_after: new Date(Date.now() - ms).toISOString(),
      created_before: undefined,
    });
  };

  const clearTime = () => {
    setFilters({ created_after: undefined, created_before: undefined });
  };

  const hasFilters =
    filters.stream ||
    filters.names?.length ||
    filters.created_after ||
    filters.correlation;

  return (
    <div className="flex flex-col gap-3 border-b border-zinc-800 bg-zinc-925 px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        {/* Stream filter */}
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase tracking-wider text-zinc-500">
            Stream
          </label>
          <input
            type="text"
            value={streamInput}
            onChange={(e) => handleStreamChange(e.target.value)}
            placeholder="regex pattern..."
            className="w-48 rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-200 outline-none transition placeholder:text-zinc-600 focus:border-emerald-600"
          />
        </div>

        {/* Correlation filter */}
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase tracking-wider text-zinc-500">
            Correlation
          </label>
          <input
            type="text"
            value={corrInput}
            onChange={(e) => handleCorrChange(e.target.value)}
            placeholder="correlation id..."
            className="w-56 rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-200 outline-none transition placeholder:text-zinc-600 focus:border-emerald-600"
          />
        </div>

        {/* Time range presets */}
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase tracking-wider text-zinc-500">
            Time Range
          </label>
          <div className="flex gap-1">
            {TIME_PRESETS.map((p) => {
              const active =
                filters.created_after &&
                Math.abs(
                  Date.now() - new Date(filters.created_after).getTime() - p.ms
                ) < 60_000;
              return (
                <button
                  key={p.label}
                  onClick={() => (active ? clearTime() : setTimePreset(p.ms))}
                  className={`rounded-md border px-2 py-1.5 text-xs transition ${
                    active
                      ? "border-emerald-600 bg-emerald-950 text-emerald-400"
                      : "border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-600 hover:text-zinc-300"
                  }`}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Clear all */}
        {hasFilters && (
          <button
            onClick={() => {
              clearFilters();
              setStreamInput("");
              setCorrInput("");
            }}
            className="mt-4 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-400 transition hover:border-red-800 hover:text-red-400"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Event name multi-select */}
      {allNames.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {allNames.map((name) => {
            const active = filters.names?.includes(name);
            return (
              <button
                key={name}
                onClick={() => toggleName(name)}
                className={`rounded-full border px-2.5 py-0.5 text-[11px] transition ${
                  active
                    ? "border-emerald-700 bg-emerald-950 text-emerald-400"
                    : "border-zinc-700 bg-zinc-850 text-zinc-400 hover:border-zinc-600 hover:text-zinc-300"
                }`}
              >
                {name}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
