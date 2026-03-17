import { Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import type { DomainModel, StateNode, ValidationWarning } from "./types.js";

/**
 * Event Modeling blueprint:
 * - Horizontal swimlanes = states/aggregates
 * - Vertical slices = feature groupings (dashed columns)
 * - Actions (blue) top, Events (orange) middle, per swimlane
 * - Reactions (purple) as boxes: Event → Reaction → Action
 * - Projections (green) below
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
const STACK_OFFSET = 6;
const H_GAP = 24;
const MIN_SWIMLANE_H = 100;
const LABEL_W = 120;
const CMD_Y = 8;
const EVT_Y = 44;

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
type Swimlane = { label: string; y: number; h: number; line?: number };
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

    // Index states by varName
    const stateByVar = new Map<string, StateNode>();
    for (const s of model.states) stateByVar.set(s.varName, s);

    // Merge partial states by domain name for swimlanes
    const stateByName = new Map<
      string,
      { events: Set<string>; actions: Set<string> }
    >();
    for (const s of model.states) {
      const existing = stateByName.get(s.name) ?? {
        events: new Set(),
        actions: new Set(),
      };
      for (const e of s.events) existing.events.add(e.name);
      for (const a of s.actions) existing.actions.add(a.name);
      stateByName.set(s.name, existing);
    }
    const stateNames = [...stateByName.keys()];

    // Compute swimlane heights (based on max stacked events per state)
    const swimlaneHeights = new Map<string, number>();
    for (const s of model.states) {
      const maxStack = Math.max(1, ...s.actions.map((a) => a.emits.length));
      const h = Math.max(
        MIN_SWIMLANE_H,
        EVT_Y + maxStack * (NODE_H + STACK_OFFSET) + 12
      );
      swimlaneHeights.set(
        s.name,
        Math.max(swimlaneHeights.get(s.name) ?? 0, h)
      );
    }

    // Build swimlane Y positions
    let swimlaneY = 0;
    const swimlaneYMap = new Map<string, number>();
    for (const name of stateNames) {
      const h = swimlaneHeights.get(name) ?? MIN_SWIMLANE_H;
      swimlaneYMap.set(name, swimlaneY);
      swimlanes.push({
        label: name,
        y: swimlaneY,
        h,
        line: model.states.find((s) => s.name === name)?.line,
      });
      swimlaneY += h;
    }

    // Layout columns: process slices as vertical groups, then standalone states
    let cursorX = LABEL_W + H_GAP;

    // Helper: place one action + its events in a specific state's swimlane
    function placeAction(
      action: (typeof model.states)[0]["actions"][0],
      state: StateNode,
      x: number
    ) {
      const sy = swimlaneYMap.get(state.name) ?? 0;
      const aPos = { x, y: sy + CMD_Y };
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
          const ePos = { x, y: sy + EVT_Y + ei * (NODE_H + STACK_OFFSET) };
          nodes.push({
            key: `event:${eName}`,
            pos: ePos,
            type: "event",
            label: eName,
            line: state.events.find((e) => e.name === eName)?.line,
          });
          eventPositions.set(eName, ePos);
          edges.push({
            from: { x: aPos.x + NODE_W / 2, y: aPos.y + NODE_H },
            to: { x: ePos.x + NODE_W / 2, y: ePos.y },
            color: COLORS.action.border,
          });
        }
      }
    }

    // Collect all events per slice (for projection matching)
    const sliceEvents = new Map<string, Set<string>>();

    // 1. Slices as vertical columns
    for (const slice of model.slices) {
      const sliceStartX = cursorX;
      const partials = slice.stateVars
        .map((sv) => stateByVar.get(sv))
        .filter(Boolean) as StateNode[];

      // Collect events emitted by this slice's states
      const evts = new Set<string>();
      for (const st of partials) {
        for (const e of st.events) evts.add(e.name);
      }
      sliceEvents.set(slice.name, evts);

      // Place all actions from the slice's partial states
      for (const st of partials) {
        for (const action of st.actions) {
          placeAction(action, st, cursorX);
          cursorX += NODE_W + H_GAP;
        }
      }

      const sliceEndX = cursorX;
      const sliceLabel = slice.name.replace(/Slice$/i, "");
      sliceCols.push({
        label: sliceLabel,
        x: sliceStartX - 8,
        w: sliceEndX - sliceStartX + 8,
      });
      cursorX += H_GAP / 2; // gap between slices
    }

    // 2. Standalone states (not in any slice)
    const claimedVars = new Set(model.slices.flatMap((sl) => sl.stateVars));
    const standalone = model.states.filter((s) => !claimedVars.has(s.varName));
    for (const st of standalone) {
      for (const action of st.actions) {
        placeAction(action, st, cursorX);
        cursorX += NODE_W + H_GAP;
      }
      // Ungrouped events
      for (const event of st.events) {
        if (!eventPositions.has(event.name)) {
          const sy = swimlaneYMap.get(st.name) ?? 0;
          const ePos = { x: cursorX, y: sy + EVT_Y };
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

    // 3. Reactions — dedicated swimlane below aggregates
    const allReactions = [
      ...model.slices.flatMap((s) => s.reactions),
      ...model.reactions,
    ].filter((r) => !r.isVoid);

    if (allReactions.length > 0) {
      const reactRowY = swimlaneY;
      swimlanes.push({
        label: "Reactions",
        y: reactRowY,
        h: NODE_H + 24,
        line: undefined,
      });
      let reactX = LABEL_W + H_GAP;
      for (const reaction of allReactions) {
        const rPos = { x: reactX, y: reactRowY + 12 };
        nodes.push({
          key: `reaction:${reaction.handlerName}`,
          pos: rPos,
          type: "reaction",
          label: reaction.handlerName,
          line: reaction.line,
        });

        // Event → Reaction
        const triggerPos = eventPositions.get(reaction.event);
        if (triggerPos) {
          edges.push({
            from: { x: triggerPos.x + NODE_W / 2, y: triggerPos.y + NODE_H },
            to: { x: rPos.x + NODE_W / 2, y: rPos.y },
            color: COLORS.reaction.border,
            dashed: true,
          });
        }
        // Reaction → Actions (depart from right side, label with action name)
        for (const actionName of reaction.dispatches) {
          const aPos = actionPositions.get(actionName);
          if (aPos) {
            edges.push({
              from: { x: rPos.x + NODE_W, y: rPos.y + NODE_H / 2 },
              to: { x: aPos.x + NODE_W * 0.3, y: aPos.y },
              color: COLORS.reaction.border,
              dashed: true,
              label: actionName,
            });
          }
        }
        reactX += NODE_W + H_GAP;
      }
      swimlaneY = reactRowY + NODE_H + 24;
    }

    // 4. Projections — dedicated swimlane, duplicated per slice column
    const projRowY = swimlaneY;
    const hasProjections = model.projections.length > 0;
    if (hasProjections) {
      swimlanes.push({
        label: "Views",
        y: projRowY,
        h: NODE_H + 24,
        line: undefined,
      });
    }
    const projY = projRowY + 12;
    let projInstanceCount = 0;

    // Place projections in each slice column that has matching events
    for (const slice of model.slices) {
      const evts = sliceEvents.get(slice.name) ?? new Set();
      const sliceCol = sliceCols.find(
        (sc) => sc.label === slice.name.replace(/Slice$/i, "")
      );
      if (!sliceCol) continue;

      for (const proj of model.projections) {
        const matchingEvents = proj.handles.filter((h) => evts.has(h));
        if (matchingEvents.length === 0) continue;

        const pKey = `projection:${proj.name}:${slice.name}`;
        const centerX = sliceCol.x + sliceCol.w / 2 - NODE_W / 2;
        const pPosCentered = { x: Math.max(sliceCol.x + 8, centerX), y: projY };
        nodes.push({
          key: pKey,
          pos: pPosCentered,
          type: "projection",
          label: proj.name,
          line: proj.line,
        });

        for (const en of matchingEvents) {
          const ePos = eventPositions.get(en);
          if (ePos) {
            edges.push({
              from: { x: ePos.x + NODE_W / 2, y: ePos.y + NODE_H },
              to: { x: pPosCentered.x + NODE_W / 2, y: pPosCentered.y },
              color: COLORS.projection.border,
              dashed: true,
            });
          }
        }
      }
      projInstanceCount++;
    }

    // Standalone projections (events not in any slice)
    const allSliceEvents = new Set<string>();
    for (const evts of sliceEvents.values())
      for (const e of evts) allSliceEvents.add(e);
    for (const proj of model.projections) {
      const unmatched = proj.handles.filter((h) => !allSliceEvents.has(h));
      if (unmatched.length === 0) continue;
      const pKey = `projection:${proj.name}:standalone`;
      const pPos = {
        x: LABEL_W + H_GAP + projInstanceCount * (NODE_W + H_GAP),
        y: projY,
      };
      nodes.push({
        key: pKey,
        pos: pPos,
        type: "projection",
        label: proj.name,
        line: proj.line,
      });
      for (const en of unmatched) {
        const ePos = eventPositions.get(en);
        if (ePos) {
          edges.push({
            from: { x: ePos.x + NODE_W / 2, y: ePos.y + NODE_H },
            to: { x: pPos.x + NODE_W / 2, y: pPos.y },
            color: COLORS.projection.border,
            dashed: true,
          });
        }
      }
      projInstanceCount++;
    }

    let maxW = LABEL_W,
      maxH = 0;
    for (const n of nodes) {
      maxW = Math.max(maxW, n.pos.x + NODE_W);
      maxH = Math.max(maxH, n.pos.y + NODE_H);
    }
    return {
      nodes,
      edges,
      swimlanes,
      sliceCols,
      width: maxW + 40,
      height: maxH + 40,
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
  const svgH = Math.max(height, 300);
  const totalH = swimlanes.reduce((sum, sl) => Math.max(sum, sl.y + sl.h), 0);

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
          {/* State swimlanes (horizontal rows) */}
          {swimlanes.map((sl, i) => (
            <g key={sl.label + i}>
              {i % 2 === 0 && (
                <rect
                  x={0}
                  y={sl.y}
                  width={svgW}
                  height={sl.h}
                  fill="#18181b"
                  opacity={0.4}
                />
              )}
              <line
                x1={0}
                y1={sl.y + sl.h}
                x2={svgW}
                y2={sl.y + sl.h}
                stroke="#27272a"
                strokeWidth={1}
              />
              <text
                x={8}
                y={sl.y + sl.h / 2}
                dominantBaseline="middle"
                fill={COLORS.state.text}
                className="text-[11px] font-semibold"
              >
                {sl.label}
              </text>
            </g>
          ))}

          {/* Slice columns (vertical groupings) */}
          {sliceCols.map((sc) => (
            <g key={sc.label}>
              <rect
                x={sc.x}
                y={0}
                width={sc.w}
                height={totalH}
                rx={0}
                fill="none"
                stroke="#3f3f46"
                strokeWidth={1}
                strokeDasharray="6,4"
              />
              <text
                x={sc.x + sc.w / 2}
                y={totalH + 14}
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
            const goingUp = dy < -20; // reaction → action (from below to above)
            let d: string;
            if (isStraight) {
              d = `M ${edge.from.x} ${edge.from.y} L ${edge.to.x} ${edge.to.y}`;
            } else if (goingUp) {
              // S-curve: right from reaction, then sweep up into action top
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
