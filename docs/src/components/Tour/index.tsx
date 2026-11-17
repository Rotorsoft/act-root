/**
 * The framework tour player. It plays a TourSpec: chapters of scenes of steps.
 * The stage has three regions: the callers (and the read models the app
 * writes) on the left, the running Act app in the middle, built from the
 * chapter's declared anatomy, and the event store on the right, both as a
 * field of dots at scale and as detailed cells, with every subscription on a
 * shared id axis. Every token routes through the app: in at `app.do`, through
 * the action layer, out through the store port.
 *
 * Generic on purpose: everything about a domain lives in the spec. Colors come
 * from the `--dg-*` tokens in src/css/custom.css. The server renders the
 * first step; motion is skipped for readers who prefer less.
 */
import Link from "@docusaurus/Link";
import CodeBlock from "@theme/CodeBlock";
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Field from "./Field";
import { type Box, type Chip, data_lines, type Layout, layout, type Mode, SUB_COLS, short, type View } from "./layout";
import styles from "./styles.module.css";
import type { AppSpec, Link as DocLink, Move, Step, TourSpec } from "./types";
import { type Cell, census, type Frame, type Frames, fill, fmt, frames as fold, type Target, type World } from "./world";

export type { TourSpec } from "./types";

const MOVE_MS = 820;

// the stage names a narrow pill shows; the full name is its title
const SHORT: Record<string, string> = { preconditions: "rules", "state check": "check" };
const LAND_MS = 900;
const PALETTE = 8;

const useBrowserLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** `code` and **bold** in narration. */
function rich(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/).map((part, i) => {
    if (part.startsWith("`")) return <code key={i}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**")) return <b key={i}>{part.slice(2, -2)}</b>;
    return part;
  });
}

function schedule(moves: Move[]): { starts: number[]; total: number } {
  const starts: number[] = [];
  let cursor = 0;
  let last = 0;
  moves.forEach((m, i) => {
    const start = m.par && i > 0 ? starts[i - 1]! : cursor;
    starts.push(start);
    cursor = start + MOVE_MS;
    last = Math.max(last, cursor);
  });
  return { starts, total: last };
}

// the token travels, the change lands and pulses, then the step holds to be read
const dwell = (now: string, say: string, total: number) =>
  total + LAND_MS + Math.max(2800, Math.min(8000, (say.length + now.length) * 38));

type Fit = { mode: Mode; px: number };
function useFit(ref: React.RefObject<HTMLElement | null>): Fit {
  const [fit, setFit] = useState<Fit>({ mode: "wide", px: 1280 });
  useBrowserLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setFit({ mode: el.clientWidth < 760 ? "narrow" : "wide", px: el.clientWidth });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return fit;
}

/** The token's path, sampled with soft bows so it reads as one route. */
function path_frames(points: { x: number; y: number }[]): Keyframe[] {
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    for (let k = 0; k < 10; k++) {
      const t = k / 10;
      const bow = Math.min(26, len * 0.1) * Math.sin(Math.PI * t);
      pts.push({ x: a.x + (b.x - a.x) * t - ((b.y - a.y) / len) * bow, y: a.y + (b.y - a.y) * t + ((b.x - a.x) / len) * bow });
    }
  }
  pts.push(points[points.length - 1]!);
  return pts.map((p, i) => ({
    transform: `translate(${p.x}px, ${p.y}px)`,
    opacity: i === 0 ? 0 : i === pts.length - 1 ? 0.15 : 1,
  }));
}

function Tokens({ moves, lay, run, reduce }: { moves: Move[]; lay: Layout; run: number; reduce: boolean }) {
  const refs = useRef<(SVGGElement | null)[]>([]);
  useEffect(() => {
    if (reduce) return;
    const { starts } = schedule(moves);
    const anims: Animation[] = [];
    moves.forEach((m, i) => {
      const el = refs.current[i];
      const pts = lay.route(m.from, m.to);
      if (!el || pts.length < 2) return;
      anims.push(el.animate(path_frames(pts), { duration: MOVE_MS, delay: starts[i], easing: "cubic-bezier(.45,.05,.35,1)", fill: "both" }));
    });
    return () => anims.forEach((x) => x.cancel());
  }, [run, moves, lay, reduce]);
  if (reduce) return null;
  return (
    <g className={styles.tokens} aria-hidden>
      {moves.map((m, i) => (
        <g
          key={`${run}-${i}`}
          ref={(el) => {
            refs.current[i] = el;
          }}
          className={styles.token}
          data-tone={m.tone}
          style={{ opacity: 0 }}
        >
          <circle r={7} />
          {m.label && (
            <text x={11} y={4}>
              {m.label}
            </text>
          )}
        </g>
      ))}
    </g>
  );
}

const trim = (text: string, max: number) => (text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text);

function stream_colors(all: Frame[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const f of all)
    for (const s of f.world.stores) for (const c of s.cells) if (!map.has(c.stream)) map.set(c.stream, map.size % PALETTE);
  return map;
}

/** What a `</>` icon opens: the code behind an element, and where to read more. */
type TipContent = { title: string; code?: string; api?: string[]; doc?: DocLink; test?: DocLink };
type OpenTip = TipContent & { key: string; x: number; y: number };
type TipFn = (id: string, el: Element | undefined, c: TipContent | undefined) => void;

/** A `</>` icon drawn inside the SVG. */
function SvgTip({ x, y, id, content, open }: { x: number; y: number; id: string; content: TipContent; open: TipFn }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: an SVG icon cannot be a <button>
    <g
      className={styles.tipIcon}
      transform={`translate(${x}, ${y})`}
      role="button"
      tabIndex={0}
      aria-label={`How ${content.title} is coded`}
      onMouseEnter={(e) => open(id, e.currentTarget, content)}
      onMouseLeave={() => open(id, undefined, undefined)}
      onFocus={(e) => open(id, e.currentTarget, content)}
      onBlur={() => open(id, undefined, undefined)}
      onClick={(e) => open(id, e.currentTarget, content)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") open(id, e.currentTarget, content);
      }}
    >
      <circle r={7} />
      <text y={3}>{"</>"}</text>
    </g>
  );
}

