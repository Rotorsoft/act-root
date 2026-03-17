import { Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import type { DomainModel, StateNode, ValidationWarning } from "./types.js";

/**
 * Event Storming Diagram
 *
 * Left-to-right flow per vertical slice:
 *   [Command (blue)] → [Event (orange)] → [Policy/Reaction (lilac)] → [Command] → ...
 *
 * Aggregates (yellow) as horizontal swimlanes behind events
 * Projections (green) below the events they read
 * Invariants (red) as small markers on commands
 *
 * Vertical slices group related command→event→policy chains
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
const H_GAP = 16;
const V_GAP = 12;
const SWIMLANE_PAD = 8;
const LABEL_W = 100;

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
type Swimlane = { label: string; y: number; h: number };
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

  const { nodes, edges, swimlanes, sliceCols, width, height } = useMemo(() => {
    const nodes: NodeData[] = [];
    const edges: Edge[] = [];
    const swimlanes: Swimlane[] = [];
    const sliceCols: SliceCol[] = [];
    const actionPositions = new Map<string, Pos>();
    const eventPositions = new Map<string, Pos>();

    const stateByVar = new Map<string, StateNode>();
    for (const s of model.states) stateByVar.set(s.varName, s);

    // Merge states by name for swimlanes
    const stateNames: string[] = [];
    const seen = new Set<string>();
    for (const s of model.states) {
      if (!seen.has(s.name)) {
        stateNames.push(s.name);
        seen.add(s.name);
      }
    }

    // Build swimlane Y positions
    let swimlaneY = SWIMLANE_PAD;
    const swimlaneYMap = new Map<string, number>();
    const SWIMLANE_H = NODE_H * 2 + V_GAP * 3; // room for command + event stacked
    for (const name of stateNames) {
      swimlaneYMap.set(name, swimlaneY);
      swimlanes.push({ label: name, y: swimlaneY, h: SWIMLANE_H });
      swimlaneY += SWIMLANE_H + SWIMLANE_PAD;
    }

    const sliceEvents = new Map<string, Set<string>>();
    let cursorX = LABEL_W + H_GAP;

    // --- Lay out slices as left-to-right sequences ---
    for (const slice of model.slices) {
      const sliceStartX = cursorX;
      const partials = slice.stateVars
        .map((sv) => stateByVar.get(sv))
        .filter(Boolean) as StateNode[];

      const evts = new Set<string>();
      for (const st of partials) for (const e of st.events) evts.add(e.name);
      sliceEvents.set(slice.name, evts);

      // For each action: place Command → Event(s) pair
      for (const st of partials) {
        const sy = swimlaneYMap.get(st.name) ?? 0;
        for (const action of st.actions) {
          // Command (blue) — left
          const aPos = { x: cursorX, y: sy + V_GAP };
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

          // Event(s) (orange) — right of command, same row or stacked
          for (let ei = 0; ei < action.emits.length; ei++) {
            const eName = action.emits[ei];
            if (!eventPositions.has(eName)) {
              const ePos = {
                x: cursorX,
                y: sy + V_GAP + NODE_H + V_GAP + ei * (NODE_H + 4),
              };
              nodes.push({
                key: `event:${eName}`,
                pos: ePos,
                type: "event",
                label: eName,
                line: st.events.find((e) => e.name === eName)?.line,
              });
              eventPositions.set(eName, ePos);
              // Command → Event arrow
              edges.push({
                from: { x: aPos.x + NODE_W / 2, y: aPos.y + NODE_H },
                to: { x: ePos.x + NODE_W / 2, y: ePos.y },
                color: COLORS.action.border,
              });
            }
          }
          cursorX += NODE_W + H_GAP;
        }
      }

      // Reactions — as purple boxes: Event → [Policy] → Command
      for (const reaction of slice.reactions) {
        if (reaction.isVoid) continue;
        // Find which swimlane the triggering event is in
        const trigState = model.states.find((s) =>
          s.events.some((e) => e.name === reaction.event)
        );
        const sy = swimlaneYMap.get(trigState?.name ?? stateNames[0]) ?? 0;

        const rPos = { x: cursorX, y: sy + V_GAP + NODE_H + V_GAP };
        nodes.push({
          key: `reaction:${reaction.handlerName}`,
          pos: rPos,
          type: "reaction",
          label: reaction.handlerName,
          line: reaction.line,
        });

        // Event → Policy arrow
        const ePos = eventPositions.get(reaction.event);
        if (ePos) {
          edges.push({
            from: { x: ePos.x + NODE_W, y: ePos.y + NODE_H / 2 },
            to: { x: rPos.x, y: rPos.y + NODE_H / 2 },
            color: COLORS.reaction.border,
            dashed: true,
          });
        }

        // Policy → Command arrows
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
      }

      const sliceEndX = cursorX;
      sliceCols.push({
        label: slice.name.replace(/Slice$/i, ""),
        x: sliceStartX - 6,
        w: sliceEndX - sliceStartX + 6,
      });
      cursorX += H_GAP;
    }

    // --- Standalone states ---
    const claimedVars = new Set(model.slices.flatMap((sl) => sl.stateVars));
    for (const st of model.states.filter((s) => !claimedVars.has(s.varName))) {
      const sy = swimlaneYMap.get(st.name) ?? 0;
      for (const action of st.actions) {
        const aPos = { x: cursorX, y: sy + V_GAP };
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

        for (let ei = 0; ei < action.emits.length; ei++) {
          const eName = action.emits[ei];
          if (!eventPositions.has(eName)) {
            const ePos = {
              x: cursorX,
              y: sy + V_GAP + NODE_H + V_GAP + ei * (NODE_H + 4),
            };
            nodes.push({
              key: `event:${eName}`,
              pos: ePos,
              type: "event",
              label: eName,
              line: st.events.find((e) => e.name === eName)?.line,
            });
            eventPositions.set(eName, ePos);
            edges.push({
              from: { x: aPos.x + NODE_W / 2, y: aPos.y + NODE_H },
              to: { x: ePos.x + NODE_W / 2, y: ePos.y },
              color: COLORS.action.border,
            });
          }
        }
        cursorX += NODE_W + H_GAP;
      }
    }

    // --- Projections (green, below swimlanes) ---
    const projY = swimlaneY + V_GAP;
    const placedProjs = new Set<string>();
    // Owned by slices
    for (const slice of model.slices) {
      const sliceProjVars = new Set(slice.projections);
      if (sliceProjVars.size === 0) continue;
      const evts = sliceEvents.get(slice.name) ?? new Set();
      const sliceCol = sliceCols.find(
        (sc) => sc.label === slice.name.replace(/Slice$/i, "")
      );
      for (const proj of model.projections) {
        if (!sliceProjVars.has(proj.varName) && !sliceProjVars.has(proj.name))
          continue;
        const matching = proj.handles.filter((h) => evts.has(h));
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
    // Unclaimed — per slice with matching events
    for (const proj of model.projections) {
      if (placedProjs.has(proj.varName)) continue;
      for (const slice of model.slices) {
        const evts = sliceEvents.get(slice.name) ?? new Set();
        const matching = proj.handles.filter((h) => evts.has(h));
        if (matching.length === 0) continue;
        const sliceCol = sliceCols.find(
          (sc) => sc.label === slice.name.replace(/Slice$/i, "")
        );
        if (!sliceCol) continue;
        const pPos = {
          x: Math.max(sliceCol.x + 6, sliceCol.x + sliceCol.w / 2 - NODE_W / 2),
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

    let maxW = LABEL_W,
      maxH = projY + NODE_H + 20;
    for (const n of nodes) {
      maxW = Math.max(maxW, n.pos.x + NODE_W);
      maxH = Math.max(maxH, n.pos.y + NODE_H + 20);
    }
    return {
      nodes,
      edges,
      swimlanes,
      sliceCols,
      width: maxW + 40,
      height: maxH,
    };
  }, [model]);

  if (model.states.length === 0 && model.projections.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-zinc-600">
        Write or generate Act code to see the diagram
      </div>
    );
  }

  const svgW = Math.max(width, 600);
  const svgH = Math.max(height, 200);

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
        {/* Legend */}
        <div className="ml-4 flex items-center gap-3 text-[8px]">
          <span className="flex items-center gap-1">
            <span
              className="inline-block h-2.5 w-2.5 rounded"
              style={{
                background: COLORS.action.bg,
                border: `1px solid ${COLORS.action.border}`,
              }}
            />
            Command
          </span>
          <span className="flex items-center gap-1">
            <span
              className="inline-block h-2.5 w-2.5 rounded"
              style={{
                background: COLORS.event.bg,
                border: `1px solid ${COLORS.event.border}`,
              }}
            />
            Event
          </span>
          <span className="flex items-center gap-1">
            <span
              className="inline-block h-2.5 w-2.5 rounded"
              style={{
                background: COLORS.state.bg,
                border: `1px solid ${COLORS.state.border}`,
              }}
            />
            Aggregate
          </span>
          <span className="flex items-center gap-1">
            <span
              className="inline-block h-2.5 w-2.5 rounded"
              style={{
                background: COLORS.reaction.bg,
                border: `1px solid ${COLORS.reaction.border}`,
              }}
            />
            Policy
          </span>
          <span className="flex items-center gap-1">
            <span
              className="inline-block h-2.5 w-2.5 rounded"
              style={{
                background: COLORS.projection.bg,
                border: `1px solid ${COLORS.projection.border}`,
              }}
            />
            Read Model
          </span>
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
          {/* Aggregate swimlanes (yellow background) */}
          {swimlanes.map((sl, i) => (
            <g key={sl.label + i}>
              <rect
                x={LABEL_W - 4}
                y={sl.y}
                width={svgW - LABEL_W + 4}
                height={sl.h}
                rx={6}
                fill={COLORS.state.bg}
                opacity={0.15}
                stroke={COLORS.state.border}
                strokeWidth={1}
                strokeOpacity={0.3}
              />
              <text
                x={8}
                y={sl.y + sl.h / 2}
                dominantBaseline="middle"
                fill={COLORS.state.text}
                className="text-[10px] font-semibold"
              >
                {sl.label}
              </text>
            </g>
          ))}

          {/* Slice columns */}
          {sliceCols.map((sc) => (
            <g key={sc.label}>
              <rect
                x={sc.x}
                y={0}
                width={sc.w}
                height={svgH - 4}
                rx={0}
                fill="none"
                stroke="#3f3f46"
                strokeWidth={1}
                strokeDasharray="6,4"
              />
              <text
                x={sc.x + sc.w / 2}
                y={svgH - 6}
                textAnchor="middle"
                fill="#52525b"
                className="text-[8px] font-medium"
              >
                {sc.label}
              </text>
            </g>
          ))}

          {/* Edges */}
          {edges.map((edge, i) => {
            const dx = edge.to.x - edge.from.x;
            const dy = edge.to.y - edge.from.y;
            const isStraight = Math.abs(dx) < 5;
            const goingUp = dy < -20;
            let d: string;
            if (isStraight) {
              d = `M ${edge.from.x} ${edge.from.y} L ${edge.to.x} ${edge.to.y}`;
            } else if (goingUp) {
              d = `M ${edge.from.x} ${edge.from.y} C ${edge.from.x + Math.abs(dx) * 0.6} ${edge.from.y}, ${edge.to.x - Math.abs(dx) * 0.1} ${edge.to.y - Math.abs(dy) * 0.8}, ${edge.to.x} ${edge.to.y}`;
            } else {
              d = `M ${edge.from.x} ${edge.from.y} C ${edge.from.x + dx * 0.4} ${edge.from.y}, ${edge.to.x - dx * 0.4} ${edge.to.y}, ${edge.to.x} ${edge.to.y}`;
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
                    x={edge.from.x + 4}
                    y={edge.from.y - 5}
                    textAnchor="start"
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
