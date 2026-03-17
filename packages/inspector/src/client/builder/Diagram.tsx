import { Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import type { DomainModel, StateNode, ValidationWarning } from "./types.js";

const COLORS = {
  action: { bg: "#1e40af", border: "#3b82f6", text: "#93c5fd" },
  event: { bg: "#c2410c", border: "#f97316", text: "#fed7aa" },
  state: { bg: "#a16207", border: "#eab308", text: "#fef08a" },
  reaction: { bg: "#7e22ce", border: "#a855f7", text: "#d8b4fe" },
  projection: { bg: "#15803d", border: "#22c55e", text: "#bbf7d0" },
};

const W = 120,
  H = 36,
  GAP = 14,
  PAD = 10;

function splitLabel(label: string): string[] {
  const words = label.replace(/([a-z])([A-Z])/g, "$1 $2").split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur && (cur + " " + w).length > 16) {
      lines.push(cur);
      cur = w;
    } else cur = cur ? cur + " " + w : w;
  }
  if (cur) lines.push(cur);
  return lines.length > 0 ? lines : [label];
}

type Pos = { x: number; y: number };
type N = {
  key: string;
  pos: Pos;
  type: keyof typeof COLORS;
  label: string;
  sub?: string;
  line?: number;
  projections?: string[];
  guards?: string[];
};
type E = { from: Pos; to: Pos; color: string; dash?: boolean };
type Box = { label: string; x: number; y: number; w: number; h: number };

type Props = {
  model: DomainModel;
  warnings: ValidationWarning[];
  onClickLine?: (line: number) => void;
};