function CellView({
  cell,
  box,
  color,
  flag,
  dim,
  off,
  selected,
  onSelect,
}: {
  cell: Cell;
  box: Box;
  color: number;
  flag?: { text: string; tone?: string };
  dim: boolean;
  off: boolean;
  selected: boolean;
  onSelect: (uid: number) => void;
}) {
  const state = cell.leaving ? styles.leaving : cell.fresh ? styles.fresh : cell.moved ? styles.moved : "";
  const label = cell.kind === "event" ? cell.name : cell.kind === "snapshot" ? "◆ snapshot" : "⊘ tombstone";
  return (
    <g className={styles.cellPos} style={{ transform: `translate(${box.x}px, ${box.y}px)` }}>
      {/* biome-ignore lint/a11y/useSemanticElements: an SVG cell cannot be a <button> */}
      <g
        className={`${styles.cell} ${state} ${dim ? styles.dim : ""} ${selected ? styles.selected : ""} ${off ? styles.off : ""}`}
        data-kind={cell.kind}
        data-color={color}
        role="button"
        tabIndex={0}
        aria-label={`event #${cell.id}, ${cell.name} on ${cell.stream} version ${cell.version}`}
        onClick={() => onSelect(cell.uid)}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSelect(cell.uid)}
      >
        <rect width={box.w} height={box.h} rx={7} />
        <rect className={styles.stripe} width={5} height={box.h} rx={2} />
        <text x={11} y={14} className={styles.cellId}>
          #{cell.id}
        </text>
        <text x={box.w - 6} y={14} className={styles.cellVer}>
          v{cell.version}
        </text>
        <text x={11} y={30} className={styles.cellName}>
          {trim(label, 12)}
        </text>
        <text x={11} y={44} className={styles.cellStream}>
          {trim(cell.stream, 14)}
        </text>
        {cell.pii && (
          <text x={box.w - 6} y={44} className={`${styles.pii} ${cell.shredded ? styles.shredded : ""}`}>
            {cell.shredded ? "pii ✕" : "pii 🔒"}
          </text>
        )}
      </g>
      {flag && (
        <g className={styles.flag} data-tone={flag.tone}>
          <rect x={-2} y={-15} width={Math.min(box.w + 60, flag.text.length * 6.2 + 12)} height={15} rx={7} />
          <text x={4} y={-4}>
            {flag.text}
          </text>
        </g>
      )}
    </g>
  );
}

/** A subscription's status, one color each. */
function status_of(t: Target, w: World) {
  const id = (uid: number | undefined) =>
    uid === undefined || uid < 0 ? -1 : (w.stores.flatMap((s) => s.cells).find((c) => c.uid === uid)?.id ?? -1);
  const at = id(t.at);
  const mark = id(t.mark);
  if (t.blocked) return { key: "blocked", label: `blocked · ${t.blocked}`, at, mark };
  if (t.due && t.retry) return { key: "retry", label: `retry ${t.retry} · ${t.due}`, at, mark };
  if (t.due) return { key: "due", label: `deferred · ${t.due}`, at, mark };
  if (t.lease) return { key: "leased", label: `leased · ${t.lease}`, at, mark };
  if (mark > at) return { key: "work", label: "has work", at, mark };
  return { key: "idle", label: "idle", at, mark };
}

type Lit = { nodes: Set<string>; cells: Set<number>; targets: Set<string>; streams: Set<string>; tables: Set<string> };

