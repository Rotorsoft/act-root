import { Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import type { DomainModel, StateNode, ValidationWarning } from "./types.js";

/**
 * Event Storming Diagram — left-to-right flow per slice:
 *   [Command (blue)] → [Aggregate (yellow)] → [Event (orange)] → [Policy (lilac)] → ...
 *
 * Projections (green) at the end or below
 * Vertical slices as dashed columns
 */

const COLORS = {
  action: { bg: "#1e40af", border: "#3b82f6", text: "#93c5fd" }, // Blue
  event: { bg: "#c2410c", border: "#f97316", text: "#fed7aa" }, // Orange
  state: { bg: "#a16207", border: "#eab308", text: "#fef08a" }, // Yellow
  reaction: { bg: "#7e22ce", border: "#a855f7", text: "#d8b4fe" }, // Purple/Lilac
  projection: { bg: "#15803d", border: "#22c55e", text: "#bbf7d0" }, // Green
};

const NODE_W = 120;
const NODE_H = 32;
const H_GAP = 12;
const V_GAP = 14;
const LANE_PAD = 10;

type Pos = { x: number; y: number };
type NodeData = {
  key: string;
  pos: Pos;
  type: keyof typeof COLORS;
  label: string;
  sublabel?: string;
  line?: number;
};
type Edge = {
  from: Pos;
  to: Pos;
  color: string;
  dashed?: boolean;
  label?: string;
};
type SliceCol = { label: string; x: number; w: number };

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

  const { nodes, edges, sliceCols, width, height } = useMemo(() => {
    const nodes: NodeData[] = [];
    const edges: Edge[] = [];
    const sliceCols: SliceCol[] = [];
    const actionPositions = new Map<string, Pos>();
    const eventPositions = new Map<string, Pos>();

    const stateByVar = new Map<string, StateNode>();
    for (const s of model.states) stateByVar.set(s.varName, s);

    const sliceEvents = new Map<string, Set<string>>();
    let cursorX = LANE_PAD;
    let maxY = 0;

    // --- Each slice is a left-to-right sequence ---
    for (const slice of model.slices) {
      const sliceStartX = cursorX;
      const partials = slice.stateVars
        .map((sv) => stateByVar.get(sv))
        .filter(Boolean) as StateNode[];

      const evts = new Set<string>();
      for (const st of partials) for (const e of st.events) evts.add(e.name);
      sliceEvents.set(slice.name, evts);

      // For each action in the slice: Command → State → Event(s) → Policy
      let rowY = LANE_PAD;
      for (const st of partials) {
        for (const action of st.actions) {
          let x = cursorX;

          // 1. Command (blue)
          const aPos = { x, y: rowY };
          nodes.push({
            key: `action:${action.name}`,
            pos: aPos,
            type: "action",
            label: action.name,
            sublabel:
              action.invariants.length > 0
                ? `${action.invariants.length} guard(s)`
                : undefined,
            line: action.line,
          });
          actionPositions.set(action.name, aPos);
          x += NODE_W + H_GAP;

          // 2. Aggregate (yellow) — the state this action belongs to
          const sPos = { x, y: rowY };
          nodes.push({
            key: `state:${st.name}:${action.name}`,
            pos: sPos,
            type: "state",
            label: st.name,
            line: st.line,
          });
          // Command → State arrow
          edges.push({
            from: { x: aPos.x + NODE_W, y: aPos.y + NODE_H / 2 },
            to: { x: sPos.x, y: sPos.y + NODE_H / 2 },
            color: COLORS.action.border,
          });
          x += NODE_W + H_GAP;

          // 3. Event(s) (orange) — stacked vertically if multiple
          for (let ei = 0; ei < action.emits.length; ei++) {
            const eName = action.emits[ei];
            if (!eventPositions.has(eName)) {
              const ePos = { x, y: rowY + ei * (NODE_H + 4) };
              nodes.push({
                key: `event:${eName}`,
                pos: ePos,
                type: "event",
                label: eName,
                line: st.events.find((e) => e.name === eName)?.line,
              });
              eventPositions.set(eName, ePos);
              // State → Event arrow
              edges.push({
                from: { x: sPos.x + NODE_W, y: sPos.y + NODE_H / 2 },
                to: { x: ePos.x, y: ePos.y + NODE_H / 2 },
                color: COLORS.event.border,
              });
            }
          }

          const evtHeight = Math.max(1, action.emits.length) * (NODE_H + 4);
          maxY = Math.max(maxY, rowY + evtHeight);
          rowY += evtHeight + V_GAP;
        }
      }

      // Update cursorX to after the widest element placed
      let sliceMaxX = cursorX;
      for (const n of nodes) {
        if (n.pos.x + NODE_W > sliceMaxX) sliceMaxX = n.pos.x + NODE_W;
      }
      cursorX = sliceMaxX + H_GAP;

      // 4. Reactions (purple) — after events in the flow
      for (const reaction of slice.reactions) {
        if (reaction.isVoid) continue;
        const ePos = eventPositions.get(reaction.event);
        const rY = ePos ? ePos.y : LANE_PAD;
        const rPos = { x: cursorX, y: rY };
        nodes.push({
          key: `reaction:${reaction.handlerName}`,
          pos: rPos,
          type: "reaction",
          label: reaction.handlerName,
          line: reaction.line,
        });

        // Event → Policy arrow
        if (ePos) {
          edges.push({
            from: { x: ePos.x + NODE_W, y: ePos.y + NODE_H / 2 },
            to: { x: rPos.x, y: rPos.y + NODE_H / 2 },
            color: COLORS.reaction.border,
            dashed: true,
          });
        }
        // Policy → Command arrows (dispatches)
        for (const actionName of reaction.dispatches) {
          const aPos = actionPositions.get(actionName);
          if (aPos) {
            edges.push({
              from: { x: rPos.x + NODE_W, y: rPos.y + NODE_H / 2 },
              to: { x: aPos.x, y: aPos.y + NODE_H / 2 },
              color: COLORS.reaction.border,
              dashed: true,
              label: actionName,
            });
          }
        }
        cursorX += NODE_W + H_GAP;
        maxY = Math.max(maxY, rY + NODE_H);
      }

      const sliceEndX = cursorX;
      sliceCols.push({
        label: slice.name.replace(/Slice$/i, ""),
        x: sliceStartX - 4,
        w: sliceEndX - sliceStartX + 4,
      });
      cursorX += H_GAP;
    }

    // --- Standalone states (not in slices) ---
    const claimedVars = new Set(model.slices.flatMap((sl) => sl.stateVars));
    let rowY = LANE_PAD;
    for (const st of model.states.filter((s) => !claimedVars.has(s.varName))) {
      for (const action of st.actions) {
        let x = cursorX;
        const aPos = { x, y: rowY };
        nodes.push({
          key: `action:${action.name}`,
          pos: aPos,
          type: "action",
          label: action.name,
          sublabel:
            action.invariants.length > 0
              ? `${action.invariants.length} guard(s)`
              : undefined,
          line: action.line,
        });
        actionPositions.set(action.name, aPos);
        x += NODE_W + H_GAP;

        const sPos = { x, y: rowY };
        nodes.push({
          key: `state:${st.name}:${action.name}`,
          pos: sPos,
          type: "state",
          label: st.name,
          line: st.line,
        });
        edges.push({
          from: { x: aPos.x + NODE_W, y: aPos.y + NODE_H / 2 },
          to: { x: sPos.x, y: sPos.y + NODE_H / 2 },
          color: COLORS.action.border,
        });
        x += NODE_W + H_GAP;

        for (let ei = 0; ei < action.emits.length; ei++) {
          const eName = action.emits[ei];
          if (!eventPositions.has(eName)) {
            const ePos = { x, y: rowY + ei * (NODE_H + 4) };
            nodes.push({
              key: `event:${eName}`,
              pos: ePos,
              type: "event",
              label: eName,
              line: st.events.find((e) => e.name === eName)?.line,
            });
            eventPositions.set(eName, ePos);
            edges.push({
              from: { x: sPos.x + NODE_W, y: sPos.y + NODE_H / 2 },
              to: { x: ePos.x, y: ePos.y + NODE_H / 2 },
              color: COLORS.event.border,
            });
          }
        }
        rowY += Math.max(1, action.emits.length) * (NODE_H + 4) + V_GAP;
        maxY = Math.max(maxY, rowY);
      }
    }

    // --- Projections (green) ---
    const projY = maxY + V_GAP * 2;
    const placedProjs = new Set<string>();
    for (const slice of model.slices) {
      const sliceProjVars = new Set(slice.projections);
      if (sliceProjVars.size === 0) continue;
      const sEvts = sliceEvents.get(slice.name) ?? new Set();
      const sliceCol = sliceCols.find(
        (sc) => sc.label === slice.name.replace(/Slice$/i, "")
      );
      for (const proj of model.projections) {
        if (!sliceProjVars.has(proj.varName) && !sliceProjVars.has(proj.name))
          continue;
        const matching = proj.handles.filter((h) => sEvts.has(h));
        if (matching.length === 0) continue;
        const pPos = {
          x: sliceCol ? sliceCol.x + sliceCol.w / 2 - NODE_W / 2 : cursorX,
          y: projY,
        };
        nodes.push({
          key: `projection:${proj.name}:${slice.name}`,
          pos: pPos,
          type: "projection",
          label: proj.name,
          line: proj.line,
        });
        for (const en of matching) {
          const ePos = eventPositions.get(en);
          if (ePos)
            edges.push({
              from: { x: ePos.x + NODE_W / 2, y: ePos.y + NODE_H },
              to: { x: pPos.x + NODE_W / 2, y: pPos.y },
              color: COLORS.projection.border,
              dashed: true,
            });
        }
        placedProjs.add(proj.varName);
      }
    }
    // Unclaimed projections
    for (const proj of model.projections) {
      if (placedProjs.has(proj.varName)) continue;
      for (const slice of model.slices) {
        const sEvts = sliceEvents.get(slice.name) ?? new Set();
        const matching = proj.handles.filter((h) => sEvts.has(h));
        if (matching.length === 0) continue;
        const sliceCol = sliceCols.find(
          (sc) => sc.label === slice.name.replace(/Slice$/i, "")
        );
        if (!sliceCol) continue;
        const pPos = {
          x: Math.max(sliceCol.x + 4, sliceCol.x + sliceCol.w / 2 - NODE_W / 2),
          y: projY,
        };
        nodes.push({
          key: `projection:${proj.name}:${slice.name}`,
          pos: pPos,
          type: "projection",
          label: proj.name,
          line: proj.line,
        });
        for (const en of matching) {
          const ePos = eventPositions.get(en);
          if (ePos)
            edges.push({
              from: { x: ePos.x + NODE_W / 2, y: ePos.y + NODE_H },
              to: { x: pPos.x + NODE_W / 2, y: pPos.y },
              color: COLORS.projection.border,
              dashed: true,
            });
        }
      }
    }

    let maxW = 0,
      maxH = 0;
    for (const n of nodes) {
      maxW = Math.max(maxW, n.pos.x + NODE_W);
      maxH = Math.max(maxH, n.pos.y + NODE_H);
    }
    return { nodes, edges, sliceCols, width: maxW + 40, height: maxH + 30 };
  }, [model]);

  if (model.states.length === 0 && model.projections.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-zinc-600">
        Import from GitHub or generate with AI
      </div>
    );
  }

  const svgW = Math.max(width, 400);
  const svgH = Math.max(height, 150);

  return (
    <div className="relative flex h-full flex-col bg-zinc-950">
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
          {Math.round(zoom * 100)}%
        </span>
        <div className="ml-3 flex items-center gap-2.5 text-[8px] text-zinc-500">
          {(
            ["action", "state", "event", "reaction", "projection"] as const
          ).map((t) => (
            <span key={t} className="flex items-center gap-1">
              <span
                className="inline-block h-2.5 w-2.5 rounded"
                style={{
                  background: COLORS[t].bg,
                  border: `1px solid ${COLORS[t].border}`,
                }}
              />
              {
                {
                  action: "Command",
                  state: "Aggregate",
                  event: "Event",
                  reaction: "Policy",
                  projection: "Read Model",
                }[t]
              }
            </span>
          ))}
        </div>
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
          {/* Slice columns */}
          {sliceCols.map((sc) => (
            <g key={sc.label}>
              <rect
                x={sc.x}
                y={0}
                width={sc.w}
                height={svgH}
                fill="#18181b"
                opacity={0.3}
                rx={6}
                stroke="#3f3f46"
                strokeWidth={1}
                strokeDasharray="6,4"
              />
              <text
                x={sc.x + sc.w / 2}
                y={svgH - 6}
                textAnchor="middle"
                fill="#71717a"
                className="text-[9px] font-medium"
              >
                {sc.label}
              </text>
            </g>
          ))}

          {/* Edges */}
          {edges.map((edge, i) => {
            const dx = edge.to.x - edge.from.x;
            const dy = edge.to.y - edge.from.y;
            const isStraight = Math.abs(dy) < 5;
            const goingBack = dx < -20;
            let d: string;
            if (isStraight) {
              d = `M ${edge.from.x} ${edge.from.y} L ${edge.to.x} ${edge.to.y}`;
            } else if (goingBack) {
              // S-curve for reaction→command (going backwards)
              const midY = Math.min(edge.from.y, edge.to.y) - 30;
              d = `M ${edge.from.x} ${edge.from.y} C ${edge.from.x + 30} ${midY}, ${edge.to.x - 30} ${midY}, ${edge.to.x} ${edge.to.y}`;
            } else {
              d = `M ${edge.from.x} ${edge.from.y} C ${edge.from.x + dx * 0.3} ${edge.from.y}, ${edge.to.x - dx * 0.3} ${edge.to.y}, ${edge.to.x} ${edge.to.y}`;
            }
            return (
              <g key={i}>
                <path
                  d={d}
                  fill="none"
                  stroke={edge.color}
                  strokeWidth={1.5}
                  strokeDasharray={edge.dashed ? "4,3" : undefined}
                  opacity={0.7}
                  markerEnd="url(#arrow)"
                />
                {edge.label && (
                  <text
                    x={(edge.from.x + edge.to.x) / 2}
                    y={Math.min(edge.from.y, edge.to.y) - 8}
                    textAnchor="middle"
                    fill="#a1a1aa"
                    className="text-[7px]"
                  >
                    {edge.label}
                  </text>
                )}
              </g>
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
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#71717a" />
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
                  strokeWidth={hasWarning ? 2 : 1.5}
                />
                <text
                  x={node.pos.x + NODE_W / 2}
                  y={node.pos.y + (node.sublabel ? 12 : NODE_H / 2)}
                  textAnchor="middle"
                  dominantBaseline={node.sublabel ? "auto" : "central"}
                  fill={color.text}
                  className="text-[9px] font-medium"
                >
                  {node.label.length > 14
                    ? node.label.slice(0, 12) + "..."
                    : node.label}
                </text>
                {node.sublabel && (
                  <text
                    x={node.pos.x + NODE_W / 2}
                    y={node.pos.y + 24}
                    textAnchor="middle"
                    fill="#a1a1aa"
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
