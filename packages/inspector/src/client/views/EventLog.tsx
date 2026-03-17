import { useCallback, useEffect, useRef, useState } from "react";
import { EventRow } from "../components/EventRow.js";
import { FilterBar } from "../components/FilterBar.js";
import { StatsBar } from "../components/StatsBar.js";
import { useFilterStore } from "../stores/filters.js";
import { trpc } from "../trpc.js";

type AnyEvent = {
  id: number;
  name: string;
  stream: string;
  version: number;
  created: string;
  data: unknown;
  meta: Record<string, unknown>;
};

export function EventLog({
  onTrace,
  onStream,
}: {
  onTrace?: (correlationId: string) => void;
  onStream?: (stream: string) => void;
}) {
  const [filters] = useFilterStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState<AnyEvent[][]>([]);
  const [cursor, setCursor] = useState<number | undefined>(undefined);
  const [hasMore, setHasMore] = useState(true);

  // Reset pages when filters change (except cursor-driven pagination)
  const filterKey = JSON.stringify({
    stream: filters.stream,
    names: filters.names,
    created_after: filters.created_after,
    created_before: filters.created_before,
    correlation: filters.correlation,
    backward: filters.backward,
    limit: filters.limit,
  });

  useEffect(() => {
    setPages([]);
    setCursor(undefined);
    setHasMore(true);
  }, [filterKey]);

  const eventsQuery = trpc.query.useQuery(
    {
      stream: filters.stream,
      names: filters.names,
      before: cursor,
      limit: filters.limit,
      created_after: filters.created_after,
      created_before: filters.created_before,
      backward: filters.backward,
      correlation: filters.correlation,
    },
    {
      staleTime: 3_000,
      placeholderData: (prev) => prev,
    }
  );

  // Append new page when data arrives, or reset if data changed
  useEffect(() => {
    if (!eventsQuery.data) return;
    const newEvents = eventsQuery.data.events as unknown as AnyEvent[];
    if (newEvents.length < filters.limit) {
      setHasMore(false);
    }
    if (newEvents.length === 0) return;

    setPages((prev) => {
      // First page (no cursor) — check if data changed (DB reset, new events)
      if (cursor === undefined && prev.length > 0) {
        const firstPage = prev[0];
        if (
          firstPage.length > 0 &&
          newEvents.length > 0 &&
          firstPage[0].id !== newEvents[0].id
        ) {
          // Data has changed — replace all pages
          return [newEvents];
        }
      }

      // Avoid duplicates — check if this page is already appended
      const lastPage = prev[prev.length - 1];
      if (
        lastPage &&
        lastPage.length > 0 &&
        newEvents.length > 0 &&
        lastPage[0].id === newEvents[0].id
      ) {
        return prev;
      }
      return [...prev, newEvents];
    });
  }, [eventsQuery.data, filters.limit]);

  const allEvents = pages.flat();

  const loadMore = useCallback(() => {
    if (!hasMore || eventsQuery.isFetching) return;
    const lastEvent = allEvents[allEvents.length - 1];
    if (lastEvent) {
      setCursor(lastEvent.id);
    }
  }, [hasMore, eventsQuery.isFetching, allEvents]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (nearBottom) loadMore();
  }, [loadMore]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <FilterBar />
      <StatsBar />

      {/* Column headers */}
      <div className="flex items-center gap-3 border-b border-zinc-800 bg-zinc-925 px-4 py-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
        <span className="w-16 shrink-0">ID</span>
        <span className="w-24 shrink-0">Actor</span>
        <span className="w-12 shrink-0 text-right">Version</span>
        <span className="w-36 shrink-0">Event</span>
        <span className="min-w-0 flex-1">Stream</span>
        <span className="w-20 shrink-0">Correlation</span>
        <span className="w-20 shrink-0 text-right">Time</span>
        <span className="w-4 shrink-0" />
      </div>

      {/* Event list */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto"
      >
        {eventsQuery.isLoading && allEvents.length === 0 ? (
          <div className="flex h-48 items-center justify-center text-sm text-zinc-600">
            Loading events...
          </div>
        ) : allEvents.length === 0 ? (
          <div className="flex h-48 items-center justify-center text-sm text-zinc-600">
            No events found
          </div>
        ) : (
          <>
            {allEvents.map((event) => (
              <EventRow
                key={event.id}
                event={event as any}
                onTrace={onTrace}
                onStream={onStream}
              />
            ))}
            {eventsQuery.isFetching && (
              <div className="py-4 text-center text-xs text-zinc-600">
                Loading more...
              </div>
            )}
            {!hasMore && allEvents.length > 0 && (
              <div className="py-4 text-center text-xs text-zinc-700">
                End of results
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