function Stage({
  lay,
  frame,
  base,
  colors,
  moves,
  run,
  reduce,
  enter,
  lit,
  step,
  pipelines,
  view,
  hover,
  setHover,
  selected,
  onSelect,
  tip,
}: {
  lay: Layout;
  frame: Frame;
  base: Frames["base"];
  colors: Map<string, number>;
  moves: Move[];
  run: number;
  reduce: boolean;
  enter: number;
  lit?: Lit;
  step: Step;
  pipelines: Record<string, string[]>;
  view: View;
  hover?: string;
  setHover: (s: string | undefined) => void;
  selected?: number;
  onSelect: (uid: number) => void;
  tip: TipFn;
}) {
  const w = frame.world;
  const [hoverRx, setHoverRx] = useState<string | undefined>();
  const off = (on: boolean) => (lit && !on ? styles.off : "");
  const lit_chip = new Set<string>();
  if (lit)
    for (const id of lit.nodes) {
      const c = lay.chip_of(id);
      if (c) lit_chip.add(`${c.kind}:${c.name}`);
    }
  for (const t of w.targets)
    if (lit?.targets.has(t.id) && t.reaction) {
      lit_chip.add(`reaction:${t.reaction}`);
      lit_chip.add(`projection:${t.reaction}`);
    }
  if (moves.some((m) => lay.route(m.from, m.to).length > 2)) lit_chip.add("op:app.do");
  const pipe = step.pipe && pipelines[step.pipe.name] ? step.pipe : undefined;
  const layer_state = (i: number) => {
    if (!pipe || pipe.name !== "action") return "idle";
    if (i < pipe.at) return "done";
    if (i === pipe.at) return pipe.fail ? "fail" : "active";
    return pipe.fail ? "skip" : "todo";
  };
  const commit_state = pipe?.name === "action" ? (pipe.at > 6 ? "done" : pipe.at === 6 ? (pipe.fail ? "fail" : "active") : "todo") : "idle";
  const a = lay.app;

  return (
    <svg
      viewBox={`0 0 ${lay.width} ${lay.height}`}
      className={styles.svg}
      style={{ "--enter": `${enter}ms` } as CSSProperties}
      role="img"
      aria-label="The stage: the callers, the running Act app, and the event store"
    >
      <defs>
        <marker id="tour-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0,0 L8,4 L0,8 z" className={styles.arrowHead} />
        </marker>
      </defs>
      {/* the callers */}
      {lay.mode === "wide" && lay.callers.length > 0 && (
        <text x={lay.callers[0]!.box.x} y={18} className={styles.bandLabel}>
          callers
        </text>
      )}
      {lay.callers.map(({ node, box }) => (
        <g
          key={node.id}
          className={`${styles.node} ${lit?.nodes.has(node.id) ? styles.focus : ""} ${off(!!lit?.nodes.has(node.id))}`}
          data-kind={node.kind}
        >
          <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={10} />
          <text x={box.x + box.w / 2} y={box.y + (node.sub ? 18 : 25)} className={styles.nodeLabel}>
            {trim(node.label, Math.floor(box.w / 7.6))}
          </text>
          {node.sub && (
            <text x={box.x + box.w / 2} y={box.y + 33} className={styles.nodeSub}>
              {trim(node.sub, Math.floor(box.w / 6.2))}
            </text>
          )}
        </g>
      ))}

      {/* the running Act app */}
      <g className={styles.app}>
        <rect x={a.box.x} y={a.box.y} width={a.box.w} height={a.box.h} rx={16} className={styles.appBox} />
        <text x={a.box.x + 12} y={a.box.y + 20} className={styles.appTitle}>
          Act app
        </text>
        <SvgTip x={a.box.x + 80} y={a.box.y + 15} id="app" content={{ title: "How the app is built", code: a.title }} open={tip} />

        {/* the action layer: one ordered pipe, then the commit port */}
        <rect x={a.layer_box.x} y={a.layer_box.y} width={a.layer_box.w} height={a.layer_box.h} rx={10} className={styles.layerBox} />
        <text x={a.layer_box.x + 8} y={a.layer_box.y + 14} className={styles.layerLabel}>
          action layer
          {lay.mode === "wide" && <tspan className={styles.appSub}> · every refusal but ConcurrencyError happens here</tspan>}
        </text>
        {a.layer.map(({ stage, box }, i) => {
          const next = a.layer[i + 1]?.box;
          return next ? (
            <line
              key={`pipe-${stage}`}
              className={styles.pipeLink}
              x1={a.vertical ? box.x + 14 : box.x + box.w}
              y1={a.vertical ? box.y + box.h : box.y + box.h / 2}
              x2={a.vertical ? next.x + 14 : next.x}
              y2={a.vertical ? next.y : next.y + next.h / 2}
              markerEnd="url(#tour-arrow)"
            />
          ) : (
            <line
              key="pipe-port"
              className={styles.pipeLink}
              x1={box.x + box.w}
              y1={box.y + box.h / 2}
              x2={a.port.x - 8}
              y2={a.port.y}
              markerEnd="url(#tour-arrow)"
            />
          );
        })}
        {a.layer.map(({ stage, box }, i) => {
          const stop = w.stop?.stage === stage;
          const state = stop ? "fail" : layer_state(i);
          return (
            <g key={stage} className={styles.stage} data-state={state}>
              <title>{stage}</title>
              <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={9} />
              <text x={box.x + box.w / 2} y={box.y + 13}>
                {state === "done" ? "✓ " : state === "fail" ? "✕ " : ""}
                {(stage.length + (state === "done" || state === "fail" ? 2 : 0)) * 5.9 > box.w - 8 ? (SHORT[stage] ?? stage) : stage}
              </text>
            </g>
          );
        })}
        {w.stop &&
          (() => {
            const s = a.layer.find((l) => l.stage === w.stop!.stage);
            if (!s) return null;
            const text = `${w.stop.error} · nothing sent to the store`;
            const tw = text.length * 5.9 + 16;
            const x = Math.min(s.box.x, a.layer_box.x + a.layer_box.w - tw);
            return (
              <g className={`${styles.stopNote} ${styles.fresh}`}>
                <rect x={x} y={a.layer_box.y + a.layer_box.h + 3} width={tw} height={16} rx={8} />
                <text x={x + 8} y={a.layer_box.y + a.layer_box.h + 14}>
                  {text}
                </text>
              </g>
            );
          })()}
        {/* the commit port: commits leave here, and only the version guard can turn one back */}
        <g className={styles.port} data-state={commit_state}>
          <circle cx={a.port.x} cy={a.port.y} r={7} />
          {!a.vertical && (
            <text x={a.port.x - 4} y={a.port.y - 12} className={`${styles.portLabel} ${styles.right}`}>
              commit
            </text>
          )}
        </g>

        {a.slices.map((s) => (
          <g key={s.name} className={styles.slice}>
            <rect x={s.box.x} y={s.box.y} width={s.box.w} height={s.box.h} rx={10} />
            <text x={s.box.x + 8} y={s.box.y + 14}>
              slice · {s.name}
            </text>
            {s.code && (
              <SvgTip x={s.box.x + s.box.w - 12} y={s.box.y + 10} id={`slice:${s.name}`} content={{ title: `slice ${s.name}`, code: s.code }} open={tip} />
            )}
          </g>
        ))}
        {a.links.map((l, i) => (
          <path
            key={`link-${i}`}
            className={styles.link}
            data-kind={l.kind}
            d={
              l.pts
                ? `M${l.pts.map((p) => `${p.x},${p.y}`).join(" L")}`
                : `M${l.a.x},${l.a.y} C${(l.a.x + l.b.x) / 2},${l.a.y} ${(l.a.x + l.b.x) / 2},${l.b.y} ${l.b.x - 2},${l.b.y}`
            }
            markerEnd="url(#tour-arrow)"
          />
        ))}
        {a.states.map((st) => {
          const on = lit_chip.has(`state:${st.name}`);
          const fresh = st.node ? w.states[st.node]?.fresh : false;
          return (
            <g key={`${st.name}-${st.box.y}`} className={`${styles.stateBox} ${on ? styles.focus : ""} ${fresh ? styles.fresh : ""} ${lit && !on ? styles.soft : ""}`}>
              <rect x={st.box.x} y={st.box.y} width={st.box.w} height={st.box.h} rx={8} />
              <text x={st.box.x + 8} y={st.box.y + 15} className={styles.cardTitle}>
                {st.title ?? st.name}
                {st.sub && <tspan className={styles.appSub}> {trim(st.sub, Math.max(4, Math.floor(st.box.w / 6.4) - st.name.length - 8))}</tspan>}
              </text>
              {st.version !== undefined && (
                <text x={st.box.x + st.box.w - (st.code ? 22 : 8)} y={st.box.y + 15} className={styles.stateVer}>
                  v{st.version}
                </text>
              )}
              {st.code && <SvgTip x={st.box.x + st.box.w - 10} y={st.box.y + 11} id={`state:${st.name}`} content={{ title: st.name, code: st.code }} open={tip} />}
              {st.lines.map((l, i) => (
                <text key={i} x={st.box.x + 8} y={st.box.y + 30 + i * 13} className={st.node ? styles.cardLine : styles.fieldLine}>
                  {trim(l, Math.floor((st.box.w - 14) / 6.1))}
                </text>
              ))}
            </g>
          );
        })}
        {a.chips.map((c: Chip) => {
          const key = `${c.kind}:${c.name}`;
          const on = lit_chip.has(key) || hoverRx === c.name;
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: hover links a reaction to its subscriptions
            <g
              key={`${key}-${c.box.x}-${c.box.y}`}
              className={`${styles.chip} ${on ? styles.focus : ""} ${lit && !on && c.kind !== "port" ? styles.soft : ""}`}
              data-kind={c.kind}
              onMouseEnter={() => (c.kind === "reaction" || c.kind === "projection") && setHoverRx(c.name)}
              onMouseLeave={() => setHoverRx(undefined)}
            >
              <rect x={c.box.x} y={c.box.y} width={c.box.w} height={c.box.h} rx={c.kind === "event" ? 4 : 9} />
              <text x={c.box.x + 7} y={c.box.y + 13}>
                {trim(c.label, Math.floor((c.box.w - (c.code ? 22 : 10)) / 6.3))}
              </text>
              {c.code && <SvgTip x={c.box.x + c.box.w - 10} y={c.box.y + c.box.h / 2} id={key} content={{ title: c.name, code: c.code }} open={tip} />}
            </g>
          );
        })}
        {a.cards.map(({ node, box, lines }) => {
          const st = w.states[node.id];
          const on = !!lit?.nodes.has(node.id);
          return (
            <g key={node.id} className={`${styles.stateCard} ${st?.fresh ? styles.fresh : ""} ${on ? styles.focus : ""} ${off(on)}`}>
              <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={8} />
              <text x={box.x + 8} y={box.y + 15} className={styles.cardTitle}>
                {trim(node.label, Math.floor(box.w / 7.2) - 6)}
                {node.sub && <tspan className={styles.appSub}> {trim(node.sub, Math.max(4, Math.floor(box.w / 6.6) - node.label.length - 6))}</tspan>}
              </text>
              {st?.version !== undefined && (
                <text x={box.x + box.w - 8} y={box.y + 15} className={styles.stateVer}>
                  v{st.version}
                </text>
              )}
              {lines.map((l, i) => (
                <text key={i} x={box.x + 8} y={box.y + 30 + i * 13} className={styles.cardLine}>
                  {trim(l, Math.floor((box.w - 14) / 6.1))}
                </text>
              ))}
            </g>
          );
        })}
      </g>

      {/* read models: the app's output for queries, outside the store */}
      {lay.tables.map(({ table, box }) => (
        <g key={table.name} className={`${styles.table} ${off(!!lit?.tables.has(table.name))}`}>
          <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={10} />
          <text x={box.x + 8} y={box.y + 17} className={styles.tableTitle}>
            {trim(table.title, Math.floor(box.w / 7) - 2)}
          </text>
          {table.rows.slice(0, 8).map(([key, values], i) => (
            <text key={key} x={box.x + 8} y={box.y + 38 + i * 18} className={table.fresh.includes(key) ? styles.rowFresh : ""}>
              <tspan className={styles.rowKey}>{trim(key, 12)}</tspan>
              <tspan dx={6}>{trim(data_lines(values, 3).join(" "), Math.floor(box.w / 6.4) - 14)}</tspan>
            </text>
          ))}
          {table.total !== undefined && (
            <text x={box.x + 8} y={box.y + 38 + Math.min(8, table.rows.length) * 18} className={styles.muted}>
              {fmt(table.total)} rows in all
            </text>
          )}
          {!table.rows.length && table.total === undefined && (
            <text x={box.x + 8} y={box.y + 38} className={styles.muted}>
              no rows
            </text>
          )}
        </g>
      ))}

      {/* the stores */}
      {lay.stores.map((sb) => {
        const s = sb.store;
        const n = census(s, base);
        const ax = (id: number) => sb.axis.x + ((id + 1) / (sb.axis.max + 1)) * sb.axis.w;
        const cp = Math.max(s.cells.find((c) => c.uid === s.checkpoint)?.id ?? -1, s.scan_at);
        return (
          <g key={s.name} className={styles.store} data-tone={s.status?.tone}>
            <rect x={sb.box.x} y={sb.box.y} width={sb.box.w} height={sb.box.h} rx={14} className={styles.storeBox} />
            <text x={sb.field.x} y={sb.box.y + 19} className={styles.storeTitle}>
              Event store
              <tspan className={styles.storeSub}> · {s.label}</tspan>
            </text>
            <text x={sb.field.x + sb.field.w} y={sb.box.y + (lay.mode === "narrow" ? 34 : 19)} className={styles.counter}>
              {s.status ? (
                <tspan className={styles.storeStatus} data-tone={s.status.tone}>
                  {s.status.text} ·{" "}
                </tspan>
              ) : null}
              {fmt(n.events)} events · {fmt(n.streams)} streams · {fmt(n.closed)} closed · {fmt(n.snapshots)} snapshots
            </text>
            <rect x={sb.field.x} y={sb.field.y} width={sb.field.w} height={sb.field.h} rx={8} className={styles.fieldBox} />
            <g className={styles.legend} transform={`translate(${sb.legend.x + 40}, ${sb.legend.y + 10})`}>
              {(
                [
                  ["k0", "tickets"],
                  ["k1", "agents"],
                  ["k2", "users"],
                  ["k3", "ledgers"],
                  ["snap", "snapshot"],
                  ["pii", "sensitive (pii)"],
                  ["tomb", "tombstone"],
                ] as const
              ).map(([k, label], i) => (
                <g key={k} transform={`translate(${i * (lay.mode === "narrow" ? 54 : Math.min(100, (sb.legend.w - 60) / 7))}, 0)`} data-k={k}>
                  {k === "snap" ? (
                    <circle r={3.6} className={styles.legendRing} />
                  ) : k === "tomb" ? (
                    <rect x={-3.5} y={-3.5} width={7} height={7} className={styles.legendTomb} />
                  ) : (
                    <circle r={3.4} className={styles.legendDot} />
                  )}
                  {k === "pii" && <circle r={1.5} className={styles.legendPii} />}
                  {lay.mode === "wide" && <text x={7} y={3.5}>{label}</text>}
                </g>
              ))}
              
            </g>
            {sb.cells.map(({ cell, box }) => (
              <CellView
                key={cell.uid}
                cell={cell}
                box={box}
                color={colors.get(cell.stream) ?? 0}
                flag={cell.ref && w.refs[cell.ref] === cell.uid ? w.flags[`cell:${cell.ref}`] : undefined}
                dim={(s.dim_from !== undefined && cell.id >= s.dim_from) || (s.only !== undefined && cell.stream !== s.only)}
                off={!!lit && !lit.cells.has(cell.uid) && hover !== cell.stream}
                selected={selected === cell.uid}
                onSelect={onSelect}
              />
            ))}
            {s.ghost && (
              <g className={`${styles.ghost} ${styles.fresh}`} style={{ transform: `translate(${sb.tail.x}px, ${sb.tail.y}px)` }}>
                <rect width={sb.tail.w} height={sb.tail.h} rx={7} />
                <text x={8} y={14} className={styles.cellId}>
                  ↩ bounced
                </text>
                <text x={8} y={29} className={styles.ghostError}>
                  {trim(s.ghost.error, 15)}
                </text>
                <text x={8} y={44} className={styles.cellStream}>
                  {s.ghost.expected !== undefined ? `exp v${s.ghost.expected} · head v${s.ghost.actual}` : "nothing appended"}
                </text>
              </g>
            )}

            {/* subscriptions, on the store's id axis */}
            {sb.subs_head && (
              <text x={sb.subs_head.x} y={sb.subs_head.y + 12} className={styles.sectionTitle}>
                Subscriptions <tspan className={styles.storeSub}>· ● watermark ◇ work mark, on the store's id axis</tspan>
              </text>
            )}
            {sb.cols && lay.mode === "wide" && (
              <g className={styles.subHead}>
                {(
                  [
                    ["target", SUB_COLS.target],
                    ["source", SUB_COLS.source],
                    ["lane", SUB_COLS.lane],
                    ["status", SUB_COLS.status],
                    ["lease", SUB_COLS.lease],
                    ["retries", SUB_COLS.retries],
                  ] as const
                ).map(([label, f]) => (
                  <text key={label} x={sb.cols!.x + sb.cols!.w * f} y={sb.cols!.y + 11} className={styles.colHead}>
                    {label}
                  </text>
                ))}
                <text x={sb.cols.x + sb.cols.w} y={sb.cols.y + 11} className={`${styles.colHead} ${styles.right}`}>
                  watermark · mark
                </text>
              </g>
            )}
            {sb.checkpoint && (
              <g className={styles.checkTrack}>
                <text x={sb.checkpoint.x} y={sb.checkpoint.y + 8} className={styles.trackLabel}>
                  correlate checkpoint {cp >= 0 ? `#${fmt(cp)}` : "—"}
                </text>
                <text x={sb.checkpoint.x + sb.checkpoint.w} y={sb.checkpoint.y + 8} className={`${styles.trackLabel} ${styles.right}`}>
                  #0 … #{fmt(sb.axis.max)}
                </text>
                <line x1={sb.axis.x} x2={sb.axis.x + sb.axis.w} y1={sb.checkpoint.y + 15} y2={sb.checkpoint.y + 15} />
                <rect x={sb.axis.x} y={sb.checkpoint.y + 13} width={Math.max(0, ax(cp) - sb.axis.x)} height={4} rx={2} className={styles.checkFill} />
                <g className={styles.marker} style={{ transform: `translate(${ax(cp)}px, ${sb.checkpoint.y + 15}px)` }}>
                  <path d="M0,-6 L5,0 L0,6 L-5,0 z" />
                </g>
              </g>
            )}
            {sb.lanes.map((g) => (
              <g key={g.lane}>
                <text x={g.head.x} y={g.head.y + 12} className={styles.laneHead}>
                  lane {g.lane}
                  <tspan className={styles.storeSub}>{g.budget ? ` · ${g.budget}` : g.lane === "default" ? " · leaseMillis 10 s" : ""}</tspan>
                </text>
                {g.rows.map(({ target: t, box, track }) => {
                  const st = status_of(t, w);
                  const on = !!lit?.targets.has(t.id) || (hoverRx !== undefined && t.reaction === hoverRx);
                  const narrow = lay.mode === "narrow";
                  const col = (f: number) => box.x + box.w * f;
                  const span = (f1: number, f2: number) => Math.floor((box.w * (f2 - f1)) / 6.3) - 1;
                  const y1 = box.y + 14;
                  const y2 = narrow ? box.y + 30 : y1;
                  const bx = narrow ? col(0.55) : col(SUB_COLS.status);
                  const bw = narrow ? box.w * 0.45 : box.w * (SUB_COLS.lease - SUB_COLS.status) - 6;
                  return (
                    // biome-ignore lint/a11y/noStaticElementInteractions: hover links a subscription to its reaction
                    <g
                      key={t.id}
                      className={`${styles.subRow} ${t.fresh ? styles.fresh : ""} ${on ? styles.focus : ""} ${off(on)}`}
                      data-state={st.key}
                      onMouseEnter={() => t.reaction && setHoverRx(t.reaction)}
                      onMouseLeave={() => setHoverRx(undefined)}
                    >
                      <rect x={box.x - 4} y={box.y - 1} width={box.w + 8} height={box.h + track.h + 4} rx={6} className={styles.rowBg} />
                      <text x={col(0)} y={y1} className={styles.subName}>
                        {trim(t.id, narrow ? 30 : span(0, SUB_COLS.source) - 2)}
                      </text>
                      <text x={narrow ? col(0) : col(SUB_COLS.source)} y={y2} className={styles.subCol}>
                        {trim(t.source ?? "all streams", narrow ? 18 : span(SUB_COLS.source, SUB_COLS.lane))}
                      </text>
                      {!narrow && (
                        <g className={styles.laneChip}>
                          <rect x={col(SUB_COLS.lane)} y={y1 - 11} width={Math.min(box.w * (SUB_COLS.status - SUB_COLS.lane) - 6, t.lane.length * 6 + 12)} height={14} rx={7} />
                          <text x={col(SUB_COLS.lane) + 6} y={y1 - 1}>
                            {trim(t.lane, span(SUB_COLS.lane, SUB_COLS.status) - 1)}
                            {t.priority !== undefined ? ` p${t.priority}` : ""}
                          </text>
                        </g>
                      )}
                      <g className={styles.badge} data-state={st.key}>
                        <rect x={bx} y={y1 - 11} width={Math.min(bw, st.label.length * 5.9 + 14)} height={15} rx={7.5} />
                        <text x={bx + 7} y={y1}>
                          {trim(st.label, Math.floor((bw - 14) / 5.9))}
                        </text>
                      </g>
                      {!narrow && t.lease && (
                        <g>
                          <text x={col(SUB_COLS.lease)} y={y1} className={styles.subCol}>
                            {trim(t.lease, span(SUB_COLS.lease, SUB_COLS.retries))}
                          </text>
                          <rect x={col(SUB_COLS.lease)} y={y1 + 3} width={box.w * 0.09} height={3} rx={1.5} className={styles.leaseBar} />
                        </g>
                      )}
                      {!narrow && (
                        <text x={col(SUB_COLS.retries)} y={y1} className={styles.subCol}>
                          {t.retry ? `${t.retry}${t.due ? ` · ${trim(t.due, 10)}` : ""}` : "—"}
                        </text>
                      )}
                      <text x={box.x + box.w} y={y2} className={`${styles.subCol} ${styles.right}`}>
                        {st.at < 0 ? "−1" : `#${fmt(st.at)}`} · {st.mark < 0 ? "—" : `#${fmt(st.mark)}`}
                      </text>
                      <line x1={track.x} x2={track.x + track.w} y1={track.y + 4} y2={track.y + 4} className={styles.trackLine} />
                      {st.mark > st.at && (
                        <rect x={ax(st.at)} y={track.y + 1} width={Math.max(2, ax(st.mark) - ax(st.at))} height={6} rx={3} className={styles.backlog} />
                      )}
                      {st.mark >= 0 && (
                        <g className={styles.marker} style={{ transform: `translate(${ax(st.mark)}px, ${track.y + 4}px)` }}>
                          <path d="M0,-5 L4,0 L0,5 L-4,0 z" className={styles.markHollow} />
                        </g>
                      )}
                      <g className={`${styles.marker} ${styles.watermark}`} style={{ transform: `translate(${ax(st.at)}px, ${track.y + 4}px)` }}>
                        <circle r={4} />
                      </g>
                    </g>
                  );
                })}
              </g>
            ))}
          </g>
        );
      })}

      {/* the route the step's tokens take, lit while the step is on screen */}
      {!reduce &&
        moves.map((m, i) => {
          const pts = lay.route(m.from, m.to);
          if (pts.length < 2) return null;
          const { starts } = schedule(moves);
          return (
            <polyline
              key={`route-${run}-${i}`}
              className={styles.route}
              data-tone={m.tone}
              points={pts.map((p) => `${p.x},${p.y}`).join(" ")}
              pathLength={1}
              style={{ animationDelay: `${starts[i]}ms` } as CSSProperties}
            />
          );
        })}

      <Tokens moves={moves} lay={lay} run={run} reduce={reduce} />
    </svg>
  );
}

