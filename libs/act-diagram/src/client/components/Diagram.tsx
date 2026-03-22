import {
  AlertTriangle,
  ListTree,
  Maximize2,
  Sparkles,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DomainModel,
  EntryPoint,
  ValidationWarning,
} from "../types/index.js";

import {
  computeLayout,
  H,
  SLICE_PAD,
  STATE_H,
  STATE_W,
  W,
} from "../lib/layout.js";

const COLORS = {
  action: { bg: "#1e40af", border: "#3b82f6", text: "#93c5fd" },
  event: { bg: "#c2410c", border: "#f97316", text: "#fed7aa" },
  state: { bg: "#a16207", border: "#eab308", text: "#fef08a" },
  reaction: { bg: "#7e22ce", border: "#a855f7", text: "#d8b4fe" },
  projection: { bg: "#059669", border: "#34d399", text: "#6ff7b5" },
  error: { bg: "#991b1b", border: "#ef4444", text: "#fca5a5" },
};

/** Semi-transparent version of a hex color for box fills */
const alpha = (hex: string, a: number) => {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
};

const STATE_FONT = 10;

function splitLabel(label: string, maxChars = 16): string[] {
  const words = label.replace(/([a-z])([A-Z])/g, "$1 $2").split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur && (cur + " " + w).length > maxChars) {
      lines.push(cur);
      cur = w;
    } else cur = cur ? cur + " " + w : w;
  }
  if (cur) lines.push(cur);
  return lines.length > 0 ? lines : [label];
}

function formatModelTree(model: DomainModel): string {
  const lines: string[] = [];
  for (const entry of model.entries) {
    for (const sl of entry.slices) {
      lines.push(`Slice: ${sl.name}`);
      for (const stKey of sl.stateVars) {
        const st = entry.states.find((s) => s.varName === stKey);
        if (!st) continue;
        lines.push(`  State: ${st.name}`);
        for (const a of st.actions) {
          let line = `    ${a.name} → [${a.emits.join(", ")}]`;
          if (a.invariants.length)
            line += ` guards: [${a.invariants.join(", ")}]`;
          lines.push(line);
        }
      }
      for (const r of sl.reactions) {
        lines.push(
          `  ⚡ ${r.handlerName} on ${r.event} → [${r.dispatches.join(", ") || "—"}]`
        );
      }
    }
    for (const p of entry.projections) {
      lines.push(`Projection: ${p.name} [${p.handles.join(", ")}]`);
    }
    const sliceStateKeys = new Set(entry.slices.flatMap((sl) => sl.stateVars));
    for (const st of entry.states.filter(
      (s) => !sliceStateKeys.has(s.varName)
    )) {
      lines.push(`State: ${st.name}`);
      for (const a of st.actions) {
        lines.push(`  ${a.name} → [${a.emits.join(", ")}]`);
      }
    }
    for (const r of entry.reactions) {
      lines.push(
        `⚡ ${r.handlerName} on ${r.event} → [${r.dispatches.join(", ") || "—"}]`
      );
    }
  }
  return lines.join("\n");
}

type Props = {
  model: DomainModel;
  warnings: ValidationWarning[];
  onClickElement?: (name: string, type?: string, file?: string) => void;
  onFixWithAi?: (prompt: string) => void;
  toolbarExtra?: React.ReactNode;
};