export function Diagram({ model, warnings, onClickLine }: Props) {
  const [tip, setTip] = useState<{ x: number; y: number; t: string } | null>(
    null
  );
  const warnSet = new Set(warnings.map((w) => w.element).filter(Boolean));
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const drag = useRef(false);
  const start = useRef({ x: 0, y: 0, px: 0, py: 0 });

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setZoom((z) =>
      Math.max(0.2, Math.min(3, z * (e.deltaY < 0 ? 1.15 : 1 / 1.15)))
    );
  }, []);
  const onDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      drag.current = true;
      start.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
    },
    [pan]
  );
  const onMove = useCallback((e: React.MouseEvent) => {
    if (!drag.current) return;
    setPan({
      x: start.current.px + (e.clientX - start.current.x),
      y: start.current.py + (e.clientY - start.current.y),
    });
  }, []);
  const onUp = useCallback(() => {
    drag.current = false;
  }, []);
  const reset = useCallback(() => {
    setPan({ x: 0, y: 0 });
    setZoom(1);
  }, []);

  const { ns, es, boxes, width, height } = useMemo(() => {
    const ns: N[] = [];
    const es: E[] = [];
    const boxes: Box[] = [];
    const sv = new Map<string, StateNode>();
    for (const s of model.states) sv.set(s.varName, s);

    // Build projection lookup: event name → projection names
    const eventProjections = new Map<string, string[]>();
    for (const proj of model.projections) {
      for (const en of proj.handles) {
        const list = eventProjections.get(en) ?? [];
        list.push(proj.name);
        eventProjections.set(en, list);
      }
    }

    const sliceEvts = new Map<string, Set<string>>();
    let cx = PAD,
      maxY = 0;

    /**
     * Pure left-to-right DAG per slice:
     * For each action row: [Action] → [Event] → [Event] → [Reaction] → [Action'] → [Event'] → ...
     * Reactions that dispatch to actions DUPLICATE the target action (no backward arrows).
     */
    for (const slice of model.slices) {
      const sx = cx;
      const parts = slice.stateVars
        .map((v) => sv.get(v))
        .filter(Boolean) as StateNode[];
      const evts = new Set<string>();
      for (const st of parts) for (const e of st.events) evts.add(e.name);
      sliceEvts.set(slice.name, evts);

      const acts = parts.flatMap((st) => st.actions);
      const eDefs = parts.flatMap((st) => st.events);
      const stateName = parts[0]?.name ?? "";

      let y = PAD + H + GAP;
      let sliceRightX = cx;

      // Each action → its events on one row
      for (const action of acts) {
        let x = cx;
        const ap = { x, y };
        ns.push({
          key: `a:${action.name}:${slice.name}`,
          pos: ap,
          type: "action",
          label: action.name,
          sub: action.invariants.length > 0 ? "guarded" : undefined,
          line: action.line,
          guards: action.invariants.length > 0 ? action.invariants : undefined,
        });
        x += W + GAP;

        for (const en of action.emits) {
          const ep = { x, y };
          const projs = eventProjections.get(en);
          ns.push({
            key: `e:${en}:${slice.name}:${action.name}`,
            pos: ep,
            type: "event",
            label: en,
            line: eDefs.find((e) => e.name === en)?.line,
            projections: projs,
          });
          es.push({
            from: { x: ap.x + W, y: ap.y + H / 2 },
            to: { x: ep.x, y: ep.y + H / 2 },
            color: COLORS.action.border,
          });
          x += W + GAP;
        }

        sliceRightX = Math.max(sliceRightX, x);
        y += H + GAP / 2;
      }

      // Reactions — continue the flow to the right
      for (const r of slice.reactions) {
        if (r.isVoid) continue;

        // Find which row the triggering event is on
        const trigNode = ns.find(
          (n) =>
            n.type === "event" &&
            n.label === r.event &&
            n.key.includes(slice.name)
        );
        const rY = trigNode ? trigNode.pos.y : y;
        const rX = sliceRightX;

        // Reaction box
        const rp = { x: rX, y: rY };
        ns.push({
          key: `r:${r.handlerName}:${slice.name}`,
          pos: rp,
          type: "reaction",
          label: r.handlerName,
          line: r.line,
        });

        // Event → Reaction arrow
        if (trigNode) {
          es.push({
            from: { x: trigNode.pos.x + W, y: trigNode.pos.y + H / 2 },
            to: { x: rp.x, y: rp.y + H / 2 },
            color: COLORS.reaction.border,
            dash: true,
          });
        }

        let nextX = rX + W + GAP;

        // Dispatched actions — DUPLICATE as new nodes (forward flow, no backward arrows)
        for (const an of r.dispatches) {
          const targetAction =
            acts.find((a) => a.name === an) ??
            model.states.flatMap((s) => s.actions).find((a) => a.name === an);

          if (targetAction) {
            const dap = { x: nextX, y: rY };
            ns.push({
              key: `a:${an}:dispatched:${r.handlerName}`,
              pos: dap,
              type: "action",
              label: an,
              line: targetAction.line,
            });
            es.push({
              from: { x: rp.x + W, y: rp.y + H / 2 },
              to: { x: dap.x, y: dap.y + H / 2 },
              color: COLORS.reaction.border,
              dash: true,
            });
            nextX += W + GAP;

            // And its events
            for (const en of targetAction.emits) {
              const dep = { x: nextX, y: rY };
              const projs = eventProjections.get(en);
              ns.push({
                key: `e:${en}:dispatched:${r.handlerName}`,
                pos: dep,
                type: "event",
                label: en,
                projections: projs,
              });
              es.push({
                from: { x: dap.x + W, y: dap.y + H / 2 },
                to: { x: dep.x, y: dep.y + H / 2 },
                color: COLORS.action.border,
              });
              nextX += W + GAP;
            }
          }
        }

        sliceRightX = Math.max(sliceRightX, nextX);
        y = Math.max(y, rY + H + GAP / 2);
      }

      maxY = Math.max(maxY, y);

      // Slice boundary
      boxes.push({
        label: `${slice.name.replace(/Slice$/i, "")} (${stateName})`,
        x: sx - 4,
        y: PAD - 4,
        w: sliceRightX - sx + 4,
        h: maxY - PAD + 8,
      });
      cx = sliceRightX + GAP * 2;
    }

    // Standalone states
    const claimed = new Set(model.slices.flatMap((sl) => sl.stateVars));
    for (const st of model.states.filter((s) => !claimed.has(s.varName))) {
      let y = PAD;
      for (const action of st.actions) {
        let x = cx;
        const ap = { x, y };
        ns.push({
          key: `a:${action.name}:standalone`,
          pos: ap,
          type: "action",
          label: action.name,
          sub: action.invariants.length > 0 ? "guarded" : undefined,
          line: action.line,
          guards: action.invariants.length > 0 ? action.invariants : undefined,
        });
        x += W + GAP;
        for (const en of action.emits) {
          const ep = { x, y };
          const projs = eventProjections.get(en);
          ns.push({
            key: `e:${en}:standalone`,
            pos: ep,
            type: "event",
            label: en,
            line: st.events.find((e) => e.name === en)?.line,
            projections: projs,
          });
          es.push({
            from: { x: ap.x + W, y: ap.y + H / 2 },
            to: { x: ep.x, y: ep.y + H / 2 },
            color: COLORS.action.border,
          });
          x += W + GAP;
        }
        cx = Math.max(cx, x);
        y += H + GAP / 2;
      }
      maxY = Math.max(maxY, y);
      cx += GAP;
    }

    let mw = 0,
      mh = 0;
    for (const n of ns) {
      mw = Math.max(mw, n.pos.x + W);
      mh = Math.max(mh, n.pos.y + H);
    }
    return { ns, es, boxes, width: mw + 30, height: mh + 30 };
  }, [model]);

  if (model.states.length === 0 && model.projections.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-zinc-600">
        Import from GitHub or generate with AI
      </div>
    );
  }

  const sw = Math.max(width, 400),
    sh = Math.max(height, 150);

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
          onClick={reset}
          className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
          title="Fit"
        >
          <Maximize2 size={13} />
        </button>
        <span className="text-[9px] text-zinc-600">
          {Math.round(zoom * 100)}%
        </span>
        <div className="ml-3 flex items-center gap-2.5 text-[8px] text-zinc-500">
          {(["action", "event", "reaction", "projection"] as const).map((t) => (
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
                  action: "Action",
                  event: "Event",
                  reaction: "Reaction",
                  projection: "Projection",
                }[t]
              }
            </span>
          ))}
        </div>
      </div>

      <div
        className={`flex-1 overflow-hidden ${drag.current ? "cursor-grabbing" : "cursor-grab"}`}
        onWheel={onWheel}
        onMouseDown={onDown}
        onMouseMove={onMove}
        onMouseUp={onUp}
        onMouseLeave={onUp}
      >
        <svg
          width="100%"
          height="100%"
          viewBox={`${-pan.x / zoom} ${-pan.y / zoom} ${sw / zoom} ${sh / zoom}`}
          className="select-none"
        >
          {/* Slice boundaries */}
          {boxes.map((b) => (
            <g key={b.label}>
              <rect
                x={b.x}
                y={b.y}
                width={b.w}
                height={b.h}
                rx={8}
                fill={COLORS.state.bg}
                fillOpacity={0.1}
                stroke={COLORS.state.border}
                strokeWidth={1.5}
                strokeOpacity={0.4}
              />
              <text
                x={b.x + 8}
                y={b.y + 12}
                fill={COLORS.state.text}
                className="text-[10px] font-semibold"
              >
                {b.label}
              </text>
            </g>
          ))}

          {/* Edges — all forward, no labels */}
          {es.map((e, i) => (
            <path
              key={i}
              d={`M ${e.from.x} ${e.from.y} L ${e.to.x} ${e.to.y}`}
              fill="none"
              stroke={e.color}
              strokeWidth={1.5}
              strokeDasharray={e.dash ? "4,3" : undefined}
              opacity={0.7}
              markerEnd="url(#arr)"
            />
          ))}
          <defs>
            <marker
              id="arr"
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
          {ns.map((n) => {
            const c = COLORS[n.type];
            const hasWarn = warnSet.has(n.label);
            const lines = splitLabel(n.label);
            const lineH = 11;
            const startY = n.sub
              ? n.pos.y + 4
              : n.pos.y + H / 2 - ((lines.length - 1) * lineH) / 2;

            return (
              <g
                key={n.key}
                className="cursor-pointer"
                onClick={() => n.line && onClickLine?.(n.line)}
                onMouseEnter={(ev) => {
                  const parts = [n.label];
                  if (n.guards?.length)
                    parts.push(`Guards: ${n.guards.join(", ")}`);
                  if (n.projections?.length)
                    parts.push(`Projections: ${n.projections.join(", ")}`);
                  setTip({ x: ev.clientX, y: ev.clientY, t: parts.join("\n") });
                }}
                onMouseLeave={() => setTip(null)}
              >
                <rect
                  x={n.pos.x}
                  y={n.pos.y}
                  width={W}
                  height={H}
                  rx={4}
                  fill={c.bg}
                  stroke={hasWarn ? "#ef4444" : c.border}
                  strokeWidth={hasWarn ? 2 : 1.5}
                />
                {lines.map((line, li) => (
                  <text
                    key={li}
                    x={n.pos.x + W / 2}
                    y={startY + li * lineH}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fill={c.text}
                    className="text-[8px] font-medium"
                  >
                    {line}
                  </text>
                ))}
                {n.sub && (
                  <text
                    x={n.pos.x + W / 2}
                    y={n.pos.y + H - 4}
                    textAnchor="middle"
                    fill="#a1a1aa"
                    className="text-[7px]"
                  >
                    {n.sub}
                  </text>
                )}
                {/* Projection marker */}
                {n.projections && n.projections.length > 0 && (
                  <circle
                    cx={n.pos.x + W - 5}
                    cy={n.pos.y + 5}
                    r={3}
                    fill={COLORS.projection.bg}
                    stroke={COLORS.projection.border}
                    strokeWidth={1}
                  />
                )}
              </g>
            );
          })}
        </svg>
      </div>

      {tip && (
        <div
          className="pointer-events-none fixed z-50 max-w-xs rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 shadow-2xl"
          style={{ left: tip.x + 14, top: tip.y - 12 }}
        >
          {tip.t.split("\n").map((line, i) => (
            <div
              key={i}
              className={
                i === 0
                  ? "text-[11px] font-medium text-zinc-200"
                  : "mt-0.5 text-[9px] text-zinc-400"
              }
            >
              {i > 0 && line.includes(":") ? (
                <>
                  <span className="text-zinc-500">{line.split(":")[0]}:</span>
                  <span className="text-zinc-300">
                    {line.slice(line.indexOf(":") + 1)}
                  </span>
                </>
              ) : (
                line
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