function Inspector({ cell, onClose }: { cell: Cell; onClose: () => void }) {
  return (
    <div className={styles.inspector}>
      <div className={styles.inspectorHead}>
        <b>
          #{cell.id} {cell.name}
        </b>{" "}
        on <code>{cell.stream}</code> at version {cell.version}
        <button type="button" onClick={onClose} aria-label="Close the event details">
          ✕
        </button>
      </div>
      <dl>
        <dt>data</dt>
        <dd>{cell.data ? data_lines(cell.data, 12).join(", ") : "{}"}</dd>
        {cell.pii && (
          <>
            <dt>pii</dt>
            <dd>
              {cell.shredded
                ? "wiped (reads see [SHREDDED])"
                : `${Object.entries(cell.pii)
                    .map(([k, v]) => `${k}: ${short(v)}`)
                    .join(", ")} (isolated column)`}
            </dd>
          </>
        )}
        <dt>meta.correlation</dt>
        <dd>
          <code>{cell.corr}</code> <small>(a stand-in: events with the same value share one workflow)</small>
        </dd>
        <dt>meta.causation</dt>
        <dd>{cell.cause ? `event #${cell.cause.id} ${cell.cause.name}` : "an action (no event)"}</dd>
      </dl>
    </div>
  );
}

function spotlight(step: Step, w: World): Lit | undefined {
  const lit: Lit = { nodes: new Set(), cells: new Set(), targets: new Set(), streams: new Set(), tables: new Set() };
  const mark = (a: string) => {
    if (a.startsWith("cell:")) {
      const uid = w.refs[a.slice(5)];
      if (uid !== undefined) lit.cells.add(uid);
    } else if (a.startsWith("target:")) lit.targets.add(a.slice(7));
    else if (a.startsWith("table:")) lit.tables.add(a.slice(6));
    else if (a.startsWith("stream:")) lit.streams.add(a.slice(7));
    else if (!/^(log|store:|field:|gate|port|layer:)/.test(a)) lit.nodes.add(a);
  };
  for (const m of step.moves ?? []) {
    mark(m.from);
    mark(m.to);
  }
  for (const f of step.focus ?? []) mark(f);
  for (const key of Object.keys(w.flags)) mark(key);
  for (const s of w.stores) {
    for (const c of s.cells) if (c.fresh || c.leaving || c.moved) lit.cells.add(c.uid);
    if (s.ghost) lit.streams.add(s.ghost.stream);
  }
  for (const t of w.targets) if (t.fresh) lit.targets.add(t.id);
  for (const t of w.tables) if (t.fresh.length) lit.tables.add(t.name);
  for (const [id, st] of Object.entries(w.states)) if (st.fresh) lit.nodes.add(id);
  for (const s of w.stores) for (const c of s.cells) if (lit.cells.has(c.uid)) lit.streams.add(c.stream);
  const any = lit.nodes.size + lit.cells.size + lit.targets.size + lit.streams.size + lit.tables.size;
  return any ? lit : undefined;
}

