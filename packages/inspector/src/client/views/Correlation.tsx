import { scaleTime } from "d3-scale";
import { GitBranch, Network } from "lucide-react";
import { useMemo, useState } from "react";
import { JsonViewer } from "../components/JsonViewer.js";
import { trpc } from "../trpc.js";

// --- Types ---

type EventMeta = {
  correlation?: string;
  causation?: {
    action?: {
      stream?: string;
      actor?: { id?: string; name?: string };
      name?: string;
    };
    event?: { id?: number; name?: string; stream?: string };
  };
};

type Event = {
  id: number;
  name: string;
  stream: string;
  version: number;
  created: string;
  data: unknown;
  meta: EventMeta;
};

type TreeNode = {
  event: Event;
  children: TreeNode[];
  depth: number;
};

// --- Helpers ---

function streamColor(stream: string): string {
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
  for (let i = 0; i < stream.length; i++) {
    hash = (hash * 31 + stream.charCodeAt(i)) | 0;
  }
  return hues[Math.abs(hash) % hues.length];
}

function buildCausationTree(events: Event[]): TreeNode[] {
  const byId = new Map<number, Event>();
  for (const e of events) byId.set(e.id, e);

  const childMap = new Map<number, Event[]>();
  const roots: Event[] = [];

  for (const e of events) {
    const parentId = e.meta?.causation?.event?.id;
    if (parentId != null && byId.has(parentId)) {
      const list = childMap.get(parentId);
      if (list) list.push(e);
      else childMap.set(parentId, [e]);
    } else {
      roots.push(e);
    }
  }

  function buildNode(event: Event, depth: number): TreeNode {
    const children = (childMap.get(event.id) ?? [])
      .sort((a, b) => a.id - b.id)
      .map((c) => buildNode(c, depth + 1));
    return { event, children, depth };
  }

  return roots.sort((a, b) => a.id - b.id).map((r) => buildNode(r, 0));
}

