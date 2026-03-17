import { Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import type { DomainModel, StateNode, ValidationWarning } from "./types.js";

/**
 * Event Modeling Standard Layout (top to bottom):
 * 1. Commands (blue) — above events
 * 2. Events (orange) — central timeline, swimlanes per aggregate
 * 3. Views/Projections (green) — below events
 * Reactions connect events → commands (arrows from event up to command)
 * Vertical slices group related commands/events/views
 */

const COLORS = {
  action: { bg: "#1e3a5f", border: "#2563eb", text: "#60a5fa" },
  event: { bg: "#4a2c17", border: "#ea580c", text: "#fb923c" },
  state: { bg: "#27272a", border: "#52525b", text: "#a1a1aa" },
  reaction: { bg: "#2e1a47", border: "#7c3aed", text: "#a78bfa" },
  projection: { bg: "#0d3320", border: "#16a34a", text: "#4ade80" },
};

const NODE_W = 130;
const NODE_H = 28;
const H_GAP = 24;
const LABEL_W = 110;

// Vertical layout positions (top to bottom)
const CMD_ROW_Y = 10; // Commands row
const EVENT_ROW_Y = 60; // Events row (the timeline)
const VIEW_ROW_Y = 110; // Views/Projections row

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

  const { nodes, edges, sliceCols, rowLabels, width, height } = useMemo(() => {
    const nodes: NodeData[] = [];
    const edges: Edge[] = [];
    const sliceCols: SliceCol[] = [];
    const actionPositions = new Map<string, Pos>();
    const eventPositions = new Map<string, Pos>();

    const stateByVar = new Map<string, StateNode>();
    for (const s of model.states) stateByVar.set(s.varName, s);

    // Collect events per slice
    const sliceEvents = new Map<string, Set<string>>();

    let cursorX = LABEL_W + H_GAP;

    // --- Layout slices as vertical columns ---
    for (const slice of model.slices) {
      const sliceStartX = cursorX;
      const partials = slice.stateVars
        .map((sv) => stateByVar.get(sv))
        .filter(Boolean) as StateNode[];

      const evts = new Set<string>();
      for (const st of partials) for (const e of st.events) evts.add(e.name);
      sliceEvents.set(slice.name, evts);

      for (const st of partials) {
        for (const action of st.actions) {
          // Command (above)
          const aPos = { x: cursorX, y: CMD_ROW_Y };
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

          // Events (on the timeline row) — stacked if multiple
          for (let ei = 0; ei < action.emits.length; ei++) {
            const eName = action.emits[ei];
            if (!eventPositions.has(eName)) {
              const ePos = { x: cursorX, y: EVENT_ROW_Y + ei * (NODE_H + 4) };
              nodes.push({
                key: `event:${eName}`,
                pos: ePos,
                type: "event",
                label: eName,
                line: st.events.find((e) => e.name === eName)?.line,
              });
              eventPositions.set(eName, ePos);

              // Command → Event (vertical down)
              edges.push({
                from: { x: aPos.x + NODE_W / 2, y: aPos.y + NODE_H },
                to: { x: ePos.x + NODE_W / 2, y: ePos.y },
                color: COLORS.action.border,
              });
            }
          }

          cursorX += NODE_W + H_GAP;
        }

        // Ungrouped events
        for (const event of st.events) {
          if (!eventPositions.has(event.name)) {
            const ePos = { x: cursorX, y: EVENT_ROW_Y };
            nodes.push({
              key: `event:${event.name}`,
              pos: ePos,
              type: "event",
              label: event.name,
              line: event.line,
            });
            eventPositions.set(event.name, ePos);
            cursorX += NODE_W + H_GAP;
          }
        }
      }

      // Reactions in this slice — placed above the command they dispatch to
      for (const reaction of slice.reactions) {
        if (reaction.isVoid) continue;
        if (reaction.dispatches.length > 0) {
          // Reaction is shown as a label on the Event→Command connection
          for (const actionName of reaction.dispatches) {
            const ePos = eventPositions.get(reaction.event);
            const aPos = actionPositions.get(actionName);
            if (ePos && aPos) {
              // Event → Command (reaction arrow, going from event up to command)
              edges.push({
                from: { x: ePos.x + NODE_W, y: ePos.y + NODE_H / 2 },
                to: { x: aPos.x + NODE_W * 0.3, y: aPos.y },
                color: COLORS.reaction.border,
                dashed: true,
                label: `${reaction.handlerName} → ${actionName}`,
              });
            }
          }
        } else {
          // Reaction with no dispatch — show as node on the event row
          const ePos = eventPositions.get(reaction.event);
          if (ePos) {
            const rPos = { x: cursorX, y: EVENT_ROW_Y };
            nodes.push({
              key: `reaction:${reaction.handlerName}`,
              pos: rPos,
              type: "reaction",
              label: reaction.handlerName,
              line: reaction.line,
            });
            edges.push({
              from: { x: ePos.x + NODE_W, y: ePos.y + NODE_H / 2 },
              to: { x: rPos.x, y: rPos.y + NODE_H / 2 },
              color: COLORS.reaction.border,
              dashed: true,
            });
            cursorX += NODE_W + H_GAP;
          }
        }
      }

      const sliceEndX = cursorX;
      sliceCols.push({
        label: slice.name.replace(/Slice$/i, ""),
        x: sliceStartX - 8,
        w: sliceEndX - sliceStartX + 8,
      });
      cursorX += H_GAP / 2;
    }

    // --- Standalone states (not in slices) ---
    const claimedVars = new Set(model.slices.flatMap((sl) => sl.stateVars));
    for (const st of model.states.filter((s) => !claimedVars.has(s.varName))) {
      for (const action of st.actions) {
        const aPos = { x: cursorX, y: CMD_ROW_Y };
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
            const ePos = { x: cursorX, y: EVENT_ROW_Y + ei * (NODE_H + 4) };
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

    // --- Inline act() reactions ---
    for (const reaction of model.reactions) {
      if (reaction.isVoid) continue;
      for (const actionName of reaction.dispatches) {
        const ePos = eventPositions.get(reaction.event);
        const aPos = actionPositions.get(actionName);
        if (ePos && aPos) {
          edges.push({
            from: { x: ePos.x + NODE_W, y: ePos.y + NODE_H / 2 },
            to: { x: aPos.x + NODE_W * 0.3, y: aPos.y },
            color: COLORS.reaction.border,
            dashed: true,
            label: `${reaction.handlerName} → ${actionName}`,
          });
        }
      }
    }

    // --- Projections (Views row, below events) ---
    // Owned by slices
    const placedProjs = new Set<string>();
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
          y: VIEW_ROW_Y,
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

    // Unclaimed projections — duplicate per slice with matching events
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
          x: Math.max(sliceCol.x + 8, sliceCol.x + sliceCol.w / 2 - NODE_W / 2),
          y: VIEW_ROW_Y,
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

    // Row labels
    const rowLabels = [
      { label: "Commands", y: CMD_ROW_Y + NODE_H / 2 },
      { label: "Events", y: EVENT_ROW_Y + NODE_H / 2 },
      { label: "Views", y: VIEW_ROW_Y + NODE_H / 2 },
    ];

    let maxW = LABEL_W,
      maxH = VIEW_ROW_Y + NODE_H + 20;
    for (const n of nodes) {
      maxW = Math.max(maxW, n.pos.x + NODE_W);
      maxH = Math.max(maxH, n.pos.y + NODE_H + 20);
    }
    return {
      nodes,
      edges,
      sliceCols,
      rowLabels,
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
          {/* Row labels */}
          {rowLabels.map((rl) => (
            <text
              key={rl.label}
              x={8}
              y={rl.y}
              dominantBaseline="middle"
              fill="#52525b"
              className="text-[9px] font-medium"
            >
              {rl.label}
            </text>
          ))}

          {/* Row separators */}
          <line
            x1={LABEL_W}
            y1={EVENT_ROW_Y - 8}
            x2={svgW}
            y2={EVENT_ROW_Y - 8}
            stroke="#1f1f23"
            strokeWidth={1}
          />
          <line
            x1={LABEL_W}
            y1={VIEW_ROW_Y - 8}
            x2={svgW}
            y2={VIEW_ROW_Y - 8}
            stroke="#1f1f23"
            strokeWidth={1}
          />

          {/* Slice columns */}
          {sliceCols.map((sc) => (
            <g key={sc.label}>
              <rect
                x={sc.x}
                y={0}
                width={sc.w}
                height={svgH}
                rx={0}
                fill="none"
                stroke="#3f3f46"
                strokeWidth={1}
                strokeDasharray="6,4"
              />
              <text
                x={sc.x + sc.w / 2}
                y={svgH - 4}
                textAnchor="middle"
                fill="#52525b"
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
            const isStraight = Math.abs(dx) < 5;
            const goingUp = dy < -20;
            let d: string;
            if (isStraight) {
              d = `M ${edge.from.x} ${edge.from.y} L ${edge.to.x} ${edge.to.y}`;
            } else if (goingUp) {
              // S-curve for reaction arrows (event → command)
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
                  opacity={0.6}
                  markerEnd="url(#arrow)"
                />
                {edge.label && (
                  <text
                    x={edge.from.x + 4}
                    y={edge.from.y - 6}
                    textAnchor="start"
                    fill="#71717a"
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
                  y={node.pos.y + (node.sublabel ? 11 : NODE_H / 2)}
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
                    y={node.pos.y + 22}
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