function next_line(spec: TourSpec, all: Frames, index: number): string {
  const here = all[index]!;
  const step = spec.chapters[here.chapter]!.scenes[here.scene]!.steps[here.step]!;
  if (step.next) return step.next;
  const after = all[index + 1];
  if (!after) return "the end of the tour";
  const chapter = spec.chapters[after.chapter]!;
  if (after.chapter !== here.chapter) return `chapter ${after.chapter + 1}: ${chapter.title}`;
  const scene = chapter.scenes[after.scene]!;
  if (after.scene !== here.scene) return `scene: ${scene.title}`;
  return fill(scene.steps[after.step]!.now, after.world, all.base);
}

/** The app's anatomy for a chapter: its own, or the last one declared. */
function app_at(spec: TourSpec, chapter: number): AppSpec {
  for (let i = chapter; i >= 0; i--) {
    const a = spec.chapters[i]!.app;
    if (a) return a;
  }
  return { slices: [] };
}

function Popover({ tip, width, left, onClose }: { tip: OpenTip; width: number; left: number; onClose: () => void }) {
  return (
    <div className={styles.tip} role="tooltip" style={{ left, top: tip.y + 10, width }}>
      <div className={styles.tipHead}>
        <b>{tip.title}</b>
        <button type="button" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      {tip.code && (
        <div className={styles.tipCode}>
          <CodeBlock language="ts">{tip.code}</CodeBlock>
        </div>
      )}
      {tip.api && (
        <p className={styles.api}>
          {tip.api.map((x) => (
            <code key={x}>{x}</code>
          ))}
        </p>
      )}
      {(tip.doc || tip.test) && (
        <p className={styles.tipLinks}>
          {tip.doc && (
            <>
              Read: <Link to={tip.doc.href}>{tip.doc.label}</Link>
            </>
          )}
          {tip.test && (
            <>
              <br />
              Proven by: <Link href={tip.test.href}>{tip.test.label}</Link>
            </>
          )}
        </p>
      )}
    </div>
  );
}