function flattenTree(nodes: TreeNode[]): TreeNode[] {
  const result: TreeNode[] = [];
  function walk(node: TreeNode) {
    result.push(node);
    for (const child of node.children) walk(child);
  }
  for (const n of nodes) walk(n);
  return result;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

// --- Component ---

type Props = {
  initialCorrelation?: string;
};

export function Correlation({ initialCorrelation }: Props) {
  const [correlationId, setCorrelationId] = useState(initialCorrelation ?? "");
  const [searchInput, setSearchInput] = useState(initialCorrelation ?? "");
  const [viewMode, setViewMode] = useState<"waterfall" | "graph">("waterfall");
  const [selectedEvent, setSelectedEvent] = useState<Event | null>(null);

  const eventsQuery = trpc.query.useQuery(
    { correlation: correlationId, limit: 500, backward: false },
    { enabled: correlationId.length > 0, staleTime: 10_000 }
  );

  const events = (eventsQuery.data?.events ?? []) as unknown as Event[];

  const handleSearch = () => {
    const trimmed = searchInput.trim();
    if (trimmed) setCorrelationId(trimmed);
  };

  // Build tree
  const tree = useMemo(() => buildCausationTree(events), [events]);
  const flatNodes = useMemo(() => flattenTree(tree), [tree]);

  // Stats
  const stats = useMemo(() => {
    if (events.length === 0) return null;
    const streams = new Set<string>();
    const names = new Map<string, number>();
    let actor: string | undefined;
    let minTime = Infinity;
    let maxTime = -Infinity;

    for (const e of events) {
      streams.add(e.stream);
      names.set(e.name, (names.get(e.name) ?? 0) + 1);
      const t = new Date(e.created).getTime();
      if (t < minTime) minTime = t;
      if (t > maxTime) maxTime = t;
    }

    // Actor from first root event
    if (tree.length > 0) {
      actor = tree[0].event.meta?.causation?.action?.actor?.name;
    }

    return {
      actor,
      totalEvents: events.length,
      duration: maxTime - minTime,
      streams: [...streams],
      eventTypes: [...names.entries()].sort((a, b) => b[1] - a[1]),
      minTime,
      maxTime,
    };
  }, [events, tree]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Search bar */}
      <div className="flex items-center gap-3 border-b border-zinc-800 bg-zinc-925 px-4 py-2">
        <label className="text-[10px] uppercase tracking-wider text-zinc-500">
          Correlation
        </label>
        <input
          type="text"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          placeholder="paste correlation id..."
          className="w-80 rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 font-mono text-xs text-zinc-200 outline-none transition placeholder:text-zinc-600 focus:border-emerald-600"
        />
        <button
          onClick={handleSearch}
          className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-emerald-500"
        >
          Trace
        </button>

        {events.length > 0 && (
          <div className="ml-auto flex gap-1">
            <button
              onClick={() => setViewMode("waterfall")}
              className={`rounded p-1.5 transition ${viewMode === "waterfall" ? "bg-zinc-800 text-emerald-400" : "text-zinc-500 hover:text-zinc-300"}`}
              title="Waterfall"
            >
              <GitBranch size={14} />
            </button>
            <button
              onClick={() => setViewMode("graph")}
              className={`rounded p-1.5 transition ${viewMode === "graph" ? "bg-zinc-800 text-emerald-400" : "text-zinc-500 hover:text-zinc-300"}`}
              title="Graph"
            >
              <Network size={14} />
            </button>
          </div>
        )}
      </div>

      {/* Content */}
      {!correlationId ? (
        <div className="flex h-48 items-center justify-center text-sm text-zinc-600">
          Enter a correlation ID to trace an event chain
        </div>
      ) : eventsQuery.isLoading ? (
        <div className="flex h-48 items-center justify-center text-sm text-zinc-600">
          Loading...
        </div>
      ) : events.length === 0 ? (
        <div className="flex h-48 items-center justify-center text-sm text-zinc-600">
          No events found for this correlation
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* Main view */}
          <div
            className={`flex-1 overflow-auto ${selectedEvent ? "border-r border-zinc-800" : ""}`}
          >
            {viewMode === "waterfall" ? (
              <WaterfallView
                nodes={flatNodes}
                stats={stats!}
                onSelect={setSelectedEvent}
                selected={selectedEvent}
              />
            ) : (
              <GraphView
                tree={tree}
                events={events}
                onSelect={setSelectedEvent}
                selected={selectedEvent}
              />
            )}
          </div>

          {/* Metadata sidebar */}
          <div className="flex w-80 shrink-0 flex-col overflow-y-auto">
            {/* Stats */}
            {stats && (
              <div className="border-b border-zinc-800 bg-zinc-925 px-4 py-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[10px] uppercase tracking-wider text-zinc-500">
                    Chain
                  </span>
                  <button
                    onClick={() =>
                      void navigator.clipboard.writeText(correlationId)
                    }
                    className="font-mono text-[10px] text-zinc-400 hover:text-emerald-400"
                  >
                    {correlationId.length > 20
                      ? `${correlationId.slice(0, 20)}...`
                      : correlationId}
                  </button>
                </div>
                <div className="flex flex-col gap-1.5 text-xs">
                  {stats.actor && (
                    <div>
                      <span className="text-zinc-500">Actor </span>
                      <span className="text-zinc-300">{stats.actor}</span>
                    </div>
                  )}
                  <div>
                    <span className="text-zinc-500">Events </span>
                    <span className="text-zinc-200">{stats.totalEvents}</span>
                  </div>
                  <div>
                    <span className="text-zinc-500">Duration </span>
                    <span className="text-zinc-200">
                      {formatDuration(stats.duration)}
                    </span>
                  </div>
                  <div>
                    <span className="text-zinc-500">Streams </span>
                    <span className="text-zinc-200">
                      {stats.streams.length}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* Streams touched */}
            {stats && (
              <div className="border-b border-zinc-800 px-4 py-2">
                <span className="mb-1.5 block text-[10px] uppercase tracking-wider text-zinc-500">
                  Streams
                </span>
                <div className="flex flex-col gap-1">
                  {stats.streams.map((s) => (
                    <div key={s} className="flex items-center gap-2 text-xs">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: streamColor(s) }}
                      />
                      <span className="truncate font-mono text-zinc-300">
                        {s}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Event types */}
            {stats && (
              <div className="border-b border-zinc-800 px-4 py-2">
                <span className="mb-1.5 block text-[10px] uppercase tracking-wider text-zinc-500">
                  Event types
                </span>
                <div className="flex flex-col gap-1">
                  {stats.eventTypes.map(([name, count]) => (
                    <div
                      key={name}
                      className="flex items-center justify-between text-xs"
                    >
                      <span className="text-zinc-300">{name}</span>
                      <span className="text-zinc-500">{count}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Selected event detail */}
            {selectedEvent && (
              <div className="flex-1 px-4 py-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[10px] uppercase tracking-wider text-zinc-500">
                    Event #{selectedEvent.id}
                  </span>
                  <button
                    onClick={() => setSelectedEvent(null)}
                    className="text-zinc-500 hover:text-zinc-300"
                  >
                    &times;
                  </button>
                </div>
                <div className="mb-2 text-xs">
                  <div className="font-medium text-zinc-200">
                    {selectedEvent.name}
                  </div>
                  <div className="font-mono text-zinc-400">
                    {selectedEvent.stream}
                  </div>
                  <div className="text-zinc-500">
                    v{selectedEvent.version} &middot;{" "}
                    {new Date(selectedEvent.created).toLocaleString()}
                  </div>
                </div>
                <div className="mb-2">
                  <div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">
                    Data
                  </div>
                  <div className="rounded-md border border-zinc-800 bg-zinc-950 p-2 text-[10px]">
                    <JsonViewer data={selectedEvent.data} />
                  </div>
                </div>
                <div>
                  <div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">
                    Meta
                  </div>
                  <div className="rounded-md border border-zinc-800 bg-zinc-950 p-2 text-[10px]">
                    <JsonViewer data={selectedEvent.meta} />
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// --- Waterfall View ---

const BAR_HEIGHT = 24;
const ROW_HEIGHT = 32;
const INDENT_PX = 24;
const LEFT_LABEL = 280;

function WaterfallView({
  nodes,
  stats,
  onSelect,
  selected,
}: {
  nodes: TreeNode[];
  stats: { minTime: number; maxTime: number };
  onSelect: (e: Event) => void;
  selected: Event | null;
}) {
  const chartWidth = 600;
  const totalWidth = LEFT_LABEL + chartWidth + 16;

  const xScale = useMemo(() => {
    const pad = Math.max((stats.maxTime - stats.minTime) * 0.05, 100);
    return scaleTime()
      .domain([new Date(stats.minTime - pad), new Date(stats.maxTime + pad)])
      .range([LEFT_LABEL, totalWidth - 16]);
  }, [stats.minTime, stats.maxTime, totalWidth]);

  const ticks = useMemo(() => {
    return xScale.ticks(5).map((d) => ({
      x: xScale(d),
      label: d.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
    }));
  }, [xScale]);

  const svgHeight = nodes.length * ROW_HEIGHT + 40;

  return (
    <svg width={totalWidth} height={svgHeight} className="select-none">
      {/* Time axis */}
      <line
        x1={LEFT_LABEL}
        y1={20}
        x2={totalWidth - 16}
        y2={20}
        stroke="#3f3f46"
        strokeWidth={1}
      />
      {ticks.map((tick, i) => (
        <g key={i}>
          <line
            x1={tick.x}
            y1={16}
            x2={tick.x}
            y2={24}
            stroke="#52525b"
            strokeWidth={1}
          />
          <text
            x={tick.x}
            y={12}
            textAnchor="middle"
            className="fill-zinc-500 text-[9px]"
          >
            {tick.label}
          </text>
          <line
            x1={tick.x}
            y1={24}
            x2={tick.x}
            y2={svgHeight}
            stroke="#27272a"
            strokeWidth={1}
            strokeDasharray="2,4"
          />
        </g>
      ))}

      {/* Rows */}
      {nodes.map((node, i) => {
        const y = 30 + i * ROW_HEIGHT;
        const cx = xScale(new Date(node.event.created));
        const isSelected = selected?.id === node.event.id;
        const color = streamColor(node.event.stream);

        // Bar width: duration to next sibling or min width
        const nextNode = nodes[i + 1];
        let barEnd = cx + 20; // min width
        if (nextNode) {
          const nextX = xScale(new Date(nextNode.event.created));
          barEnd = Math.max(barEnd, nextX - 2);
        }

        // Gap detection
        const parentId = node.event.meta?.causation?.event?.id;
        const parentNode =
          parentId != null
            ? nodes.find((n) => n.event.id === parentId)
            : undefined;
        const gap = parentNode
          ? new Date(node.event.created).getTime() -
            new Date(parentNode.event.created).getTime()
          : 0;
        const hasLargeGap = gap > 1000;

        return (
          <g
            key={node.event.id}
            className="cursor-pointer"
            onClick={() => onSelect(node.event)}
          >
            {/* Row background */}
            {isSelected && (
              <rect
                x={0}
                y={y}
                width={totalWidth}
                height={ROW_HEIGHT}
                fill="#18181b"
              />
            )}

            {/* Label */}
            <text
              x={node.depth * INDENT_PX + 8}
              y={y + ROW_HEIGHT / 2 + 1}
              dominantBaseline="middle"
              className="fill-zinc-400 text-[10px]"
            >
              <tspan className="fill-zinc-300">{node.event.name}</tspan>
              <tspan className="fill-zinc-600">
                {" "}
                {node.event.stream.length > 20
                  ? `...${node.event.stream.slice(-17)}`
                  : node.event.stream}
              </tspan>
            </text>

            {/* Bar */}
            <rect
              x={cx}
              y={y + (ROW_HEIGHT - BAR_HEIGHT) / 2}
              width={Math.max(4, barEnd - cx)}
              height={BAR_HEIGHT}
              rx={3}
              fill={color}
              opacity={isSelected ? 0.9 : 0.5}
              className="transition-opacity hover:opacity-80"
            />

            {/* Event name on bar */}
            <text
              x={cx + 6}
              y={y + ROW_HEIGHT / 2 + 1}
              dominantBaseline="middle"
              className="fill-white text-[9px] font-medium"
              style={{ textShadow: "0 1px 2px rgba(0,0,0,0.5)" }}
            >
              #{node.event.id}
            </text>

            {/* Gap indicator */}
            {hasLargeGap && (
              <text
                x={cx - 4}
                y={y + ROW_HEIGHT / 2 + 1}
                textAnchor="end"
                dominantBaseline="middle"
                className="fill-amber-500 text-[8px]"
              >
                +{formatDuration(gap)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// --- Graph View (DAG) ---

const NODE_W = 140;
const NODE_H = 36;
const H_GAP = 40;
const V_GAP = 20;

function GraphView({
  tree,
  events,
  onSelect,
  selected,
}: {
  tree: TreeNode[];
  events: Event[];
  onSelect: (e: Event) => void;
  selected: Event | null;
}) {
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    event: Event;
  } | null>(null);

  // Layout: assign x,y per node based on depth and sibling index
  const layout = useMemo(() => {
    const positions = new Map<number, { x: number; y: number }>();
    const depthCounts = new Map<number, number>();

    function layoutNode(node: TreeNode) {
      const count = depthCounts.get(node.depth) ?? 0;
      depthCounts.set(node.depth, count + 1);
      positions.set(node.event.id, {
        x: node.depth * (NODE_W + H_GAP) + 20,
        y: count * (NODE_H + V_GAP) + 20,
      });
      for (const child of node.children) layoutNode(child);
    }
    for (const root of tree) layoutNode(root);

    // Edges
    const edges: { from: number; to: number }[] = [];
    for (const e of events) {
      const parentId = e.meta?.causation?.event?.id;
      if (parentId != null && positions.has(parentId)) {
        edges.push({ from: parentId, to: e.id });
      }
    }

    // Compute bounds
    let maxX = 0;
    let maxY = 0;
    for (const pos of positions.values()) {
      if (pos.x + NODE_W > maxX) maxX = pos.x + NODE_W;
      if (pos.y + NODE_H > maxY) maxY = pos.y + NODE_H;
    }

    return { positions, edges, width: maxX + 40, height: maxY + 40 };
  }, [tree, events]);

  return (
    <div className="relative overflow-auto">
      <svg width={layout.width} height={layout.height} className="select-none">
        {/* Edges */}
        {layout.edges.map(({ from, to }) => {
          const fp = layout.positions.get(from);
          const tp = layout.positions.get(to);
          if (!fp || !tp) return null;
          return (
            <line
              key={`${from}-${to}`}
              x1={fp.x + NODE_W}
              y1={fp.y + NODE_H / 2}
              x2={tp.x}
              y2={tp.y + NODE_H / 2}
              stroke="#3f3f46"
              strokeWidth={1.5}
              markerEnd="url(#arrow)"
            />
          );
        })}

        {/* Arrow marker */}
        <defs>
          <marker
            id="arrow"
            viewBox="0 0 10 10"
            refX="10"
            refY="5"
            markerWidth="8"
            markerHeight="8"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#52525b" />
          </marker>
        </defs>

        {/* Nodes */}
        {events.map((event) => {
          const pos = layout.positions.get(event.id);
          if (!pos) return null;
          const color = streamColor(event.stream);
          const isSelected = selected?.id === event.id;

          return (
            <g
              key={event.id}
              className="cursor-pointer"
              onClick={() => onSelect(event)}
              onMouseEnter={(ev) =>
                setTooltip({ x: ev.clientX, y: ev.clientY, event })
              }
              onMouseLeave={() => setTooltip(null)}
            >
              <rect
                x={pos.x}
                y={pos.y}
                width={NODE_W}
                height={NODE_H}
                rx={6}
                fill={color + "22"}
                stroke={isSelected ? color : color + "66"}
                strokeWidth={isSelected ? 2 : 1}
              />
              <text
                x={pos.x + 8}
                y={pos.y + 14}
                className="fill-zinc-200 text-[10px] font-medium"
              >
                {event.name.length > 18
                  ? event.name.slice(0, 16) + "..."
                  : event.name}
              </text>
              <text
                x={pos.x + 8}
                y={pos.y + 27}
                className="fill-zinc-500 text-[8px]"
              >
                #{event.id}{" "}
                {event.stream.length > 16
                  ? `...${event.stream.slice(-13)}`
                  : event.stream}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Tooltip */}
      {tooltip && (
        <div
          className="pointer-events-none fixed z-50 max-w-xs rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-[10px] shadow-xl"
          style={{ left: tooltip.x + 12, top: tooltip.y - 10 }}
        >
          <div className="font-medium text-zinc-200">{tooltip.event.name}</div>
          <div className="font-mono text-zinc-400">{tooltip.event.stream}</div>
          <div className="text-zinc-500">
            #{tooltip.event.id} v{tooltip.event.version} &middot;{" "}
            {new Date(tooltip.event.created).toLocaleString()}
          </div>
          {tooltip.event.data != null && (
            <div className="mt-1 border-t border-zinc-800 pt-1 text-[9px]">
              <JsonViewer data={tooltip.event.data} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
