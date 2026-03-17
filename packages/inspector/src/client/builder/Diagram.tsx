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

/** Split PascalCase into wrapped lines */
function splitLabel(label: string): string[] {
  const words = label.replace(/([a-z])([A-Z])/g, "$1 $2").split(" ");
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    if (current && (current + " " + w).length > 16) {
      lines.push(current);
      current = w;
    } else {
      current = current ? current + " " + w : w;
    }
  }
  if (current) lines.push(current);
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
};
type E = { from: Pos; to: Pos; color: string; dash?: boolean; label?: string };
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
  const warn = new Set(warnings.map((w) => w.element).filter(Boolean));
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
    const aPos = new Map<string, Pos>();
    const ePos = new Map<string, Pos>();
    const sv = new Map<string, StateNode>();
    for (const s of model.states) sv.set(s.varName, s);

    const sliceEvts = new Map<string, Set<string>>();
    let cx = PAD,
      maxY = 0;

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

      // Each action on its own row: [Action] → [Event1] → [Event2]
      let y = PAD + H + GAP; // leave room for slice title
      let sliceRightX = cx;
      for (const action of acts) {
        const ap = { x: cx, y };
        ns.push({
          key: `a:${action.name}`,
          pos: ap,
          type: "action",
          label: action.name,
          sub:
            action.invariants.length > 0
              ? `${action.invariants.length} guard(s)`
              : undefined,
          line: action.line,
        });
        aPos.set(action.name, ap);
        let evtX = cx + W + GAP;

        for (const en of action.emits) {
          if (!ePos.has(en)) {
            const ep = { x: evtX, y };
            ns.push({
              key: `e:${en}`,
              pos: ep,
              type: "event",
              label: en,
              line: eDefs.find((e) => e.name === en)?.line,
            });
            ePos.set(en, ep);
            es.push({
              from: { x: ap.x + W, y: ap.y + H / 2 },
              to: { x: ep.x, y: ep.y + H / 2 },
              color: COLORS.action.border,
            });
            evtX += W + GAP;
          }
        }
        sliceRightX = Math.max(sliceRightX, evtX);
        y += H + GAP / 2;
      }

      // Reactions after all actions
      for (const r of slice.reactions) {
        if (r.isVoid) continue;
        const reactX =
          Math.max(
            sliceRightX,
            ...ns.filter((n) => n.pos.x >= sx).map((n) => n.pos.x + W)
          ) + GAP;
        const ep = ePos.get(r.event);
        const rp = { x: reactX, y: ep ? ep.y : y };
        ns.push({
          key: `r:${r.handlerName}`,
          pos: rp,
          type: "reaction",
          label: r.handlerName,
          line: r.line,
        });

        if (ep)
          es.push({
            from: { x: ep.x + W, y: ep.y + H / 2 },
            to: { x: rp.x, y: rp.y + H / 2 },
            color: COLORS.reaction.border,
            dash: true,
          });

        for (const an of r.dispatches) {
          const ap2 = aPos.get(an);
          if (ap2) {
            es.push({
              from: { x: rp.x + W, y: rp.y + H / 2 },
              to: { x: ap2.x + W * 0.3, y: ap2.y },
              color: COLORS.reaction.border,
              dash: true,
              label: an,
            });
          }
        }
        y = Math.max(y, rp.y + H + GAP / 2);
      }

      maxY = Math.max(maxY, y);

      // Slice boundary box
      let bx2 = cx;
      for (const n of ns) {
        if (n.pos.x >= sx && n.pos.x + W > bx2) bx2 = n.pos.x + W;
      }
      boxes.push({
        label: `${slice.name.replace(/Slice$/i, "")} (${stateName})`,
        x: sx - 4,
        y: PAD - 4,
        w: bx2 - sx + 8,
        h: maxY - PAD + 8,
      });

      cx = bx2 + GAP * 2;
    }

    // Standalone states
    const claimed = new Set(model.slices.flatMap((sl) => sl.stateVars));
    for (const st of model.states.filter((s) => !claimed.has(s.varName))) {
      let y = PAD;
      for (const action of st.actions) {
        const ap = { x: cx, y };
        ns.push({
          key: `a:${action.name}`,
          pos: ap,
          type: "action",
          label: action.name,
          sub:
            action.invariants.length > 0
              ? `${action.invariants.length} guard(s)`
              : undefined,
          line: action.line,
        });
        aPos.set(action.name, ap);
        let endX = cx + W + GAP;
        for (const en of action.emits) {
          if (!ePos.has(en)) {
            const ep = { x: endX, y };
            ns.push({
              key: `e:${en}`,
              pos: ep,
              type: "event",
              label: en,
              line: st.events.find((e) => e.name === en)?.line,
            });
            ePos.set(en, ep);
            es.push({
              from: { x: ap.x + W, y: ap.y + H / 2 },
              to: { x: ep.x, y: ep.y + H / 2 },
              color: COLORS.action.border,
            });
            endX += W + GAP;
          }
        }
        cx = Math.max(cx, endX);
        y += H + GAP / 2;
      }
      maxY = Math.max(maxY, y);
      cx += GAP * 2;
    }

    // Projections — one node per projection, connect to all handled events
    const py = maxY + GAP * 2;
    let px = PAD;
    for (const proj of model.projections) {
      const pp = { x: px, y: py };
      ns.push({
        key: `p:${proj.name}`,
        pos: pp,
        type: "projection",
        label: proj.name,
        line: proj.line,
      });
      for (const en of proj.handles) {
        const ep2 = ePos.get(en);
        if (ep2)
          es.push({
            from: { x: ep2.x + W / 2, y: ep2.y + H },
            to: { x: pp.x + W / 2, y: pp.y },
            color: COLORS.projection.border,
            dash: true,
          });
      }
      px += W + GAP;
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

          {/* Edges */}
          {es.map((e, i) => {
            const dx = e.to.x - e.from.x;
            const dy = e.to.y - e.from.y;
            const straight = Math.abs(dy) < 5 && dx > 0;
            const back = dx < -20;
            let d: string;
            if (straight) d = `M ${e.from.x} ${e.from.y} L ${e.to.x} ${e.to.y}`;
            else if (back) {
              const my = Math.min(e.from.y, e.to.y) - 25;
              d = `M ${e.from.x} ${e.from.y} C ${e.from.x + 30} ${my}, ${e.to.x - 30} ${my}, ${e.to.x} ${e.to.y}`;
            } else
              d = `M ${e.from.x} ${e.from.y} C ${e.from.x + dx * 0.4} ${e.from.y}, ${e.to.x - dx * 0.4} ${e.to.y}, ${e.to.x} ${e.to.y}`;
            return (
              <g key={i}>
                <path
                  d={d}
                  fill="none"
                  stroke={e.color}
                  strokeWidth={1.5}
                  strokeDasharray={e.dash ? "4,3" : undefined}
                  opacity={0.7}
                  markerEnd="url(#arr)"
                />
                {e.label && (
                  <text
                    x={(e.from.x + e.to.x) / 2}
                    y={Math.min(e.from.y, e.to.y) - 6}
                    textAnchor="middle"
                    fill="#a1a1aa"
                    className="text-[7px]"
                  >
                    {e.label}
                  </text>
                )}
              </g>
            );
          })}
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
            const w = warn.has(n.label);
            return (
              <g
                key={n.key}
                className="cursor-pointer"
                onClick={() => n.line && onClickLine?.(n.line)}
                onMouseEnter={(ev) =>
                  setTip({
                    x: ev.clientX,
                    y: ev.clientY,
                    t: `${n.type}: ${n.label}${n.sub ? ` (${n.sub})` : ""}`,
                  })
                }
                onMouseLeave={() => setTip(null)}
              >
                <rect
                  x={n.pos.x}
                  y={n.pos.y}
                  width={W}
                  height={H}
                  rx={4}
                  fill={c.bg}
                  stroke={w ? "#ef4444" : c.border}
                  strokeWidth={w ? 2 : 1.5}
                />
                {(() => {
                  const lines = splitLabel(n.label);
                  const lineH = 11;
                  const startY = n.sub
                    ? n.pos.y + 6
                    : n.pos.y + H / 2 - ((lines.length - 1) * lineH) / 2;
                  return lines.map((line, li) => (
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
                  ));
                })()}
                {n.sub && (
                  <text
                    x={n.pos.x + W / 2}
                    y={n.pos.y + H - 5}
                    textAnchor="middle"
                    fill="#a1a1aa"
                    className="text-[7px]"
                  >
                    {n.sub}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      {tip && (
        <div
          className="pointer-events-none fixed z-50 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[10px] text-zinc-300 shadow-xl"
          style={{ left: tip.x + 12, top: tip.y - 10 }}
        >
          {tip.t}
        </div>
      )}
    </div>
  );
}
