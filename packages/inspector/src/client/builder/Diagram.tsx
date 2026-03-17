import { Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import type { DomainModel, ValidationWarning } from "./types.js";

/**
 * Event Modeling diagram layout:
 * - Horizontal timeline (left to right)
 * - Swimlanes per aggregate (state)
 * - Per swimlane: Commands (blue, top) → Events (orange, middle) → Projections (green, bottom)
 * - Reactions (purple) connect events to commands in other swimlanes
 */

const COLORS = {
  action: { bg: "#1e3a5f", border: "#2563eb", text: "#60a5fa" },
  event: { bg: "#4a2c17", border: "#ea580c", text: "#fb923c" },
  state: { bg: "#27272a", border: "#52525b", text: "#a1a1aa" },
  reaction: { bg: "#2e1a47", border: "#7c3aed", text: "#a78bfa" },
  projection: { bg: "#0d3320", border: "#16a34a", text: "#4ade80" },
  invariant: { bg: "#3b1219", border: "#dc2626", text: "#f87171" },
};

const NODE_W = 130;
const NODE_H = 30;
const H_GAP = 20;
const SWIMLANE_H = 120;
const SWIMLANE_LABEL_W = 120;
const CMD_Y = 10; // commands offset within swimlane (top)
const EVT_Y = 45; // events offset within swimlane (middle)
// projections and reactions placed below all swimlanes

type Pos = { x: number; y: number };
type NodeData = {
  key: string;
  pos: Pos;
  type: keyof typeof COLORS;
  label: string;
  sublabel?: string;
  line?: number;
};
type Edge = { from: Pos; to: Pos; color: string; dashed?: boolean };
type Swimlane = { label: string; y: number; line?: number };

type Props = {
  model: DomainModel;
  warnings: ValidationWarning[];
  onClickLine?: (line: number) => void;
};

export function Diagram({ model, warnings, onClickLine }: Props) {
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    text: string;
  } | null>(null);
  const warningSet = new Set(warnings.map((w) => w.element).filter(Boolean));

  // Pan & zoom
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const isPanning = useRef(false);
  const panStart = useRef({ x: 0, y: 0, px: 0, py: 0 });

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setZoom((z) =>
      Math.max(0.2, Math.min(3, z * (e.deltaY < 0 ? 1.15 : 1 / 1.15)))
    );
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      isPanning.current = true;
      panStart.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
    },
    [pan]
  );

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isPanning.current) return;
    setPan({
      x: panStart.current.px + (e.clientX - panStart.current.x),
      y: panStart.current.py + (e.clientY - panStart.current.y),
    });
  }, []);

  const handleMouseUp = useCallback(() => {
    isPanning.current = false;
  }, []);
  const handleReset = useCallback(() => {
    setPan({ x: 0, y: 0 });
    setZoom(1);
  }, []);

  const { nodes, edges, swimlanes, width, height } = useMemo(() => {
    const nodes: NodeData[] = [];
    const edges: Edge[] = [];
    const swimlanes: Swimlane[] = [];
    const eventPositions = new Map<string, Pos>();

    // Merge partial states
    const stateByName = new Map<string, (typeof model.states)[0]>();
    for (const s of model.states) {
      const existing = stateByName.get(s.name);
      if (existing) {
        existing.events.push(
          ...s.events.filter(
            (e) => !existing.events.some((x) => x.name === e.name)
          )
        );
        existing.actions.push(
          ...s.actions.filter(
            (a) => !existing.actions.some((x) => x.name === a.name)
          )
        );
      } else {
        stateByName.set(s.name, {
          ...s,
          events: [...s.events],
          actions: [...s.actions],
        });
      }
    }
    const mergedStates = [...stateByName.values()];

    // Layout: one swimlane per state, events spread horizontally
    let swimlaneY = 0;

    for (const state of mergedStates) {
      swimlanes.push({ label: state.name, y: swimlaneY, line: state.line });

      // Spread events horizontally
      let eventX = SWIMLANE_LABEL_W + H_GAP;
      for (const event of state.events) {
        const eKey = `event:${event.name}`;
        const ePos = { x: eventX, y: swimlaneY + EVT_Y };
        nodes.push({
          key: eKey,
          pos: ePos,
          type: "event",
          label: event.name,
          sublabel: event.hasCustomPatch ? "patch" : undefined,
          line: event.line,
        });
        eventPositions.set(event.name, ePos);
        eventX += NODE_W + H_GAP;
      }

      // Place actions above their emitted events
      for (const action of state.actions) {
        // Position above the first emitted event, or next available slot
        let actionX = SWIMLANE_LABEL_W + H_GAP;
        if (action.emits.length > 0) {
          const firstEventPos = eventPositions.get(action.emits[0]);
          if (firstEventPos) actionX = firstEventPos.x;
        }

        const aKey = `action:${action.name}`;
        const aPos = { x: actionX, y: swimlaneY + CMD_Y };
        nodes.push({
          key: aKey,
          pos: aPos,
          type: "action",
          label: action.name,
          sublabel:
            action.invariants.length > 0
              ? `${action.invariants.length} guard(s)`
              : undefined,
          line: action.line,
        });

        // Action → Event edges (vertical down)
        for (const ename of action.emits) {
          const ePos = eventPositions.get(ename);
          if (ePos) {
            edges.push({
              from: { x: aPos.x + NODE_W / 2, y: aPos.y + NODE_H },
              to: { x: ePos.x + NODE_W / 2, y: ePos.y },
              color: COLORS.action.border,
            });
          }
        }
      }

      swimlaneY += SWIMLANE_H;
    }

    // Projections — placed below the events they handle
    const projY = swimlaneY + 10;
    let projX = SWIMLANE_LABEL_W + H_GAP;
    for (const proj of model.projections) {
      const pKey = `projection:${proj.name}`;
      const pPos = { x: projX, y: projY };
      nodes.push({
        key: pKey,
        pos: pPos,
        type: "projection",
        label: proj.name,
        line: proj.line,
      });

      // Event → Projection edges
      for (const ename of proj.handles) {
        const ePos = eventPositions.get(ename);
        if (ePos) {
          edges.push({
            from: { x: ePos.x + NODE_W / 2, y: ePos.y + NODE_H },
            to: { x: pPos.x + NODE_W / 2, y: pPos.y },
            color: COLORS.projection.border,
            dashed: true,
          });
        }
      }

      projX += NODE_W + H_GAP;
    }

    // Reactions — placed below events, connecting to other swimlanes
    const allReactions = [
      ...model.slices.flatMap((s) => s.reactions),
      ...model.reactions,
    ];
    let reactX = projX + H_GAP;
    const reactY = projY;
    for (const reaction of allReactions) {
      const rKey = `reaction:${reaction.event}`;
      const rPos = { x: reactX, y: reactY };
      nodes.push({
        key: rKey,
        pos: rPos,
        type: "reaction",
        label: `on ${reaction.event}`,
        sublabel: reaction.isVoid ? "void" : "drain",
        line: reaction.line,
      });

      // Event → Reaction edge
      const ePos = eventPositions.get(reaction.event);
      if (ePos) {
        edges.push({
          from: { x: ePos.x + NODE_W / 2, y: ePos.y + NODE_H },
          to: { x: rPos.x + NODE_W / 2, y: rPos.y },
          color: COLORS.reaction.border,
          dashed: true,
        });
      }

      reactX += NODE_W + H_GAP;
    }

    // Compute bounds
    let maxW = SWIMLANE_LABEL_W;
    let maxH = 0;
    for (const n of nodes) {
      maxW = Math.max(maxW, n.pos.x + NODE_W);
      maxH = Math.max(maxH, n.pos.y + NODE_H);
    }

    return { nodes, edges, swimlanes, width: maxW + 40, height: maxH + 40 };
  }, [model]);

  if (model.states.length === 0 && model.projections.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-zinc-600">
        Write or generate Act code to see the diagram
      </div>
    );
  }

  const svgW = Math.max(width, 600);
  const svgH = Math.max(height, 300);

  return (
    <div className="relative flex h-full flex-col bg-zinc-950">
      {/* Zoom controls */}
      <div className="flex items-center gap-1.5 border-b border-zinc-800 bg-zinc-925 px-3 py-1">
        <button
          onClick={() => setZoom((z) => Math.min(3, z * 1.25))}
          className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
          title="Zoom in"
        >
          <ZoomIn size={13} />
        </button>
        <button
          onClick={() => setZoom((z) => Math.max(0.2, z / 1.25))}
          className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
          title="Zoom out"
        >
          <ZoomOut size={13} />
        </button>
        <button
          onClick={handleReset}
          className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
          title="Fit"
        >
          <Maximize2 size={13} />
        </button>
        <span className="text-[9px] text-zinc-600">
          {Math.round(zoom * 100)}% · scroll to zoom · drag to pan
        </span>
      </div>

      <div
        className={`flex-1 overflow-hidden ${isPanning.current ? "cursor-grabbing" : "cursor-grab"}`}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        <svg
          width="100%"
          height="100%"
          viewBox={`${-pan.x / zoom} ${-pan.y / zoom} ${svgW / zoom} ${svgH / zoom}`}
          className="select-none"
        >
          {/* Swimlane backgrounds and labels */}
          {swimlanes.map((sl, i) => (
            <g key={sl.label}>
              {i % 2 === 0 && (
                <rect
                  x={0}
                  y={sl.y}
                  width={svgW}
                  height={SWIMLANE_H}
                  fill="#18181b"
                  opacity={0.4}
                />
              )}
              <line
                x1={0}
                y1={sl.y + SWIMLANE_H}
                x2={svgW}
                y2={sl.y + SWIMLANE_H}
                stroke="#27272a"
                strokeWidth={1}
              />
              <text
                x={8}
                y={sl.y + SWIMLANE_H / 2}
                dominantBaseline="middle"
                fill={COLORS.state.text}
                className="text-[11px] font-medium"
              >
                {sl.label}
              </text>
            </g>
          ))}

          {/* Lane labels for rows below swimlanes */}
          {(model.projections.length > 0 ||
            model.slices.some((s) => s.reactions.length > 0) ||
            model.reactions.length > 0) && (
            <text
              x={8}
              y={swimlanes.length * SWIMLANE_H + 25}
              dominantBaseline="middle"
              fill="#52525b"
              className="text-[9px]"
            >
              Projections & Reactions
            </text>
          )}

          {/* Edges */}
          {edges.map((edge, i) => {
            const dx = edge.to.x - edge.from.x;
            const dy = edge.to.y - edge.from.y;
            const isStraight = Math.abs(dx) < 5;

            return (
              <path
                key={i}
                d={
                  isStraight
                    ? `M ${edge.from.x} ${edge.from.y} L ${edge.to.x} ${edge.to.y}`
                    : `M ${edge.from.x} ${edge.from.y} C ${edge.from.x} ${edge.from.y + dy * 0.5}, ${edge.to.x} ${edge.to.y - dy * 0.5}, ${edge.to.x} ${edge.to.y}`
                }
                fill="none"
                stroke={edge.color}
                strokeWidth={1.5}
                strokeDasharray={edge.dashed ? "4,3" : undefined}
                opacity={0.6}
                markerEnd="url(#arrow)"
              />
            );
          })}

          <defs>
            <marker
              id="arrow"
              viewBox="0 0 10 10"
              refX="10"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#52525b" />
            </marker>
          </defs>

          {/* Nodes */}
          {nodes.map((node) => {
            const color = COLORS[node.type];
            const hasWarning = warningSet.has(node.label);

            return (
              <g
                key={node.key}
                className="cursor-pointer"
                onClick={() => node.line && onClickLine?.(node.line)}
                onMouseEnter={(e) =>
                  setTooltip({
                    x: e.clientX,
                    y: e.clientY,
                    text: `${node.type}: ${node.label}${node.sublabel ? ` (${node.sublabel})` : ""}`,
                  })
                }
                onMouseLeave={() => setTooltip(null)}
              >
                <rect
                  x={node.pos.x}
                  y={node.pos.y}
                  width={NODE_W}
                  height={NODE_H}
                  rx={4}
                  fill={color.bg}
                  stroke={hasWarning ? "#ef4444" : color.border}
                  strokeWidth={hasWarning ? 2 : 1}
                />
                <text
                  x={node.pos.x + NODE_W / 2}
                  y={node.pos.y + (node.sublabel ? 12 : NODE_H / 2)}
                  textAnchor="middle"
                  dominantBaseline={node.sublabel ? "auto" : "central"}
                  fill={color.text}
                  className="text-[9px] font-medium"
                >
                  {node.label.length > 16
                    ? node.label.slice(0, 14) + "..."
                    : node.label}
                </text>
                {node.sublabel && (
                  <text
                    x={node.pos.x + NODE_W / 2}
                    y={node.pos.y + 23}
                    textAnchor="middle"
                    fill="#71717a"
                    className="text-[7px]"
                  >
                    {node.sublabel}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      {tooltip && (
        <div
          className="pointer-events-none fixed z-50 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[10px] text-zinc-300 shadow-xl"
          style={{ left: tooltip.x + 12, top: tooltip.y - 10 }}
        >
          {tooltip.text}
        </div>
      )}
    </div>
  );
}
