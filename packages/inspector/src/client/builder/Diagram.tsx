import { Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import type { DomainModel, ValidationWarning } from "./types.js";

/**
 * Event Modeling blueprint:
 * - Horizontal timeline (left to right)
 * - Swimlanes per aggregate/state
 * - Per vertical slice: Action (blue, top) → Event(s) (orange, middle)
 * - Reactions shown as arrows from Event → Action in another swimlane
 * - Projections (green) below, consuming events
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
const STACK_OFFSET = 6; // vertical offset for stacked events
const H_GAP = 24;
const MIN_SWIMLANE_H = 100;
const LABEL_W = 110;
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

  const { nodes, edges, swimlanes, boxes, width, height } = useMemo(() => {
    const nodes: NodeData[] = [];
    const edges: Edge[] = [];
    const swimlanes: Swimlane[] = [];
    const actionPositions = new Map<string, Pos>(); // action name → position
    const eventPositions = new Map<string, Pos>(); // event name → position

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

    let swimlaneY = 0;

    for (const state of [...stateByName.values()]) {
      // Group events by which action emits them
      const actionEventGroups = new Map<string, string[]>();
      const ungroupedEvents = new Set(state.events.map((e) => e.name));

      for (const action of state.actions) {
        actionEventGroups.set(action.name, [...action.emits]);
        for (const en of action.emits) ungroupedEvents.delete(en);
      }

      // Compute swimlane height based on max stacked events
      let maxStack = 1;
      for (const eventNames of actionEventGroups.values()) {
        maxStack = Math.max(maxStack, eventNames.length);
      }
      const swimlaneH = Math.max(
        MIN_SWIMLANE_H,
        EVT_Y + maxStack * (NODE_H + STACK_OFFSET) + 12
      );

      swimlanes.push({
        label: state.name,
        y: swimlaneY,
        h: swimlaneH,
        line: state.line,
      });

      // Layout vertical slices: each action + its events as a column
      let sliceX = LABEL_W + H_GAP;

      for (const action of state.actions) {
        const eventNames = actionEventGroups.get(action.name) ?? [];

        // Action node (top)
        const aKey = `action:${action.name}`;
        const aPos = { x: sliceX, y: swimlaneY + CMD_Y };
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
        actionPositions.set(action.name, aPos);

        // Events (stacked below action)
        for (let ei = 0; ei < eventNames.length; ei++) {
          const eName = eventNames[ei];
          const eKey = `event:${eName}`;
          if (!eventPositions.has(eName)) {
            const ePos = {
              x: sliceX,
              y: swimlaneY + EVT_Y + ei * (NODE_H + STACK_OFFSET),
            };
            nodes.push({
              key: eKey,
              pos: ePos,
              type: "event",
              label: eName,
              line: state.events.find((e) => e.name === eName)?.line,
            });
            eventPositions.set(eName, ePos);

            // Action → Event edge
            edges.push({
              from: { x: aPos.x + NODE_W / 2, y: aPos.y + NODE_H },
              to: { x: ePos.x + NODE_W / 2, y: ePos.y },
              color: COLORS.action.border,
            });
          }
        }

        sliceX += NODE_W + H_GAP;
      }

      // Ungrouped events (emitted but not linked to a specific action)
      for (const eName of ungroupedEvents) {
        const eKey = `event:${eName}`;
        if (!eventPositions.has(eName)) {
          const ePos = { x: sliceX, y: swimlaneY + EVT_Y };
          nodes.push({
            key: eKey,
            pos: ePos,
            type: "event",
            label: eName,
            line: state.events.find((e) => e.name === eName)?.line,
          });
          eventPositions.set(eName, ePos);
          sliceX += NODE_W + H_GAP;
        }
      }

      swimlaneY += swimlaneH;
    }

    // Reactions — each as a proper node: Event → [Reaction] → Action
    const allReactions = [
      ...model.slices.flatMap((s) => s.reactions),
      ...model.reactions,
    ];
    let reactX = LABEL_W + H_GAP;
    const reactY = swimlaneY + 10;
    for (const reaction of allReactions) {
      if (reaction.isVoid) continue;
      const ePos = eventPositions.get(reaction.event);

      const rKey = `reaction:${reaction.handlerName}`;
      const rPos = { x: reactX, y: reactY };
      nodes.push({
        key: rKey,
        pos: rPos,
        type: "reaction",
        label: reaction.handlerName,
        line: reaction.line,
      });

      // Event → Reaction edge
      if (ePos) {
        edges.push({
          from: { x: ePos.x + NODE_W / 2, y: ePos.y + NODE_H },
          to: { x: rPos.x + NODE_W / 2, y: rPos.y },
          color: COLORS.reaction.border,
          dashed: true,
        });
      }

      // Reaction → Action edges
      for (const actionName of reaction.dispatches) {
        const aPos = actionPositions.get(actionName);
        if (aPos) {
          edges.push({
            from: { x: rPos.x + NODE_W, y: rPos.y + NODE_H / 2 },
            to: { x: aPos.x, y: aPos.y + NODE_H / 2 },
            color: COLORS.reaction.border,
            dashed: true,
          });
        }
      }

      reactX += NODE_W + H_GAP;
    }

    // Projections — below reactions
    let projX = LABEL_W + H_GAP;
    const projY = allReactions.some((r) => !r.isVoid)
      ? reactY + NODE_H + 20
      : swimlaneY + 10;
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

    // Slice boxes — group their members
    const boxes: Array<{
      label: string;
      x: number;
      y: number;
      w: number;
      h: number;
    }> = [];
    // Build varName → original unmerged state lookup
    const varToOriginalState = new Map<string, (typeof model.states)[0]>();
    for (const s of model.states) {
      varToOriginalState.set(s.varName, s);
    }

    for (const slice of model.slices) {
      const memberKeys: string[] = [];
      // Use stateVars to get original partial states (not merged)
      for (const sv of slice.stateVars) {
        const st = varToOriginalState.get(sv);
        if (st) {
          for (const a of st.actions) memberKeys.push(`action:${a.name}`);
          for (const e of st.events) memberKeys.push(`event:${e.name}`);
        }
      }
      for (const r of slice.reactions)
        memberKeys.push(`reaction:${r.handlerName}`);
      for (const pn of slice.projections) memberKeys.push(`projection:${pn}`);

      let minX = Infinity,
        minY = Infinity,
        maxX = 0,
        maxY = 0;
      for (const k of memberKeys) {
        const n = nodes.find((nd) => nd.key === k);
        if (n) {
          minX = Math.min(minX, n.pos.x);
          minY = Math.min(minY, n.pos.y);
          maxX = Math.max(maxX, n.pos.x + NODE_W);
          maxY = Math.max(maxY, n.pos.y + NODE_H);
        }
      }
      if (minX < Infinity) {
        boxes.push({
          label: slice.name.replace(/Slice$/i, ""),
          x: minX - 8,
          y: minY - 18,
          w: maxX - minX + 16,
          h: maxY - minY + 26,
        });
      }
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
      boxes,
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
          {/* Swimlanes */}
          {swimlanes.map((sl, i) => (
            <g key={sl.label}>
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
                className="text-[11px] font-medium"
              >
                {sl.label}
              </text>
            </g>
          ))}

          {/* Slice boxes */}
          {boxes.map((box) => (
            <g key={box.label}>
              <rect
                x={box.x}
                y={box.y}
                width={box.w}
                height={box.h}
                rx={6}
                fill="none"
                stroke="#52525b"
                strokeWidth={1}
                strokeDasharray="6,4"
              />
              <text
                x={box.x + 6}
                y={box.y + 11}
                fill="#71717a"
                className="text-[8px]"
              >
                {box.label}
              </text>
            </g>
          ))}

          {/* Edges */}
          {edges.map((edge, i) => {
            const dx = edge.to.x - edge.from.x;
            const dy = edge.to.y - edge.from.y;
            const isStraight = Math.abs(dx) < 5;
            const d = isStraight
              ? `M ${edge.from.x} ${edge.from.y} L ${edge.to.x} ${edge.to.y}`
              : `M ${edge.from.x} ${edge.from.y} C ${edge.from.x + dx * 0.3} ${edge.from.y + dy * 0.1}, ${edge.to.x - dx * 0.3} ${edge.to.y - dy * 0.1}, ${edge.to.x} ${edge.to.y}`;
            return (
              <path
                key={i}
                d={d}
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