export function Diagram({
  model,
  warnings,
  onClickElement,
  onFixWithAi,
  toolbarExtra,
}: Props) {
  const [tip, setTip] = useState<{ x: number; y: number; t: string } | null>(
    null
  );
  const [activeTab, setActiveTab] = useState(0);
  const [showTree, setShowTree] = useState(false);
  const [showWarnings, setShowWarnings] = useState(false);
  const warnSet = new Set(warnings.map((w) => w.element).filter(Boolean));
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);

  // Use the selected entry point's data, or fall back to flat model
  const entry: EntryPoint | undefined = model.entries[activeTab];
  const viewModel: DomainModel = entry
    ? {
        ...model,
        entries: [entry],
        states: entry.states,
        slices: entry.slices,
        projections: entry.projections,
        reactions: entry.reactions,
      }
    : model;

  // Reset tab when model changes
  useEffect(() => {
    if (activeTab >= model.entries.length) setActiveTab(0);
  }, [model.entries.length, activeTab]);
  const drag = useRef(false);
  const start = useRef({ x: 0, y: 0, px: 0, py: 0 });

  const svgContainerRef = useRef<HTMLDivElement>(null);
  const panRafRef = useRef(0);
  const pendingPanRef = useRef<{ x: number; y: number } | null>(null);
  const zoomRafRef = useRef(0);
  const pendingZoomRef = useRef<number | null>(null);

  // Clean up RAF handles on unmount
  useEffect(() => {
    return () => {
      if (panRafRef.current) cancelAnimationFrame(panRafRef.current);
      if (zoomRafRef.current) cancelAnimationFrame(zoomRafRef.current);
    };
  }, []);

  useEffect(() => {
    const el = svgContainerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      // Store the pending zoom factor and schedule a single RAF flush
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      if (pendingZoomRef.current !== null) {
        pendingZoomRef.current *= factor;
      } else {
        pendingZoomRef.current = factor;
      }
      if (!zoomRafRef.current) {
        zoomRafRef.current = requestAnimationFrame(() => {
          zoomRafRef.current = 0;
          const f = pendingZoomRef.current;
          pendingZoomRef.current = null;
          if (f !== null) {
            setZoom((z) => Math.max(0.2, Math.min(3, z * f)));
          }
        });
      }
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [model]);
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
    pendingPanRef.current = {
      x: start.current.px + (e.clientX - start.current.x),
      y: start.current.py + (e.clientY - start.current.y),
    };
    if (!panRafRef.current) {
      panRafRef.current = requestAnimationFrame(() => {
        panRafRef.current = 0;
        if (pendingPanRef.current !== null) {
          setPan(pendingPanRef.current);
          pendingPanRef.current = null;
        }
      });
    }
  }, []);
  const onUp = useCallback(() => {
    drag.current = false;
  }, []);
  const { ns, es, boxes, minX, minY, width, height } = useMemo(
    () => computeLayout(viewModel),
    [viewModel]
  );

  /** Compute the zoom + pan that fits the diagram in the container */
  const fitTransform = useCallback(() => {
    const el = svgContainerRef.current;
    const cw = el?.clientWidth || 800;
    const ch = el?.clientHeight || 600;
    // Avoid division by zero for empty diagrams
    const dw = Math.max(width, 1);
    const dh = Math.max(height, 1);
    const fitZoom = Math.min(cw / dw, ch / dh);
    const z = Math.max(0.1, Math.min(3, fitZoom));
    // Center the content in the container
    const px = (cw - dw * z) / 2 - minX * z;
    const py = (ch - dh * z) / 2 - minY * z;
    return { z, px, py };
  }, [width, height, minX, minY]);

  const reset = useCallback(() => {
    const { z, px, py } = fitTransform();
    setZoom(z);
    setPan({ x: px, y: py });
  }, [fitTransform]);

  // Auto-fit when viewModel changes (new tab, new model)
  useEffect(() => {
    // Delay one frame so container has been laid out
    const id = requestAnimationFrame(() => reset());
    return () => cancelAnimationFrame(id);
  }, [reset]);

  if (viewModel.states.length === 0 && viewModel.projections.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-zinc-600">
        Nothing to diagram here
      </div>
    );
  }

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
        <div className="h-4 w-px bg-zinc-800" />
        <button
          onClick={() => setShowTree((v) => !v)}
          className={`rounded p-1 transition ${showTree ? "bg-zinc-700 text-cyan-400" : "text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"}`}
          title="Model tree"
        >
          <ListTree size={13} />
        </button>

        {/* Right side */}
        <div className="ml-auto flex items-center gap-1.5">
          {warnings.length > 0 && (
            <button
              onClick={() => setShowWarnings((v) => !v)}
              className={`flex items-center gap-1 rounded p-1 text-[10px] transition ${showWarnings ? "bg-amber-900/40 text-amber-300" : "text-amber-400 hover:bg-zinc-800"}`}
              title="Toggle warnings"
            >
              <AlertTriangle size={11} />
              {warnings.length}
            </button>
          )}
          {toolbarExtra}
        </div>
      </div>

      {model.entries.length > 1 && (
        <div className="flex gap-px border-b border-zinc-800 bg-zinc-900">
          {model.entries.map((e, i) => (
            <button
              key={e.path}
              onClick={() => {
                setActiveTab(i);
                onClickElement?.(e.path, "file");
              }}
              className={`px-3 py-1 text-[10px] transition ${
                i === activeTab
                  ? "border-b-2 border-cyan-500 bg-zinc-950 text-cyan-400"
                  : "text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
              }`}
            >
              {e.path}
            </button>
          ))}
        </div>
      )}

      {showTree && (
        <div className="flex max-h-[40%] flex-col border-b border-zinc-800 bg-zinc-950">
          <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900 px-3 py-1">
            <span className="text-[10px] font-medium text-zinc-400">
              Model Tree
            </span>
            <button
              onClick={() => setShowTree(false)}
              className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
            >
              <X size={12} />
            </button>
          </div>
          <pre className="flex-1 overflow-auto whitespace-pre px-3 py-2 font-mono text-[10px] leading-relaxed text-zinc-400 select-all">
            {formatModelTree(viewModel)}
          </pre>
        </div>
      )}

      {showWarnings && warnings.length > 0 && (
        <div className="flex max-h-[30%] flex-col border-b border-zinc-800 bg-zinc-950">
          <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900 px-3 py-1">
            <span className="text-[10px] font-medium text-amber-400">
              Warnings ({warnings.length})
            </span>
            <div className="flex items-center gap-1">
              {onFixWithAi && (
                <button
                  onClick={() => {
                    const prompt = warnings
                      .map((w) => `- ${w.message}`)
                      .join("\n");
                    onFixWithAi(`Fix these issues:\n${prompt}`);
                    setShowWarnings(false);
                  }}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] text-purple-400 hover:bg-zinc-800"
                  title="Fix all with AI"
                >
                  <Sparkles size={10} />
                  Fix all
                </button>
              )}
              <button
                onClick={() => setShowWarnings(false)}
                className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
              >
                <X size={12} />
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-auto px-3 py-2">
            {warnings.map((w, i) => (
              <div
                key={i}
                className="flex items-start gap-2 py-0.5 text-[10px]"
              >
                <span
                  className={
                    w.severity === "error" ? "text-red-400" : "text-amber-400"
                  }
                >
                  {w.severity === "error" ? "●" : "▲"}
                </span>
                <span className="text-zinc-300">{w.message}</span>
                <div className="ml-auto flex shrink-0 items-center gap-1">
                  {onFixWithAi && (
                    <button
                      onClick={() => {
                        onFixWithAi(`Fix: ${w.message}`);
                        setShowWarnings(false);
                      }}
                      className="text-purple-500 hover:text-purple-300"
                      title="Fix with AI"
                    >
                      <Sparkles size={10} />
                    </button>
                  )}
                  {w.element && (
                    <button
                      onClick={() => onClickElement?.(w.element!)}
                      className="text-zinc-500 hover:text-zinc-300"
                    >
                      {w.element}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div
        ref={svgContainerRef}
        className={`flex-1 overflow-hidden ${drag.current ? "cursor-grabbing" : "cursor-grab"}`}
        onMouseDown={onDown}
        onMouseMove={onMove}
        onMouseUp={onUp}
        onMouseLeave={onUp}
      >
        <svg width="100%" height="100%" className="select-none">
          <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
            {/* Slice boundaries */}
            {boxes.map((b) => {
              const isError = !!b.error;
              const boxColor = isError ? COLORS.error : COLORS.state;
              const stripFill = isError ? COLORS.error.bg : "#a16207";
              return (
                <g key={b.label}>
                  <rect
                    x={b.x}
                    y={b.y}
                    width={b.w}
                    height={b.h}
                    rx={8}
                    fill={boxColor.bg}
                    fillOpacity={0.1}
                    stroke={boxColor.border}
                    strokeWidth={1.5}
                    strokeOpacity={isError ? 0.7 : 0.4}
                  />
                  {/* Vertical label strip on left — rounded left, flat right */}
                  <clipPath id={`clip-${b.label}`}>
                    <rect x={b.x} y={b.y} width={SLICE_PAD} height={b.h} />
                  </clipPath>
                  <rect
                    x={b.x}
                    y={b.y}
                    width={SLICE_PAD + 8}
                    height={b.h}
                    rx={8}
                    fill={stripFill}
                    fillOpacity={0.25}
                    clipPath={`url(#clip-${b.label})`}
                  />
                  {/* Vertical text — clickable to navigate to slice definition */}
                  <text
                    x={b.x + SLICE_PAD / 2}
                    y={b.y + b.h / 2}
                    fill={isError ? COLORS.error.text : COLORS.state.text}
                    className="cursor-pointer text-[10px] font-semibold hover:opacity-80"
                    textAnchor="middle"
                    dominantBaseline="central"
                    transform={`rotate(-90, ${b.x + SLICE_PAD / 2}, ${b.y + b.h / 2})`}
                    onClick={() => onClickElement?.(b.label)}
                  >
                    {b.label}
                  </text>
                  {/* Error message inside the slice box */}
                  {isError && (
                    <text
                      x={b.x + SLICE_PAD + 12}
                      y={b.y + b.h / 2}
                      fill={COLORS.error.text}
                      className="text-[9px]"
                      dominantBaseline="central"
                    >
                      {b.error}
                    </text>
                  )}
                </g>
              );
            })}

            {/* Edges */}
            {es.map((e, i) => {
              const dx = e.to.x - e.from.x;
              const isHint = !e.dash;
              const d = `M ${e.from.x} ${e.from.y} C ${e.from.x + dx * 0.4} ${e.from.y}, ${e.to.x - dx * 0.4} ${e.to.y}, ${e.to.x} ${e.to.y}`;
              return (
                <path
                  key={i}
                  d={d}
                  fill="none"
                  stroke={e.color}
                  strokeWidth={isHint ? 0.75 : 1.5}
                  strokeDasharray={e.dash ? "4,3" : undefined}
                  opacity={isHint ? 0.35 : 0.7}
                  markerEnd="url(#arr)"
                />
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
                <path
                  d="M 0 1 L 8 5 L 0 9"
                  fill="none"
                  stroke="#71717a"
                  strokeWidth="1.5"
                />
              </marker>
            </defs>

            {/* Nodes */}
            {ns.map((n, ni) => {
              const c = COLORS[n.type];
              const hasWarn = warnSet.has(n.label);
              const isState = n.type === "state";
              const nw = isState ? STATE_W : W;
              const nh = isState ? STATE_H : H;
              const lines = splitLabel(n.label, isState ? 10 : 16);
              const lineH = isState ? STATE_FONT + 2 : 11;
              const startY =
                n.pos.y + nh / 2 - ((lines.length - 1) * lineH) / 2;

              return (
                <g
                  key={`${n.key}:${ni}`}
                  className="cursor-pointer"
                  onClick={() => onClickElement?.(n.label, n.type, n.file)}
                  onMouseEnter={(ev) => {
                    const parts = [n.label];
                    if (n.guards?.length)
                      parts.push(`Guards: ${n.guards.join(", ")}`);
                    if (n.reactions?.length)
                      parts.push(`Reactions: ${n.reactions.join(", ")}`);
                    if (n.projections?.length)
                      parts.push(`Projections: ${n.projections.join(", ")}`);
                    setTip({
                      x: ev.clientX,
                      y: ev.clientY,
                      t: parts.join("\n"),
                    });
                  }}
                  onMouseLeave={() => setTip(null)}
                >
                  <rect
                    x={n.pos.x}
                    y={n.pos.y}
                    width={nw}
                    height={nh}
                    rx={isState ? 6 : 4}
                    fill={alpha(c.bg, 0.75)}
                    stroke={hasWarn ? "#ef4444" : c.border}
                    strokeWidth={hasWarn ? 2 : 1.5}
                  />
                  {lines.map((line, li) => (
                    <text
                      key={li}
                      x={n.pos.x + nw / 2}
                      y={startY + li * lineH}
                      textAnchor="middle"
                      dominantBaseline="central"
                      fill={c.text}
                      className={
                        isState
                          ? "text-[10px] font-semibold"
                          : "text-[8px] font-medium"
                      }
                    >
                      {line}
                    </text>
                  ))}
                  {/* Top-right icons */}
                  {(() => {
                    let ix = n.pos.x + nw - 13;
                    const icons: React.ReactNode[] = [];
                    if (n.guards?.length) {
                      icons.unshift(
                        <g
                          key="g"
                          transform={`translate(${ix - 2},${n.pos.y})`}
                          className="cursor-pointer"
                          pointerEvents="all"
                          onClick={(e) => {
                            e.stopPropagation();
                            onClickElement?.(n.guards![0], "guard");
                          }}
                          onMouseEnter={(ev) => {
                            ev.stopPropagation();
                            setTip({
                              x: ev.clientX,
                              y: ev.clientY,
                              t: `Guards: ${n.guards!.join(", ")}`,
                            });
                          }}
                          onMouseLeave={(ev) => {
                            ev.stopPropagation();
                            setTip(null);
                          }}
                        >
                          <rect
                            x="-1"
                            y="-1"
                            width="14"
                            height="14"
                            fill="transparent"
                          />
                          <path
                            d="M5 3L1 5v3c0 2.5 1.7 4.8 4 5.5 2.3-.7 4-3 4-5.5V5L5 3z"
                            fill="none"
                            stroke="#ef4444"
                            strokeWidth="1.2"
                          />
                        </g>
                      );
                      ix -= 14;
                    }
                    if (n.projections?.length) {
                      icons.unshift(
                        <g
                          key="p"
                          transform={`translate(${ix - 2},${n.pos.y})`}
                          className="cursor-pointer"
                          pointerEvents="all"
                          onClick={(e) => {
                            e.stopPropagation();
                            onClickElement?.(n.projections![0], "projection");
                          }}
                          onMouseEnter={(ev) => {
                            ev.stopPropagation();
                            setTip({
                              x: ev.clientX,
                              y: ev.clientY,
                              t: `Projection: ${n.projections!.join(", ")}`,
                            });
                          }}
                          onMouseLeave={(ev) => {
                            ev.stopPropagation();
                            setTip(null);
                          }}
                        >
                          {/* Invisible hit area */}
                          <rect
                            x="-1"
                            y="-1"
                            width="14"
                            height="14"
                            fill="transparent"
                          />
                          <rect
                            x="1"
                            y="3"
                            width="8"
                            height="6"
                            rx="1"
                            fill="none"
                            stroke={COLORS.projection.text}
                            strokeWidth="1"
                          />
                          <line
                            x1="3"
                            y1="9"
                            x2="7"
                            y2="9"
                            stroke={COLORS.projection.text}
                            strokeWidth="1"
                          />
                          <line
                            x1="5"
                            y1="9"
                            x2="5"
                            y2="11"
                            stroke={COLORS.projection.text}
                            strokeWidth="1"
                          />
                        </g>
                      );
                      ix -= 14;
                    }
                    if (n.reactions?.length) {
                      icons.unshift(
                        <g
                          key="r"
                          transform={`translate(${ix - 2},${n.pos.y})`}
                          className="cursor-pointer"
                          pointerEvents="all"
                          onClick={(e) => {
                            e.stopPropagation();
                            onClickElement?.(n.reactions![0], "reaction");
                          }}
                          onMouseEnter={(ev) => {
                            ev.stopPropagation();
                            setTip({
                              x: ev.clientX,
                              y: ev.clientY,
                              t: `Reactions: ${n.reactions!.join(", ")}`,
                            });
                          }}
                          onMouseLeave={(ev) => {
                            ev.stopPropagation();
                            setTip(null);
                          }}
                        >
                          <rect
                            x="-1"
                            y="-1"
                            width="14"
                            height="14"
                            fill="transparent"
                          />
                          <path
                            d="M6 2L2 7h3L4 12L8 7H5L6 2z"
                            fill={COLORS.reaction.text}
                          />
                        </g>
                      );
                    }
                    return icons;
                  })()}
                </g>
              );
            })}
          </g>
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
