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
};

const NODE_W = 140;
const NODE_H = 34;
const H_GAP = 50;
const V_GAP = 16;
const SLICE_PAD = 12;

type NodePos = {
  x: number;
  y: number;
  type: keyof typeof COLORS;
  label: string;
  sublabel?: string;
  line?: number;
};

type Edge = {
  from: string;
  to: string;
  label?: string;
};

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

  const { nodes, edges, sliceBoxes, width, height } = useMemo(() => {
    const nodes = new Map<string, NodePos>();
    const edges: Edge[] = [];
    const sliceBoxes: Array<{
      name: string;
      x: number;
      y: number;
      w: number;
      h: number;
    }> = [];

    // Layout columns: Actions | Events | States
    const COL_ACTION = 0;
    const COL_EVENT = 1;
    const COL_STATE = 2;
    const COL_REACTION = 1; // below events
    const COL_PROJECTION = 1; // below reactions

    let actionY = 0;
    let eventY = 0;
    let stateY = 0;

    // Place states
    for (const s of model.states) {
      const key = `state:${s.name}`;
      nodes.set(key, {
        x: COL_STATE * (NODE_W + H_GAP),
        y: stateY,
        type: "state",
        label: s.name,
        line: s.line,
      });
      stateY += NODE_H + V_GAP;

      // Place events
      for (const e of s.events) {
        const eKey = `event:${e.name}`;
        if (!nodes.has(eKey)) {
          nodes.set(eKey, {
            x: COL_EVENT * (NODE_W + H_GAP),
            y: eventY,
            type: "event",
            label: e.name,
            sublabel: e.hasCustomPatch ? "patch" : "passthrough",
            line: e.line,
          });
          // Event → State (patches)
          edges.push({ from: eKey, to: key, label: "patches" });
          eventY += NODE_H + V_GAP;
        }
      }

      // Place actions
      for (const a of s.actions) {
        const aKey = `action:${a.name}`;
        if (!nodes.has(aKey)) {
          nodes.set(aKey, {
            x: COL_ACTION * (NODE_W + H_GAP),
            y: actionY,
            type: "action",
            label: a.name,
            sublabel:
              a.invariants.length > 0
                ? `${a.invariants.length} invariant(s)`
                : undefined,
            line: a.line,
          });
          actionY += NODE_H + V_GAP;

          // Action → Event (emits)
          for (const ename of a.emits) {
            const eKey = `event:${ename}`;
            edges.push({ from: aKey, to: eKey, label: "emits" });
          }
        }

        // Place invariants
        for (const inv of a.invariants) {
          const iKey = `invariant:${a.name}:${inv}`;
          if (!nodes.has(iKey)) {
            nodes.set(iKey, {
              x: COL_ACTION * (NODE_W + H_GAP) - 10,
              y: actionY,
              type: "invariant",
              label: inv.length > 18 ? inv.slice(0, 16) + "..." : inv,
              sublabel: a.name,
            });
            actionY += NODE_H + V_GAP / 2;
          }
        }
      }
    }

    // Place reactions (below events column)
    let reactionY = Math.max(eventY, stateY) + V_GAP;
    const allReactions = [
      ...model.slices.flatMap((s) => s.reactions),
      ...model.reactions,
    ];
    for (const r of allReactions) {
      const rKey = `reaction:${r.event}`;
      if (!nodes.has(rKey)) {
        nodes.set(rKey, {
          x: COL_REACTION * (NODE_W + H_GAP),
          y: reactionY,
          type: "reaction",
          label: `on ${r.event}`,
          sublabel: r.isVoid ? "void" : "drain",
          line: r.line,
        });
        reactionY += NODE_H + V_GAP;

        // Event → Reaction (triggers)
        const eKey = `event:${r.event}`;
        edges.push({ from: eKey, to: rKey, label: "triggers" });
      }
    }

    // Place projections (below reactions)
    let projectionY = reactionY + V_GAP;
    for (const p of model.projections) {
      const pKey = `projection:${p.name}`;
      if (!nodes.has(pKey)) {
        nodes.set(pKey, {
          x: COL_PROJECTION * (NODE_W + H_GAP),
          y: projectionY,
          type: "projection",
          label: p.name,
          line: p.line,
        });
        projectionY += NODE_H + V_GAP;

        for (const ename of p.handles) {
          const eKey = `event:${ename}`;
          edges.push({ from: eKey, to: pKey, label: "projects" });
        }
      }
    }

    // Slice boxes
    for (const s of model.slices) {
      const memberKeys: string[] = [];
      for (const sn of s.states) memberKeys.push(`state:${sn}`);
      for (const r of s.reactions) memberKeys.push(`reaction:${r.event}`);
      for (const pn of s.projections) memberKeys.push(`projection:${pn}`);

      let minX = Infinity,
        minY = Infinity,
        maxX = 0,
        maxY = 0;
      for (const k of memberKeys) {
        const n = nodes.get(k);
        if (n) {
          minX = Math.min(minX, n.x);
          minY = Math.min(minY, n.y);
          maxX = Math.max(maxX, n.x + NODE_W);
          maxY = Math.max(maxY, n.y + NODE_H);
        }
      }
      if (minX < Infinity) {
        sliceBoxes.push({
          name: s.name,
          x: minX - SLICE_PAD,
          y: minY - SLICE_PAD - 14,
          w: maxX - minX + SLICE_PAD * 2,
          h: maxY - minY + SLICE_PAD * 2 + 14,
        });
      }
    }

    // Compute bounds
    let maxW = 0,
      maxH = 0;
    for (const n of nodes.values()) {
      maxW = Math.max(maxW, n.x + NODE_W);
      maxH = Math.max(maxH, n.y + NODE_H);
    }

    return {
      nodes,
      edges,
      sliceBoxes,
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
        {sliceBoxes.map((sb) => (
          <g key={sb.name}>
            <rect
              x={sb.x}
              y={sb.y}
              width={sb.w}
              height={sb.h}
              rx={8}
              fill="none"
              stroke="#3f3f46"
              strokeWidth={1}
              strokeDasharray="6,4"
            />
            <text
              x={sb.x + 8}
              y={sb.y + 11}
              className="fill-zinc-500 text-[9px]"
            >
              {sb.name}
            </text>
          </g>
        ))}

        {/* Edges */}
        {edges.map((edge, i) => {
          const from = nodes.get(edge.from);
          const to = nodes.get(edge.to);
          if (!from || !to) return null;

          const x1 = from.x + NODE_W;
          const y1 = from.y + NODE_H / 2;
          const x2 = to.x;
          const y2 = to.y + NODE_H / 2;

          // Curved path
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

        {/* Arrow marker */}
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
        {[...nodes.entries()].map(([key, node]) => {
          const color = COLORS[node.type];
          const hasWarning = warningSet.has(node.label);

          return (
            <g
              key={key}
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
                x={node.x}
                y={node.y}
                width={NODE_W}
                height={NODE_H}
                rx={6}
                fill={color.bg}
                stroke={hasWarning ? "#ef4444" : color.border}
                strokeWidth={hasWarning ? 2 : 1}
              />
              <text
                x={node.x + 8}
                y={node.y + 14}
                className="text-[10px] font-medium"
                fill={color.text}
              >
                {node.label.length > 16
                  ? node.label.slice(0, 14) + "..."
                  : node.label}
              </text>
              {node.sublabel && (
                <text
                  x={node.x + 8}
                  y={node.y + 26}
                  className="text-[8px]"
                  fill="#71717a"
                >
                  {node.sublabel}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {/* Tooltip */}
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
