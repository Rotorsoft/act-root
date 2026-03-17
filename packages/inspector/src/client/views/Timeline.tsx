import { scaleLinear, scaleTime } from "d3-scale";
import { Database, GitBranch, Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { FilterBar } from "../components/FilterBar.js";
import { JsonViewer } from "../components/JsonViewer.js";
import { StatsBar } from "../components/StatsBar.js";
import { useFilterStore } from "../stores/filters.js";
import { trpc } from "../trpc.js";

type Event = {
  id: number;
  name: string;
  stream: string;
  version: number;
  created: string;
  data: unknown;
  meta: Record<string, unknown>;
};

const SWIMLANE_HEIGHT = 28;
const DOT_RADIUS = 4;
const AXIS_HEIGHT = 32;
const LEFT_GUTTER = 180;
const MIN_WIDTH = 600;
const ZOOM_FACTOR = 0.3;

/** Deterministic color from event name — same as EventRow */
function nameHue(name: string): string {
  const hues = [
    "#38bdf8",
    "#fbbf24",
    "#34d399",
    "#a78bfa",
    "#fb7185",
    "#22d3ee",
    "#f97316",
    "#818cf8",
    "#2dd4bf",
    "#f472b6",
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return hues[Math.abs(hash) % hues.length];
}

/** Extract actor name from event meta */
function actorName(event: Event): string | undefined {
  const meta = event.meta as Record<string, any>;
  return meta?.causation?.action?.actor?.name;
}

type TooltipData = {
  x: number;
  y: number;
  event: Event;
};

type TimelineProps = {
  onTrace?: (id: string) => void;
  onStream?: (stream: string) => void;
};

export function Timeline({ onTrace, onStream }: TimelineProps) {
  const [filters] = useFilterStore();
  const svgRef = useRef<SVGSVGElement>(null);
  const [tooltip, setTooltip] = useState<TooltipData | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<Event | null>(null);
  const [containerWidth, setContainerWidth] = useState(MIN_WIDTH);

  // View domain — null means "fit all data"
  const [viewDomain, setViewDomain] = useState<[number, number] | null>(null);

  // Pan state
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef<{ x: number; domain: [number, number] } | null>(null);

  // Observe container width
  const resizeRef = useRef<ResizeObserver>(undefined);
  const containerCallback = useCallback((node: HTMLDivElement | null) => {
    if (resizeRef.current) resizeRef.current.disconnect();
    if (node) {
      setContainerWidth(node.clientWidth);
      resizeRef.current = new ResizeObserver((entries) => {
        for (const entry of entries) {
          setContainerWidth(entry.contentRect.width);
        }
      });
      resizeRef.current.observe(node);
    }
  }, []);

  const eventsQuery = trpc.query.useQuery(
    {
      stream: filters.stream,
      names: filters.names,
      limit: 500,
      created_after: filters.created_after,
      created_before: filters.created_before,
      backward: false,
      correlation: filters.correlation,
    },
    { staleTime: 3_000 }
  );

  const events = (eventsQuery.data?.events ?? []) as unknown as Event[];

  // Compute data extent
  const dataExtent = useMemo((): [number, number] | null => {
    if (events.length === 0) return null;
    let minTime = Infinity;
    let maxTime = -Infinity;
    for (const e of events) {
      const t = new Date(e.created).getTime();
      if (t < minTime) minTime = t;
      if (t > maxTime) maxTime = t;
    }
    const pad = Math.max((maxTime - minTime) * 0.02, 1000);
    return [minTime - pad, maxTime + pad];
  }, [events]);

  // Active domain: view override or data extent
  const activeDomain = viewDomain ?? dataExtent ?? [Date.now(), Date.now()];

  // Streams
  const streams = useMemo(() => {
    const set = new Set<string>();
    for (const e of events) set.add(e.stream);
    return [...set].sort();
  }, [events]);

  const svgHeight = AXIS_HEIGHT + streams.length * SWIMLANE_HEIGHT + 16;
  const chartRight = containerWidth - 16;

  const xScale = useMemo(
    () =>
      scaleTime()
        .domain([new Date(activeDomain[0]), new Date(activeDomain[1])])
        .range([LEFT_GUTTER, chartRight]),
    [activeDomain, chartRight]
  );

  // Ticks
  const ticks = useMemo(() => {
    const tickCount = Math.max(2, Math.floor((chartRight - LEFT_GUTTER) / 160));
    return xScale.ticks(tickCount).map((d) => ({
      x: xScale(d),
      label: formatTick(d),
    }));
  }, [xScale, chartRight]);

  // Group events by stream
  const eventsByStream = useMemo(() => {
    const map = new Map<string, Event[]>();
    for (const e of events) {
      const list = map.get(e.stream);
      if (list) list.push(e);
      else map.set(e.stream, [e]);
    }
    return map;
  }, [events]);

  const density = events.length > 500;
  const isZoomed = viewDomain !== null;
  const domainSpan = activeDomain[1] - activeDomain[0];
  const zoomLevel =
    dataExtent && domainSpan > 0
      ? Math.round(((dataExtent[1] - dataExtent[0]) / domainSpan) * 100)
      : 100;

  // --- Interaction handlers ---

  const zoomAt = useCallback(
    (clientX: number, factor: number) => {
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const svgX = clientX - rect.left;

      // Time at cursor
      const t = xScale.invert(svgX).getTime();
      const [d0, d1] = activeDomain;
      const span = d1 - d0;
      const newSpan = span * (1 - factor);
      if (newSpan < 100) return; // min 100ms

      // Keep cursor position stable
      const ratio = (t - d0) / span;
      const newD0 = t - ratio * newSpan;
      const newD1 = newD0 + newSpan;
      setViewDomain([newD0, newD1]);
    },
    [xScale, activeDomain]
  );

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? ZOOM_FACTOR : -ZOOM_FACTOR;
      zoomAt(e.clientX, factor);
    },
    [zoomAt]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      setIsPanning(true);
      panStart.current = { x: e.clientX, domain: [...activeDomain] };
    },
    [activeDomain]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isPanning || !panStart.current) return;
      const dx = e.clientX - panStart.current.x;
      const pxPerMs =
        (chartRight - LEFT_GUTTER) /
        (panStart.current.domain[1] - panStart.current.domain[0]);
      const dtMs = -dx / pxPerMs;
      setViewDomain([
        panStart.current.domain[0] + dtMs,
        panStart.current.domain[1] + dtMs,
      ]);
    },
    [isPanning, chartRight]
  );

  const handleMouseUp = useCallback(() => {
    setIsPanning(false);
    panStart.current = null;
  }, []);

  const handleReset = useCallback(() => setViewDomain(null), []);

  const handleZoomIn = useCallback(() => {
    zoomAt(LEFT_GUTTER + (chartRight - LEFT_GUTTER) / 2, ZOOM_FACTOR);
  }, [zoomAt, chartRight]);

  const handleZoomOut = useCallback(() => {
    zoomAt(LEFT_GUTTER + (chartRight - LEFT_GUTTER) / 2, -ZOOM_FACTOR);
  }, [zoomAt, chartRight]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <FilterBar />
      <StatsBar />

      {/* Zoom controls */}
      {events.length > 0 && (
        <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-925 px-4 py-1.5">
          <button
            onClick={handleZoomIn}
            className="rounded p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-300"
            title="Zoom in"
          >
            <ZoomIn size={14} />
          </button>
          <button
            onClick={handleZoomOut}
            className="rounded p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-300"
            title="Zoom out"
          >
            <ZoomOut size={14} />
          </button>
          {isZoomed && (
            <button
              onClick={handleReset}
              className="rounded p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-300"
              title="Fit all"
            >
              <Maximize2 size={14} />
            </button>
          )}
          <span className="text-[10px] text-zinc-600">
            {zoomLevel}%{isZoomed && " · scroll to zoom · drag to pan"}
          </span>
        </div>
      )}

      <div ref={containerCallback} className="flex-1 overflow-auto">
        {eventsQuery.isLoading ? (
          <div className="flex h-48 items-center justify-center text-sm text-zinc-600">
            Loading events...
          </div>
        ) : events.length === 0 ? (
          <div className="flex h-48 items-center justify-center text-sm text-zinc-600">
            No events found
          </div>
        ) : (
          <div className="relative">
            <svg
              ref={svgRef}
              width={containerWidth}
              height={svgHeight}
              className={`select-none ${isPanning ? "cursor-grabbing" : "cursor-grab"}`}
              onWheel={handleWheel}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
            >
              {/* Time axis */}
              <line
                x1={LEFT_GUTTER}
                y1={AXIS_HEIGHT}
                x2={chartRight}
                y2={AXIS_HEIGHT}
                stroke="#3f3f46"
                strokeWidth={1}
              />
              {ticks.map((tick, i) => (
                <g key={i}>
                  <line
                    x1={tick.x}
                    y1={AXIS_HEIGHT - 4}
                    x2={tick.x}
                    y2={AXIS_HEIGHT + 4}
                    stroke="#52525b"
                    strokeWidth={1}
                  />
                  <text
                    x={tick.x}
                    y={AXIS_HEIGHT - 10}
                    textAnchor="middle"
                    className="fill-zinc-500 text-[9px]"
                  >
                    {tick.label}
                  </text>
                  <line
                    x1={tick.x}
                    y1={AXIS_HEIGHT}
                    x2={tick.x}
                    y2={svgHeight}
                    stroke="#27272a"
                    strokeWidth={1}
                    strokeDasharray="2,4"
                  />
                </g>
              ))}

              {/* Swimlanes */}
              {streams.map((stream, si) => {
                const y =
                  AXIS_HEIGHT + si * SWIMLANE_HEIGHT + SWIMLANE_HEIGHT / 2;
                const streamEvents = eventsByStream.get(stream) ?? [];

                return (
                  <g key={stream}>
                    {si % 2 === 0 && (
                      <rect
                        x={0}
                        y={AXIS_HEIGHT + si * SWIMLANE_HEIGHT}
                        width={containerWidth}
                        height={SWIMLANE_HEIGHT}
                        fill="#18181b"
                        opacity={0.5}
                      />
                    )}
                    <text
                      x={LEFT_GUTTER - 8}
                      y={y + 1}
                      textAnchor="end"
                      dominantBaseline="middle"
                      className="fill-zinc-400 text-[10px]"
                    >
                      {stream.length > 22 ? `...${stream.slice(-19)}` : stream}
                    </text>
                    <line
                      x1={LEFT_GUTTER}
                      y1={y}
                      x2={chartRight}
                      y2={y}
                      stroke="#27272a"
                      strokeWidth={1}
                    />
                    {!density &&
                      streamEvents.map((e) => {
                        const cx = xScale(new Date(e.created));
                        if (cx < LEFT_GUTTER || cx > chartRight) return null;
                        return (
                          <circle
                            key={e.id}
                            cx={cx}
                            cy={y}
                            r={DOT_RADIUS}
                            fill={nameHue(e.name)}
                            opacity={0.85}
                            className="cursor-pointer transition-opacity hover:opacity-100"
                            onMouseEnter={(ev) => {
                              ev.stopPropagation();
                              setTooltip({
                                x: ev.clientX,
                                y: ev.clientY,
                                event: e,
                              });
                            }}
                            onMouseLeave={() => setTooltip(null)}
                            onClick={(ev) => {
                              ev.stopPropagation();
                              setSelectedEvent(e);
                              setTooltip(null);
                            }}
                          />
                        );
                      })}
                    {density &&
                      renderDensity(streamEvents, xScale, y, containerWidth)}
                  </g>
                );
              })}
            </svg>

            {/* Tooltip */}
            {tooltip && !isPanning && (
              <div
                className="pointer-events-none fixed z-50 max-w-sm rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-[10px] shadow-xl"
                style={{ left: tooltip.x + 12, top: tooltip.y - 10 }}
              >
                <div className="mb-1 flex items-center gap-2">
                  <span
                    className="inline-block rounded px-1.5 py-0.5 text-[10px] font-medium"
                    style={{
                      backgroundColor: nameHue(tooltip.event.name) + "22",
                      color: nameHue(tooltip.event.name),
                    }}
                  >
                    {String(tooltip.event.name)}
                  </span>
                  <span className="font-mono text-zinc-500">
                    #{tooltip.event.id} v{tooltip.event.version}
                  </span>
                </div>
                <div className="mb-1 font-mono text-zinc-400">
                  {tooltip.event.stream}
                </div>
                <div className="mb-1.5 flex items-center gap-2 text-zinc-500">
                  <span>
                    {new Date(tooltip.event.created).toLocaleString()}
                  </span>
                  {actorName(tooltip.event) && (
                    <span className="text-zinc-400">
                      {actorName(tooltip.event)}
                    </span>
                  )}
                </div>
                {tooltip.event.data != null && (
                  <div className="border-t border-zinc-800 pt-1.5 text-[9px]">
                    <JsonViewer data={tooltip.event.data} />
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {/* Event detail dialog */}
        {selectedEvent && (
          <EventDetailDialog
            event={selectedEvent}
            onClose={() => setSelectedEvent(null)}
            onTrace={onTrace}
            onStream={onStream}
          />
        )}
      </div>
    </div>
  );
}

function EventDetailDialog({
  event,
  onClose,
  onTrace,
  onStream,
}: {
  event: Event;
  onClose: () => void;
  onTrace?: (id: string) => void;
  onStream?: (stream: string) => void;
}) {
  const meta = event.meta as Record<string, any>;
  const correlation = meta?.correlation as string | undefined;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="max-h-[80vh] w-full max-w-lg overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-900 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span
              className="inline-block rounded px-2 py-0.5 text-xs font-medium"
              style={{
                backgroundColor: nameHue(event.name) + "22",
                color: nameHue(event.name),
              }}
            >
              {event.name}
            </span>
            <span className="font-mono text-xs text-zinc-500">
              #{event.id} v{event.version}
            </span>
          </div>
          <button
            onClick={onClose}
            className="text-zinc-500 transition hover:text-zinc-300"
          >
            &times;
          </button>
        </div>

        {/* Stream + correlation + time + actor */}
        <div className="mb-3 flex flex-col gap-1 text-xs">
          <div className="flex items-center gap-1">
            <span className="text-zinc-500">Stream</span>
            <span className="font-mono text-zinc-300">{event.stream}</span>
            {onStream && (
              <button
                onClick={() => {
                  onStream(event.stream);
                  onClose();
                }}
                title="Open in Streams"
                className="text-emerald-400/70 transition hover:text-emerald-300"
              >
                <Database size={11} />
              </button>
            )}
          </div>
          {correlation && (
            <div className="flex items-center gap-1">
              <span className="text-zinc-500">Correlation</span>
              <span className="font-mono text-zinc-300">{correlation}</span>
              {onTrace && (
                <button
                  onClick={() => {
                    onTrace(correlation);
                    onClose();
                  }}
                  title="Trace correlation"
                  className="text-emerald-400/70 transition hover:text-emerald-300"
                >
                  <GitBranch size={11} />
                </button>
              )}
            </div>
          )}
          <div>
            <span className="text-zinc-500">Created </span>
            <span className="text-zinc-300">
              {new Date(event.created).toLocaleString()}
            </span>
          </div>
          {actorName(event) && (
            <div>
              <span className="text-zinc-500">Actor </span>
              <span className="text-zinc-300">{actorName(event)}</span>
            </div>
          )}
        </div>

        {/* Data */}
        <div className="mb-3">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">
            Data
          </div>
          <div className="rounded-md border border-zinc-800 bg-zinc-950 p-3 text-[10px]">
            <JsonViewer data={event.data} />
          </div>
        </div>

        {/* Meta */}
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">
            Meta
          </div>
          <div className="rounded-md border border-zinc-800 bg-zinc-950 p-3 text-[10px]">
            <JsonViewer data={event.meta} />
          </div>
        </div>
      </div>
    </div>
  );
}

function renderDensity(
  events: Event[],
  xScale: ReturnType<typeof scaleTime>,
  y: number,
  width: number
) {
  const bucketCount = Math.max(1, Math.floor((width - LEFT_GUTTER) / 6));
  const [domainStart, domainEnd] = xScale.domain().map((d) => d.getTime());
  const bucketWidth = (domainEnd - domainStart) / bucketCount;
  if (bucketWidth <= 0) return null;

  const buckets = new Array<number>(bucketCount).fill(0);
  for (const e of events) {
    const t = new Date(e.created).getTime();
    const bi = Math.min(
      bucketCount - 1,
      Math.floor((t - domainStart) / bucketWidth)
    );
    if (bi >= 0) buckets[bi]++;
  }

  const maxCount = Math.max(...buckets, 1);
  const heightScale = scaleLinear()
    .domain([0, maxCount])
    .range([1, SWIMLANE_HEIGHT - 4]);

  return buckets.map((count, i) => {
    if (count === 0) return null;
    const x = xScale(new Date(domainStart + i * bucketWidth));
    const barW = Math.max(
      2,
      (xScale(new Date(domainStart + (i + 1) * bucketWidth)) as number) -
        (x as number) -
        1
    );
    const barH = heightScale(count);
    return (
      <rect
        key={i}
        x={x as number}
        y={y - barH / 2}
        width={barW}
        height={barH}
        fill="#34d399"
        opacity={0.4 + 0.5 * (count / maxCount)}
        rx={1}
      />
    );
  });
}

function formatTick(d: Date): string {
  const h = d.getHours();
  const m = d.getMinutes();
  const s = d.getSeconds();
  if (h === 0 && m === 0 && s === 0) {
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  }
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: s > 0 ? "2-digit" : undefined,
  });
}