export default function Tour({ spec }: { spec: TourSpec }) {
  const all = useMemo(() => fold(spec), [spec]);
  const colors = useMemo(() => stream_colors(all), [all]);
  const [index, setIndex] = useState(0);
  const [prevIndex, setPrevIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [run, setRun] = useState(0);
  const [reduce, setReduce] = useState(true);
  const [selected, setSelected] = useState<number | undefined>();
  const [menu, setMenu] = useState(false);
  const [panels, setPanels] = useState(true);
  const [tip, setTip] = useState<OpenTip | undefined>();
  const [hover, setHover] = useState<string | undefined>();
  const close_timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const box = useRef<HTMLDivElement>(null);
  const fit = useFit(box);
  const units = fit.mode === "narrow" ? 420 : Math.max(1100, Math.min(2200, fit.px - 4));

  const frame = all[index]!;
  const chapter = spec.chapters[frame.chapter]!;
  const scene = chapter.scenes[frame.scene]!;
  const step = scene.steps[frame.step]!;
  const view: View = chapter.view ?? "micro";
  const app = useMemo(() => app_at(spec, frame.chapter), [spec, frame.chapter]);
  const layer = useMemo(() => (spec.pipelines.action ?? []).filter((s) => s !== "commit"), [spec]);
  const moves = step.moves ?? [];
  const { total } = schedule(moves);
  const lay = useMemo(
    () => layout(fit.mode, view, scene.nodes, frame.world, app, layer, units),
    [fit.mode, view, scene.nodes, frame.world, app, layer, units]
  );
  const code = useMemo(() => {
    let c = scene.code;
    for (let i = 0; i <= frame.step; i++) c = scene.steps[i]!.code ?? c;
    return c && fill(c, frame.world, all.base);
  }, [scene, frame.step, frame.world, all.base]);
  const sel = selected === undefined ? undefined : frame.world.stores.flatMap((s) => s.cells).find((c) => c.uid === selected);
  const lit = useMemo(() => spotlight(step, frame.world), [step, frame.world]);
  const now = fill(step.now, frame.world, all.base);
  const say = fill(step.say, frame.world, all.base);
  const next = next_line(spec, all, index);
  const pipe = step.pipe && spec.pipelines[step.pipe.name] ? step.pipe : undefined;
  // the streams the scene works on; the field holds the rest
  const scene_streams = useMemo(() => {
    const rows = new Map<string, { stream: string; head: number; count: number; color: number }>();
    for (const st of frame.world.stores)
      for (const c of st.cells) {
        if (c.leaving) continue;
        const key = frame.world.stores.length > 1 ? `${c.stream} (${st.name})` : c.stream;
        const r = rows.get(key);
        if (r) {
          r.head = Math.max(r.head, c.version);
          r.count++;
        } else rows.set(key, { stream: key, head: c.version, count: 1, color: colors.get(c.stream) ?? 0 });
      }
    return [...rows.values()];
  }, [frame.world, colors]);
  const feed = useMemo(() => {
    const lines: { at: number; text: string }[] = [];
    for (let i = frame.chapter_start; i <= index; i++) for (const text of all[i]!.world.feed) lines.push({ at: i, text });
    return lines.reverse();
  }, [all, frame.chapter_start, index]);
  // a store animates from the step before only when we moved forward by one
  const animate = index === prevIndex + 1;

  useEffect(() => {
    setReduce(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    const id = window.location.hash.slice(1);
    const at = spec.chapters.findIndex((c) => c.id === id);
    if (at > 0) setIndex(all.findIndex((f) => f.chapter === at));
  }, [spec, all]);

  const go = useCallback(
    (to: number, keep = false) => {
      const next = Math.max(0, Math.min(all.length - 1, to));
      if (!keep) setPlaying(false);
      setPrevIndex(index);
      setIndex(next);
      setRun((r) => r + 1);
      setTip(undefined);
      setMenu(false);
      const ch = spec.chapters[all[next]!.chapter]!;
      if (typeof window !== "undefined" && window.location.hash !== `#${ch.id}`) window.history.replaceState(null, "", `#${ch.id}`);
    },
    [all, spec, index]
  );

  useEffect(() => {
    if (!playing) return;
    const last = index >= all.length - 1 || all[index + 1]!.chapter !== frame.chapter;
    const t = setTimeout(
      () => {
        if (last) setPlaying(false);
        else go(index + 1, true);
      },
      dwell(now, say, reduce ? 0 : total)
    );
    return () => clearTimeout(t);
  }, [playing, index, all, frame.chapter, now, say, total, reduce, go]);

  const openTip: TipFn = useCallback((id, el, c) => {
    clearTimeout(close_timer.current);
    if (!c || !el) {
      close_timer.current = setTimeout(() => setTip(undefined), 300);
      return;
    }
    const root = box.current?.getBoundingClientRect();
    if (!root) return;
    const r = el.getBoundingClientRect();
    setTip({ ...c, key: id, x: r.left + r.width / 2 - root.left, y: r.bottom - root.top });
  }, []);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      setTip(undefined);
      setMenu(false);
      return;
    }
    if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLButtonElement) return;
    if (e.key === "ArrowRight") go(index + 1);
    else if (e.key === "ArrowLeft") go(index - 1);
    else if (e.key === " ") {
      e.preventDefault();
      setPlaying((p) => !p);
    }
  };

  const fullscreen = () => {
    const el = box.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.();
  };

  const chapterFrames = all.filter((f) => f.chapter === frame.chapter);
  const atStart = index === 0;
  const atEnd = index === all.length - 1;
  const step_tip: TipContent = { title: scene.title, code, api: scene.api, doc: scene.doc, test: scene.test };
  const root_w = box.current?.clientWidth ?? 800;
  const tip_w = Math.min(600, root_w - 16);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the player takes the arrow keys and space
    <div ref={box} className={styles.tour} data-mode={fit.mode} onKeyDown={onKey} tabIndex={-1}>
      <header className={styles.top}>
        <div className={styles.menuWrap}>
          <button type="button" className={styles.menuButton} onClick={() => setMenu((m) => !m)} aria-expanded={menu}>
            ☰ Chapters
          </button>
          {menu && (
            <ol className={styles.menu}>
              {spec.chapters.map((c, i) => (
                <li key={c.id}>
                  <button
                    type="button"
                    className={i === frame.chapter ? styles.current : ""}
                    aria-current={i === frame.chapter ? "step" : undefined}
                    onClick={() => go(all.findIndex((f) => f.chapter === i))}
                  >
                    <span className={styles.num}>{i + 1}</span>
                    <span>
                      {c.title}
                      <small>{c.audience}</small>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>
        <h2>
          {frame.chapter + 1}. {chapter.title}
        </h2>
        <span className={styles.audience}>{chapter.audience}</span>
        <span className={styles.viewTag}>{view === "macro" ? "the whole store" : "zoomed in"}</span>
        <button type="button" className={styles.full} onClick={fullscreen} aria-label="Full screen">
          ⛶
        </button>
      </header>

      <div className={styles.nowNext} aria-live="polite">
        <p className={styles.now} key={`now-${index}`}>
          <span className={styles.tag}>Now</span>
          <span>
            {rich(now)}
            {atStart && !playing && <span className={styles.cue}> · Press Play or → to start</span>}
          </span>
          <button
            type="button"
            className={styles.codeIcon}
            aria-label="How this step is coded, and where to read more"
            onMouseEnter={(e) => openTip("step", e.currentTarget, step_tip)}
            onMouseLeave={(e) => openTip("step", e.currentTarget, undefined)}
            onFocus={(e) => openTip("step", e.currentTarget, step_tip)}
            onClick={(e) => openTip("step", e.currentTarget, step_tip)}
          >
            {"</>"}
          </button>
        </p>
        <p className={styles.sayLine}>{rich(say)}</p>
        <p className={styles.next}>
          <span className={styles.tag}>Next</span>
          <span>{rich(next)}</span>
        </p>
      </div>

      <ol className={styles.pipe} aria-label={pipe ? `${pipe.name} stages` : undefined} data-empty={!pipe || undefined}>
        {pipe ? (
          <>
            <li className={styles.pipeName}>{pipe.name}</li>
            {spec.pipelines[pipe.name]!.map((stage, i) => {
              const state = i < pipe.at ? "done" : i === pipe.at ? (pipe.fail ? "fail" : "active") : pipe.fail ? "skip" : "todo";
              return (
                <li key={stage} data-state={state}>
                  <span>{state === "done" ? "✓" : state === "fail" ? "✕" : i + 1}</span>
                  {stage}
                </li>
              );
            })}
          </>
        ) : (
          <li className={styles.pipeName}>one operation</li>
        )}
      </ol>

      <div className={styles.stageWrap}>
        <Stage
          lay={lay}
          frame={frame}
          base={all.base}
          colors={colors}
          moves={moves}
          run={run}
          reduce={reduce}
          enter={reduce ? 0 : total}
          lit={lit}
          step={step}
          pipelines={spec.pipelines}
          view={view}
          hover={hover}
          setHover={setHover}
          selected={sel?.uid}
          onSelect={(uid) => setSelected((s) => (s === uid ? undefined : uid))}
          tip={openTip}
        />
        {lay.stores.map((sb) => (
          <div
            key={sb.store.name}
            className={styles.fieldWrap}
            style={{
              left: `${(sb.field.x / lay.width) * 100}%`,
              top: `${(sb.field.y / lay.height) * 100}%`,
              width: `${(sb.field.w / lay.width) * 100}%`,
              height: `${(sb.field.h / lay.height) * 100}%`,
            }}
          >
            <Field
              store={sb.store}
              base={all.base}
              run={animate ? run : -run}
              enter={animate && !reduce ? total : 0}
              reduce={reduce || !animate}
              hover={hover}
              onHover={setHover}
            />
          </div>
        ))}
        {sel && <Inspector cell={sel} onClose={() => setSelected(undefined)} />}
      </div>

      <div className={styles.controls}>
        <button type="button" onClick={() => go(index - 1)} disabled={atStart} aria-label="Previous step">
          ‹
        </button>
        <button type="button" className={styles.play} onClick={() => setPlaying((p) => !p)}>
          {playing ? "Pause" : "Play"}
        </button>
        <button type="button" onClick={() => go(index + 1)} disabled={atEnd} aria-label="Next step">
          ›
        </button>
        <span className={styles.count}>
          step {index - frame.chapter_start + 1} of {chapterFrames.length} · scene {frame.scene + 1} of {chapter.scenes.length}:{" "}
          {scene.title}
        </span>
        <button type="button" className={styles.panelToggle} onClick={() => setPanels((p) => !p)} aria-expanded={panels}>
          {panels ? "Hide steps and feed" : "Show steps and feed"}
        </button>
      </div>

      {panels && (
        <div className={styles.panels}>
          <section className={styles.stepsBox}>
            <h4>Steps in this scene</h4>
            <ol className={styles.steps}>
              {scene.steps.map((s, i) => {
                const state = i < frame.step ? "done" : i === frame.step ? "now" : "todo";
                const f = all[frame.scene_start + i]!;
                return (
                  <li key={i} data-state={state}>
                    <button type="button" onClick={() => go(frame.scene_start + i)} aria-current={state === "now" ? "step" : undefined}>
                      <span className={styles.stepMark}>{state === "done" ? "✓" : i + 1}</span>
                      <span>{rich(fill(s.now, f.world, all.base))}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </section>
          <section className={styles.streamsBox}>
            <h4>Streams in this scene</h4>
            <ol className={styles.streamList}>
              {scene_streams.map((r) => (
                // biome-ignore lint/a11y/noNoninteractiveElementInteractions: hover lights the stream's dots in the field
                <li
                  key={r.stream}
                  data-color={r.color}
                  onMouseEnter={() => setHover(r.stream.split(" ")[0])}
                  onMouseLeave={() => setHover(undefined)}
                >
                  <span className={styles.swatch} />
                  <code>{r.stream}</code>
                  <span className={styles.streamMeta}>
                    v{r.head} · {r.count} event{r.count > 1 ? "s" : ""}
                  </span>
                </li>
              ))}
            </ol>
          </section>
          <section className={styles.feedBox}>
            <details open={fit.mode !== "narrow"}>
              <summary>What happened so far ({feed.length})</summary>
              <ol className={styles.feed} aria-label="What happened so far in this chapter">
                {feed.map((l, i) => (
                  <li key={`${l.at}-${i}`} className={l.at === index ? styles.feedNow : ""}>
                    <button type="button" onClick={() => go(l.at)}>
                      <span className={styles.feedStep}>{l.at - frame.chapter_start + 1}</span>
                      <span>{rich(l.text)}</span>
                    </button>
                  </li>
                ))}
                {!feed.length && <li className={styles.hint}>Nothing yet: press Play or step forward.</li>}
              </ol>
            </details>
          </section>
        </div>
      )}

      {tip && (
        // biome-ignore lint/a11y/noStaticElementInteractions: hovering the tooltip keeps it open
        <div onMouseEnter={() => clearTimeout(close_timer.current)} onMouseLeave={() => setTip(undefined)}>
          <Popover
            tip={tip}
            width={tip_w}
            left={Math.max(8, Math.min(tip.x - tip_w / 2, root_w - tip_w - 8))}
            onClose={() => setTip(undefined)}
          />
        </div>
      )}
    </div>
  );
}
