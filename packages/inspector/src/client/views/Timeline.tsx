import { scaleLinear, scaleTime } from "d3-scale";
import { useCallback, useMemo, useRef, useState } from "react";
import { FilterBar } from "../components/FilterBar.js";
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

type TooltipData = {
  x: number;
  y: number;
  event: Event;
};

export function Timeline() {
  const [filters] = useFilterStore();
  const svgRef = useRef<SVGSVGElement>(null);
  const [tooltip, setTooltip] = useState<TooltipData | null>(null);
  const [containerWidth, setContainerWidth] = useState(MIN_WIDTH);

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
    { staleTime: 10_000 }
  );

  const events = (eventsQuery.data?.events ?? []) as unknown as Event[];

  // Group by stream and compute scales
  const { streams, xScale, svgHeight } = useMemo(() => {
    if (events.length === 0) {
      return {
        streams: [] as string[],
        xScale: scaleTime()
          .domain([new Date(), new Date()])
          .range([LEFT_GUTTER, containerWidth - 16]),
        svgHeight: AXIS_HEIGHT + 100,
      };
    }

    const streamSet = new Set<string>();
    let minTime = Infinity;
    let maxTime = -Infinity;
    for (const e of events) {
      streamSet.add(e.stream);
      const t = new Date(e.created).getTime();
      if (t < minTime) minTime = t;
      if (t > maxTime) maxTime = t;
    }

    // Add a small padding to the time domain
    const pad = Math.max((maxTime - minTime) * 0.02, 1000);
    const streams = [...streamSet].sort();
    const xScale = scaleTime()
      .domain([new Date(minTime - pad), new Date(maxTime + pad)])
      .range([LEFT_GUTTER, containerWidth - 16]);

    return {
      streams,
      xScale,
      svgHeight: AXIS_HEIGHT + streams.length * SWIMLANE_HEIGHT + 16,
    };
  }, [events, containerWidth]);

  // Build ticks
  const ticks = useMemo(() => {
    const tickCount = Math.max(
      2,
      Math.floor((containerWidth - LEFT_GUTTER) / 120)
    );
    return xScale.ticks(tickCount).map((d) => ({
      x: xScale(d),
      label: formatTick(d),
    }));
  }, [xScale, containerWidth]);

  // Group events by stream for swimlanes
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <FilterBar />
      <StatsBar />

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
              className="select-none"
            >
              {/* Time axis */}
              <line
                x1={LEFT_GUTTER}
                y1={AXIS_HEIGHT}
                x2={containerWidth - 16}
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
                  {/* Grid line */}
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
                    {/* Swimlane background */}
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
                    {/* Stream label */}
                    <text
                      x={LEFT_GUTTER - 8}
                      y={y + 1}
                      textAnchor="end"
                      dominantBaseline="middle"
                      className="fill-zinc-400 text-[10px]"
                    >
                      {stream.length > 22 ? `...${stream.slice(-19)}` : stream}
                    </text>
                    {/* Swimlane line */}
                    <line
                      x1={LEFT_GUTTER}
                      y1={y}
                      x2={containerWidth - 16}
                      y2={y}
                      stroke="#27272a"
                      strokeWidth={1}
                    />
                    {/* Event dots */}
                    {!density &&
                      streamEvents.map((e) => {
                        const cx = xScale(new Date(e.created));
                        return (
                          <circle
                            key={e.id}
                            cx={cx}
                            cy={y}
                            r={DOT_RADIUS}
                            fill={nameHue(e.name)}
                            opacity={0.85}
                            className="cursor-pointer transition-opacity hover:opacity-100"
                            onMouseEnter={(ev) =>
                              setTooltip({
                                x: ev.clientX,
                                y: ev.clientY,
                                event: e,
                              })
                            }
                            onMouseLeave={() => setTooltip(null)}
                          />
                        );
                      })}
                    {/* Density bars when too many events */}
                    {density &&
                      renderDensity(streamEvents, xScale, y, containerWidth)}
                  </g>
                );
              })}
            </svg>

            {/* Tooltip */}
            {tooltip && (
              <div
                className="pointer-events-none fixed z-50 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs shadow-xl"
                style={{ left: tooltip.x + 12, top: tooltip.y - 10 }}
              >
                <div className="font-medium text-zinc-200">
                  {String(tooltip.event.name)}
                </div>
                <div className="text-zinc-400">{tooltip.event.stream}</div>
                <div className="text-zinc-500">
                  v{tooltip.event.version} &middot;{" "}
                  {new Date(tooltip.event.created).toLocaleString()}
                </div>
              </div>
            )}
          </div>
        )}
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
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: s > 0 ? "2-digit" : undefined,
  });
}
