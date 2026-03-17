import { useMemo, useState } from "react";
import type { DomainModel, ValidationWarning } from "./types.js";

// Event Storming colors
const COLORS = {
  action: { bg: "#1e3a5f", border: "#2563eb", text: "#60a5fa" },
  event: { bg: "#4a2c17", border: "#ea580c", text: "#fb923c" },
  state: { bg: "#3d3510", border: "#ca8a04", text: "#facc15" },
  reaction: { bg: "#2e1a47", border: "#7c3aed", text: "#a78bfa" },
  projection: { bg: "#0d3320", border: "#16a34a", text: "#4ade80" },
  invariant: { bg: "#3b1219", border: "#dc2626", text: "#f87171" },
  slice: { bg: "transparent", border: "#52525b", text: "#71717a" },
};

const NODE_W = 150;
const NODE_H = 34;
const H_GAP = 60;
const V_GAP = 12;
const SECTION_GAP = 30;

type Pos = { x: number; y: number };
type NodeData = {
  key: string;
  pos: Pos;
  type: keyof typeof COLORS;
  label: string;
  sublabel?: string;
  line?: number;
};
type Edge = { fromKey: string; toKey: string; label: string };
type Box = { label: string; x: number; y: number; w: number; h: number };

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

  const { nodes, edges, boxes, width, height } = useMemo(() => {
    const nodes: NodeData[] = [];
    const edges: Edge[] = [];
    const boxes: Box[] = [];
    const nodeMap = new Map<string, Pos>();

    // Deduplicate states by name (partial states merge)
    const stateByName = new Map<string, (typeof model.states)[0]>();
    for (const s of model.states) {
      const existing = stateByName.get(s.name);
      if (existing) {
        // Merge events and actions
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

    // Layout per state: Action column → Event column → State column
    let globalY = 20;

    for (const state of mergedStates) {
      const stateStartY = globalY;

      // Place state node (right column)
      const stateKey = `state:${state.name}`;
      const stateX = 2 * (NODE_W + H_GAP);

      // Collect all events and actions for this state
      const eventKeys: string[] = [];
      const actionKeys: string[] = [];
      let localY = stateStartY;

      // Actions (left column)
      for (const action of state.actions) {
        const aKey = `action:${action.name}`;
        const pos = { x: 0, y: localY };
        nodes.push({
          key: aKey,
          pos,
          type: "action",
          label: action.name,
          sublabel:
            action.invariants.length > 0
              ? `${action.invariants.length} guard(s)`
              : undefined,
          line: action.line,
        });
        nodeMap.set(aKey, pos);
        actionKeys.push(aKey);

        // Action → Event edges
        for (const ename of action.emits) {
          edges.push({
            fromKey: aKey,
            toKey: `event:${ename}`,
            label: "emits",
          });
        }

        localY += NODE_H + V_GAP;
      }

      // Events (middle column)
      let eventY = stateStartY;
      for (const event of state.events) {
        const eKey = `event:${event.name}`;
        if (!nodeMap.has(eKey)) {
          const pos = { x: NODE_W + H_GAP, y: eventY };
          nodes.push({
            key: eKey,
            pos,
            type: "event",
            label: event.name,
            sublabel: event.hasCustomPatch ? "custom patch" : "passthrough",
            line: event.line,
          });
          nodeMap.set(eKey, pos);
          eventKeys.push(eKey);

          // Event → State edge
          edges.push({ fromKey: eKey, toKey: stateKey, label: "patches" });

          eventY += NODE_H + V_GAP;
        }
      }

      // State node (right column, vertically centered)
      const stateHeight = Math.max(localY, eventY) - stateStartY;
      const stateCenterY =
        stateStartY + Math.max(0, stateHeight / 2 - NODE_H / 2);
      const statePos = { x: stateX, y: stateCenterY };
      nodes.push({
        key: stateKey,
        pos: statePos,
        type: "state",
        label: state.name,
        line: state.line,
      });
      nodeMap.set(stateKey, statePos);

      globalY = Math.max(localY, eventY) + SECTION_GAP;
    }

    // Reactions (below, middle column)
    const allReactions = [
      ...model.slices.flatMap((s) => s.reactions),
      ...model.reactions,
    ];
    const reactionStartY = globalY;
    for (const r of allReactions) {
      const rKey = `reaction:${r.event}`;
      if (!nodeMap.has(rKey)) {
        const pos = { x: NODE_W + H_GAP, y: globalY };
        nodes.push({
          key: rKey,
          pos,
          type: "reaction",
          label: `on ${r.event}`,
          sublabel: r.isVoid ? "void" : "drain",
          line: r.line,
        });
        nodeMap.set(rKey, pos);

        // Event → Reaction edge
        edges.push({
          fromKey: `event:${r.event}`,
          toKey: rKey,
          label: "triggers",
        });

        globalY += NODE_H + V_GAP;
      }
    }

    // Projections (below reactions, middle column)
    if (model.projections.length > 0 && globalY === reactionStartY) {
      // No reactions, start projections at the same Y
    } else if (model.projections.length > 0) {
      globalY += V_GAP;
    }

    for (const p of model.projections) {
      const pKey = `projection:${p.name}`;
      if (!nodeMap.has(pKey)) {
        const pos = { x: NODE_W + H_GAP, y: globalY };
        nodes.push({
          key: pKey,
          pos,
          type: "projection",
          label: p.name,
          line: p.line,
        });
        nodeMap.set(pKey, pos);

        for (const ename of p.handles) {
          edges.push({
            fromKey: `event:${ename}`,
            toKey: pKey,
            label: "projects",
          });
        }

        globalY += NODE_H + V_GAP;
      }
    }

    // Slice boxes — contain their states, reactions, projections
    for (const slice of model.slices) {
      const memberKeys: string[] = [];
      // Resolve state names
      for (const sn of slice.states) {
        memberKeys.push(`state:${sn}`);
        // Also include events and actions of this state
        const st = stateByName.get(sn);
        if (st) {
          for (const e of st.events) memberKeys.push(`event:${e.name}`);
          for (const a of st.actions) memberKeys.push(`action:${a.name}`);
        }
      }
      for (const r of slice.reactions) memberKeys.push(`reaction:${r.event}`);
      for (const pn of slice.projections) memberKeys.push(`projection:${pn}`);

      let minX = Infinity,
        minY = Infinity,
        maxX = 0,
        maxY = 0;
      for (const k of memberKeys) {
        const pos = nodeMap.get(k);
        if (pos) {
          minX = Math.min(minX, pos.x);
          minY = Math.min(minY, pos.y);
          maxX = Math.max(maxX, pos.x + NODE_W);
          maxY = Math.max(maxY, pos.y + NODE_H);
        }
      }
      if (minX < Infinity) {
        boxes.push({
          label: slice.name,
          x: minX - 10,
          y: minY - 22,
          w: maxX - minX + 20,
          h: maxY - minY + 32,
        });
      }
    }

    // Compute bounds
    let maxW = 0,
      maxH = 0;
    for (const n of nodes) {
      maxW = Math.max(maxW, n.pos.x + NODE_W);
      maxH = Math.max(maxH, n.pos.y + NODE_H);
    }

    return {
      nodes,
      edges,
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

  return (
    <div className="relative h-full overflow-auto bg-zinc-950 p-4">
      <svg width={width} height={height} className="select-none">
        {/* Slice boxes */}
        {boxes.map((box) => (
          <g key={box.label}>
            <rect
              x={box.x}
              y={box.y}
              width={box.w}
              height={box.h}
              rx={8}
              fill="none"
              stroke={COLORS.slice.border}
              strokeWidth={1}
              strokeDasharray="6,4"
            />
            <text
              x={box.x + 8}
              y={box.y + 13}
              fill={COLORS.slice.text}
              className="text-[9px] font-medium"
            >
              slice: {box.label}
            </text>
          </g>
        ))}

        {/* Edges */}
        {edges.map((edge, i) => {
          const from = nodes.find((n) => n.key === edge.fromKey);
          const to = nodes.find((n) => n.key === edge.toKey);
          if (!from || !to) return null;

          const x1 = from.pos.x + NODE_W;
          const y1 = from.pos.y + NODE_H / 2;
          const x2 = to.pos.x;
          const y2 = to.pos.y + NODE_H / 2;

          // If same column, offset
          const sameCol = Math.abs(x1 - NODE_W - x2) < 10;
          if (sameCol) {
            // Vertical edge (reaction/projection below event)
            return (
              <g key={i}>
                <path
                  d={`M ${from.pos.x + NODE_W / 2} ${from.pos.y + NODE_H} L ${to.pos.x + NODE_W / 2} ${to.pos.y}`}
                  fill="none"
                  stroke="#3f3f46"
                  strokeWidth={1}
                  markerEnd="url(#arrowhead)"
                />
              </g>
            );
          }

          const midX = (x1 + x2) / 2;
          return (
            <g key={i}>
              <path
                d={`M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`}
                fill="none"
                stroke="#3f3f46"
                strokeWidth={1}
                markerEnd="url(#arrowhead)"
              />
            </g>
          );
        })}

        <defs>
          <marker
            id="arrowhead"
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
                rx={6}
                fill={color.bg}
                stroke={hasWarning ? "#ef4444" : color.border}
                strokeWidth={hasWarning ? 2 : 1}
              />
              <text
                x={node.pos.x + 8}
                y={node.pos.y + (node.sublabel ? 13 : 17)}
                fill={color.text}
                className="text-[10px] font-medium"
              >
                {node.label.length > 18
                  ? node.label.slice(0, 16) + "..."
                  : node.label}
              </text>
              {node.sublabel && (
                <text
                  x={node.pos.x + 8}
                  y={node.pos.y + 26}
                  fill="#71717a"
                  className="text-[8px]"
                >
                  {node.sublabel}
                </text>
              )}
            </g>
          );
        })}
      </svg>

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
