import type { ReactNode, RefObject } from "react";
import { EventRow } from "./EventRow.js";

type Event = {
  id: number;
  name: string;
  stream: string;
  version: number;
  created: string;
  data: unknown;
  meta: Record<string, unknown>;
};

/**
 * The one event-table chrome — column header row plus a scrollable
 * body of `EventRow`s. Shared by `EventLog` (live store), `CsvViewer`
 * (browser-picked CSV), and the dry-run `PreviewPanel`. Each caller
 * supplies its own outer wrapper, empty/loading copy, footer
 * (load-more / end-of-results), and optional scroll handler — the
 * column shape stays identical so the three views read as the same
 * underlying object.
 */
export function EventTable({
  events,
  loading,
  loadingMessage = "Loading events...",
  emptyMessage = "No events found",
  footer,
  scrollRef,
  onScroll,
  onTrace,
  onStream,
  scrollClassName = "flex-1 overflow-y-auto",
}: {
  events: Event[];
  loading?: boolean;
  loadingMessage?: ReactNode;
  emptyMessage?: ReactNode;
  footer?: ReactNode;
  scrollRef?: RefObject<HTMLDivElement | null>;
  onScroll?: () => void;
  onTrace?: (correlation: string) => void;
  onStream?: (stream: string) => void;
  scrollClassName?: string;
}) {
  return (
    <>
      <div className="flex items-center gap-3 border-b border-zinc-800 bg-zinc-925 px-4 py-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
        <span className="w-16 shrink-0">ID</span>
        <span className="w-12 shrink-0 text-right">Version</span>
        <span className="w-64 shrink-0 truncate">Stream</span>
        <span className="w-36 shrink-0">Event</span>
        <span className="w-36 shrink-0 text-right">Date</span>
        <span className="w-80 shrink-0">Correlation</span>
        <span className="w-24 shrink-0">Actor</span>
        <span className="w-64 shrink-0">Causation</span>
        <span className="min-w-0 flex-1" />
        <span className="w-4 shrink-0" />
      </div>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className={scrollClassName}
      >
        {loading && events.length === 0 ? (
          <div className="flex h-48 items-center justify-center text-sm text-zinc-600">
            {loadingMessage}
          </div>
        ) : events.length === 0 ? (
          <div className="flex h-48 items-center justify-center text-sm text-zinc-600">
            {emptyMessage}
          </div>
        ) : (
          <>
            {events.map((event) => (
              <EventRow
                key={event.id}
                event={event}
                onTrace={onTrace}
                onStream={onStream}
              />
            ))}
            {footer}
          </>
        )}
      </div>
    </>
  );
}
