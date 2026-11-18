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
import Field, { stream_hue } from "./Field";
import { type Box, type Chip, data_lines, type Layout, layout, type Mode, short, type View } from "./layout";
import styles from "./styles.module.css";
import type { AppSpec, Link as DocLink, Move, Step, TourSpec } from "./types";
import { Ambient } from "./music";
import { type Cell, census, type Frame, type Frames, fill, fmt, frames as fold, sentences, spoken, type Target, type World } from "./world";

export type { TourSpec } from "./types";

const MOVE_MS = 820;
const TRAIL = [1, 2, 3];
/** how long a chapter's title card shows between chapters */
const CARD_MS = 2400;
/** the narration's rate at 1×: a touch slower than the default */
const RATE = 0.95;
const SENTENCE_GAP_MS = 280;
const STEP_GAP_MS = 750;
const CAPTION_PX = 84;
const BAR_PX = 46;
/** every `</>` icon sits this far in from its element's top-right corner */
const TIP = 10;

// the stage names a narrow pill shows; the full name is its title
const SHORT: Record<string, string> = { preconditions: "rules", "state check": "check" };
const LAND_MS = 900;
const PALETTE = 8;

const useBrowserLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;


/** How natural a voice is likely to sound: neural and premium voices first, in the page's language. */
function voice_rank(v: SpeechSynthesisVoice, lang: string): number {
  const n = v.name;
  let score = 0;
  if (/natural|neural/i.test(n)) score += 50;
  if (/premium|enhanced/i.test(n)) score += 40;
  if (/google us english/i.test(n)) score += 35;
  if (/online/i.test(n)) score += 30;
  if (/\b(ava|samantha|zoe|aria|jenny|allison|evan)\b/i.test(n)) score += 10;
  if (/compact|espeak|eloquence/i.test(n)) score -= 40;
  if (v.lang === lang) score += 100;
  else if (v.lang.split("-")[0] === lang.split("-")[0]) score += 60;
  return score;
}

/** A caption in plain words: code spans lose their chips (a call keeps its name), bold stays. */
function plain(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/).map((part, i) => {
    if (part.startsWith("`")) {
      const code = part.slice(1, -1);
      return code.includes("(") ? code.slice(0, code.indexOf("(")) : code;
    }
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


type Fit = { mode: Mode; px: number; vh: number; full: boolean; top: number };
function useFit(ref: React.RefObject<HTMLElement | null>): Fit {
  const [fit, setFit] = useState<Fit>({ mode: "wide", px: 1280, vh: 800, full: false, top: 60 });
  useBrowserLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () =>
      setFit({
        mode: el.clientWidth < 760 ? "narrow" : "wide",
        px: el.clientWidth,
        vh: window.innerHeight,
        full: document.fullscreenElement === el,
        // where the tour starts on the page: under the navbar and any announcement
        top: Math.round(el.getBoundingClientRect().top + window.scrollY),
      });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    document.addEventListener("fullscreenchange", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
      document.removeEventListener("fullscreenchange", measure);
    };
  }, [ref]);
  return fit;
}

/** The token's path, sampled along its straight legs. */
function path_frames(points: { x: number; y: number }[]): Keyframe[] {
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    for (let k = 0; k < 10; k++) {
      const t = k / 10;
      pts.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  pts.push(points[points.length - 1]!);
  return pts.map((p, i) => ({
    transform: `translate(${p.x}px, ${p.y}px)`,
    opacity: i === 0 || i === pts.length - 1 ? 0 : 1,
  }));
}

function Tokens({ moves, lay, run, reduce }: { moves: Move[]; lay: Layout; run: number; reduce: boolean }) {
  const refs = useRef<(SVGGElement | null)[]>([]);
  const trail = useRef<(SVGCircleElement | null)[]>([]);
  useEffect(() => {
    if (reduce) return;
    const { starts } = schedule(moves);
    const anims: Animation[] = [];
    moves.forEach((m, i) => {
      const el = refs.current[i];
      const pts = lay.route(m.from, m.to);
      if (!el || pts.length < 2) return;
      const frames = path_frames(pts);
      const ease = "cubic-bezier(.45,.05,.35,1)";
      anims.push(el.animate(frames, { duration: MOVE_MS, delay: starts[i], easing: ease, fill: "both" }));
      // a short trail of data particles follows the token
      for (const k of TRAIL) {
        const p = trail.current[i * TRAIL.length + k - 1];
        if (p) anims.push(p.animate(frames, { duration: MOVE_MS, delay: (starts[i] ?? 0) + k * 70, easing: ease, fill: "both" }));
      }
    });
    return () => anims.forEach((x) => x.cancel());
  }, [run, moves, lay, reduce]);
  if (reduce) return null;
  return (
    <g className={styles.tokens} aria-hidden>
      {moves.flatMap((m, i) =>
        TRAIL.map((k) => (
          <circle
            key={`${run}-${i}-t${k}`}
            ref={(el) => {
              trail.current[i * TRAIL.length + k - 1] = el;
            }}
            r={4.2 - k * 0.8}
            className={styles.particle}
            data-tone={m.tone}
            style={{ opacity: 0 }}
          />
        ))
      )}
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
            // above and right of the token, clear of the chip it passes
            <text x={9} y={-11}>
              {m.label}
            </text>
          )}
        </g>
      ))}
    </g>
  );
}

let measure_ctx: CanvasRenderingContext2D | null | undefined;
/** Fits a label to a width: the whole name when it fits, else cut with an ellipsis. */
function fit_text(text: string, width: number, size: number, weight = 600): string {
  if (measure_ctx === undefined) measure_ctx = typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null;
  const ctx = measure_ctx;
  const w = (t: string) => {
    if (!ctx) return t.length * size * 0.6;
    ctx.font = `${weight} ${size}px Inter, system-ui, -apple-system, sans-serif`;
    return ctx.measureText(t).width;
  };
  if (w(text) <= width) return text;
  let n = text.length - 1;
  while (n > 1 && w(`${text.slice(0, n)}…`) > width) n--;
  return `${text.slice(0, n)}…`;
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
  scale = 1,
  color,
  flag,
  dim,
  off,
  selected,
  active,
  onSelect,
  onHover,
}: {
  cell: Cell;
  box: Box;
  scale?: number;
  color: number;
  flag?: { text: string; tone?: string };
  dim: boolean;
  off: boolean;
  selected: boolean;
  active: boolean;
  onSelect: (uid: number) => void;
  onHover?: (stream: string | undefined) => void;
}) {
  const state = cell.leaving ? styles.leaving : cell.fresh ? styles.fresh : cell.moved ? styles.moved : "";
  const label = cell.kind === "event" ? cell.name : cell.kind === "snapshot" ? "◆ snapshot" : "⊘ tombstone";
  return (
    <g className={styles.cellPos} style={{ transform: `translate(${box.x}px, ${box.y}px) scale(${scale})` }}>
      {/* biome-ignore lint/a11y/useSemanticElements: an SVG cell cannot be a <button> */}
      <g
        className={`${styles.cell} ${state} ${dim ? styles.dim : ""} ${selected ? styles.selected : ""} ${active ? styles.active : ""} ${off ? styles.off : ""}`}
        data-kind={cell.kind}
        data-color={color}
        role="button"
        tabIndex={0}
        aria-label={`event #${cell.id}, ${cell.name} on ${cell.stream} version ${cell.version}`}
        onClick={() => onSelect(cell.uid)}
        onMouseEnter={() => onHover?.(cell.stream)}
        onMouseLeave={() => onHover?.(undefined)}
        style={{ "--sh": `hsl(${stream_hue(cell.stream)} ${active ? "72% 48%" : "26% 62%"})` } as CSSProperties}
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
        {(() => {
          const room = box.w - 16;
          const size = fit_text(label, room, 10) === label ? 10 : 9;
          return (
            <text x={11} y={30} className={styles.cellName} style={{ fontSize: size }}>
              <title>{label}</title>
              {fit_text(label, room, size)}
            </text>
          );
        })()}
        <text x={11} y={44} className={styles.cellStream}>
          {trim(cell.stream, Math.floor((box.w - 16) / 5.8))}
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

type Lit = { nodes: Set<string>; cells: Set<number>; targets: Set<string>; streams: Set<string>; tables: Set<string>; areas: Set<string> };

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
  // the areas this step works in glow; the rest fades back
  const touches = (x: string) => /^(log|store:|field:|cell:|stream:|port)/.test(x);
  const routed = moves.some((m) => lay.route(m.from, m.to).length > 2);
  const layer_on = pipe?.name === "action" || routed || !!lit?.areas.has("layer");
  const store_on =
    moves.some((m) => touches(m.from) || touches(m.to)) ||
    !!lit?.cells.size ||
    !!lit?.streams.size ||
    !!lit?.targets.size ||
    !!lit?.areas.has("store") ||
    (step.ops ?? []).some((o) => o.op !== "state" && o.op !== "dim");
  const area = (on: boolean) => (on ? styles.glow : lit ? styles.off : "");

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
      {/* the actors: an icon each, at the edge */}
      {lay.callers.map(({ node, box }) => {
        const cx = box.x + box.w / 2;
        const cy = box.y + 14;
        return (
          <g
            key={node.id}
            className={`${styles.actor} ${lit?.nodes.has(node.id) ? styles.focus : ""} ${off(!!lit?.nodes.has(node.id))}`}
            data-kind={node.kind}
          >
            <title>{node.sub ? `${node.label} · ${node.sub}` : node.label}</title>
            <circle cx={cx} cy={cy} r={13} className={styles.actorDisc} />
            {node.kind === "actor" ? (
              <g className={styles.actorIcon} transform={`translate(${cx} ${cy}) scale(0.78) translate(${-cx} ${-cy})`}>
                <circle cx={cx} cy={cy - 5} r={4.6} />
                <path d={`M${cx - 8.5},${cy + 10} a8.5,7.5 0 0 1 17,0 z`} />
              </g>
            ) : node.kind === "worker" ? (
              <g className={styles.actorIcon} transform={`translate(${cx} ${cy}) scale(0.78) translate(${-cx} ${-cy})`}>
                <circle cx={cx} cy={cy} r={6.5} className={styles.gear} />
                {[0, 45, 90, 135, 180, 225, 270, 315].map((d) => (
                  <rect key={d} x={cx - 1.6} y={cy - 10.5} width={3.2} height={4} transform={`rotate(${d} ${cx} ${cy})`} />
                ))}
                <circle cx={cx} cy={cy} r={2.4} className={styles.gearHole} />
              </g>
            ) : (
              <g className={styles.actorIcon} transform={`translate(${cx} ${cy}) scale(0.78) translate(${-cx} ${-cy})`}>
                <circle cx={cx} cy={cy} r={8} className={styles.globe} />
                <path d={`M${cx - 8},${cy} h16 M${cx},${cy - 8} c-5,5 -5,11 0,16 M${cx},${cy - 8} c5,5 5,11 0,16`} className={styles.globe} />
              </g>
            )}
            <text x={cx} y={box.y + 40} className={styles.actorLabel}>
              {trim(node.label, 8)}
            </text>
          </g>
        );
      })}

      {/* the one link between the two centers: commits go in, loads and reactions read back */}
      {lay.mode === "wide" && lay.stores[0] && (
        <g className={`${styles.bridge} ${area(store_on && layer_on)}`}>
          <path d={`M${lay.port.x + 8},${lay.port.y - 5} L${lay.stores[0].box.x - 3},${lay.port.y - 5}`} markerEnd="url(#tour-arrow)" />
          <path d={`M${lay.stores[0].box.x - 2},${lay.port.y + 6} L${lay.port.x + 9},${lay.port.y + 6}`} markerEnd="url(#tour-arrow)" />
        </g>
      )}

      {/* the running Act app, scaled as one group to fill its frame */}
      <g
        className={styles.app}
        transform={
          lay.app_view.s !== 1
            ? `translate(${lay.app_view.ox} ${lay.app_view.oy}) scale(${lay.app_view.s}) translate(${-lay.app_view.ox} ${-lay.app_view.oy})`
            : undefined
        }
      >
        <rect x={a.box.x} y={a.box.y} width={a.box.w} height={a.box.h} rx={16} className={styles.appBox} />
        <text x={a.box.x + 12} y={a.box.y + 20} className={styles.appTitle}>
          Act app
        </text>
        <SvgTip x={a.box.x + a.box.w - TIP} y={a.box.y + TIP} id="app" content={{ title: "How the app is built", code: a.title }} open={tip} />

        {/* the action layer: one ordered pipe, then the commit port */}
        <g className={area(layer_on)}>
        <rect x={a.layer_box.x} y={a.layer_box.y} width={a.layer_box.w} height={a.layer_box.h} rx={10} className={styles.layerBox} />
        <text x={a.layer_box.x + 8} y={a.layer_box.y + 14} className={styles.layerLabel}>
          action layer
          {lay.mode === "wide" && a.layer_box.w > 640 && <tspan className={styles.appSub}> · every refusal but ConcurrencyError happens here</tspan>}
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
                {(() => {
                  const mark = state === "done" ? "✓ " : state === "fail" ? "✕ " : "";
                  const full = fit_text(mark + stage, box.w - 8, 11, 500) === mark + stage;
                  return fit_text(full ? stage : (SHORT[stage] ?? stage), box.w - 8 - (mark ? 12 : 0), 11, 500);
                })()}
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
                <rect x={x} y={a.layer_box.y + a.layer_box.h - 20} width={tw} height={16} rx={8} />
                <text x={x + 8} y={a.layer_box.y + a.layer_box.h - 9}>
                  {text}
                </text>
              </g>
            );
          })()}
        </g>
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
              <SvgTip x={s.box.x + s.box.w - TIP} y={s.box.y + TIP} id={`slice:${s.name}`} content={{ title: `slice ${s.name}`, code: s.code }} open={tip} />
            )}
          </g>
        ))}
        {a.links.filter((l) => l.kind === "listen").map((l, i) => (
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
              {(() => {
                // the title shares its line with the version and the code icon, never wraps under them
                const room = Math.floor((st.box.w - 16 - (st.code ? TIP * 2 + 4 : 0) - (st.version !== undefined ? 24 : 0)) / 6.6);
                const title = trim(st.title ?? st.name, room);
                const left = room - title.length - 1;
                return (
                  <text x={st.box.x + 8} y={st.box.y + 15} className={styles.cardTitle}>
                    {title}
                    {st.sub && left > 3 && <tspan className={styles.appSub}> {trim(st.sub, left)}</tspan>}
                  </text>
                );
              })()}
              {st.version !== undefined && (
                <text x={st.box.x + st.box.w - (st.code ? TIP * 2 + 4 : 8)} y={st.box.y + 15} className={styles.stateVer}>
                  v{st.version}
                </text>
              )}
              {st.code && <SvgTip x={st.box.x + st.box.w - TIP} y={st.box.y + TIP} id={`state:${st.name}`} content={{ title: st.name, code: st.code }} open={tip} />}
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
                <title>{c.label}</title>
                {fit_text(c.label, c.box.w - (c.code ? TIP * 2 + 6 : 12), 11)}
              </text>
              {c.code && <SvgTip x={c.box.x + c.box.w - TIP} y={c.box.y + c.box.h / 2} id={key} content={{ title: c.name, code: c.code }} open={tip} />}
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
          <g key={s.name} className={`${styles.store} ${store_on ? styles.storeOn : lit ? styles.off : ""}`} data-tone={s.status?.tone}>
            <rect x={sb.box.x} y={sb.box.y} width={sb.box.w} height={sb.box.h} rx={14} className={styles.storeBox} />
            <text x={sb.field.x} y={sb.box.y + 19} className={styles.storeTitle}>
              Event store
              {sb.box.w > 760 && <tspan className={styles.storeSub}> · {s.label}</tspan>}
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
            {sb.cells.map(({ cell, box }) => (
              <CellView
                key={cell.uid}
                cell={cell}
                box={{ ...box, w: box.w / sb.scale, h: box.h / sb.scale }}
                scale={sb.scale}
                color={colors.get(cell.stream) ?? 0}
                flag={cell.ref && w.refs[cell.ref] === cell.uid ? w.flags[`cell:${cell.ref}`] : undefined}
                dim={(s.dim_from !== undefined && cell.id >= s.dim_from) || (s.only !== undefined && cell.stream !== s.only)}
                off={!!lit && !lit.cells.has(cell.uid) && hover !== cell.stream}
                selected={selected === cell.uid}
                active={!!lit?.cells.has(cell.uid) || hover === cell.stream || (!!cell.fresh && !cell.leaving)}
                onSelect={onSelect}
                onHover={setHover}
              />
            ))}
            {sb.gaps.map((g) => (
              <g key={`gap-${g.from}`} className={styles.gap}>
                <rect x={g.box.x} y={g.box.y} width={g.box.w} height={g.box.h} rx={7} />
                <text x={g.box.x + g.box.w / 2} y={g.box.y + g.box.h / 2 - 2}>
                  ⋯
                </text>
                <text x={g.box.x + g.box.w / 2} y={g.box.y + g.box.h / 2 + 11} className={styles.gapIds}>
                  {g.from === g.to ? `#${fmt(g.from)}` : `#${fmt(g.from)}–#${fmt(g.to)}`}
                </text>
              </g>
            ))}
            {s.ghost && sb.bounce && lay.mode === "wide" && (
              <g className={styles.ghost}>
                {/* a short stub from the commit port across the store's frame to the pill */}
                <path
                  className={styles.bounceLink}
                  d={`M${lay.port.x + 7},${lay.port.y} L${sb.box.x},${lay.port.y} L${sb.box.x},${sb.bounce.y + sb.bounce.h / 2} L${sb.bounce.x},${sb.bounce.y + sb.bounce.h / 2}`}
                />
                <rect x={sb.bounce.x} y={sb.bounce.y} width={sb.bounce.w} height={sb.bounce.h} rx={9} />
                <text x={sb.bounce.x + 9} y={sb.bounce.y + 13} className={styles.ghostLine}>
                  ↩ bounced at the store · ConcurrencyError ·{" "}
                  {s.ghost.expected !== undefined ? `expected v${s.ghost.expected} · head v${s.ghost.actual}` : "nothing appended"}
                </text>
              </g>
            )}
            {s.ghost && sb.bounce && lay.mode === "narrow" && (
              <g className={styles.ghost} style={{ transform: `translate(${sb.bounce.x}px, ${sb.bounce.y}px)` }}>
                <rect width={sb.bounce.w} height={sb.bounce.h} rx={8} />
                <text x={8} y={14} className={styles.cellId}>
                  ↩ bounced at the store
                </text>
                <text x={8} y={28} className={styles.ghostError}>
                  ConcurrencyError
                </text>
                <text x={8} y={41} className={styles.ghostLine}>
                  {s.ghost.expected !== undefined ? `expected v${s.ghost.expected} · head v${s.ghost.actual}` : "nothing appended"}
                </text>
              </g>
            )}

            {/* subscriptions: the correlate checkpoint, then one quiet track each */}
            {sb.checkpoint && (
              <g className={styles.checkTrack}>
                <text x={sb.checkpoint.x} y={sb.checkpoint.y + 8} className={styles.trackLabel}>
                  correlate {cp >= 0 ? `· read to ${fmt(cp)}` : ""}
                </text>
                <line x1={sb.axis.x} x2={sb.axis.x + sb.axis.w} y1={sb.checkpoint.y + 15} y2={sb.checkpoint.y + 15} />
                <rect x={sb.axis.x} y={sb.checkpoint.y + 13} width={Math.max(0, ax(cp) - sb.axis.x)} height={4} rx={2} className={styles.checkFill} />
                <g className={styles.marker} style={{ transform: `translate(${ax(cp)}px, ${sb.checkpoint.y + 15}px)` }}>
                  <path d="M0,-5 L4,0 L0,5 L-4,0 z" />
                </g>
              </g>
            )}
            {sb.lanes.flatMap((g) =>
              g.rows.map(({ target: t, box, track }) => {
                const st = status_of(t, w);
                const on = !!lit?.targets.has(t.id) || (hoverRx !== undefined && t.reaction === hoverRx);
                return (
                  // biome-ignore lint/a11y/noStaticElementInteractions: hover links a subscription to its reaction
                  <g
                    key={t.id}
                    className={`${styles.subRow} ${t.fresh ? styles.fresh : ""} ${on ? styles.focus : ""} ${off(on)}`}
                    data-state={st.key}
                    onMouseEnter={() => t.reaction && setHoverRx(t.reaction)}
                    onMouseLeave={() => setHoverRx(undefined)}
                  >
                    <text x={box.x} y={box.y + 10} className={styles.trackLabel}>
                      {trim(t.id, 40)}
                      <tspan className={styles.trackState}> · {trim(st.label, 32)}</tspan>
                    </text>
                    <line x1={track.x} x2={track.x + track.w} y1={track.y + 4} y2={track.y + 4} className={styles.trackLine} />
                    {st.mark > st.at && (
                      <rect x={ax(st.at)} y={track.y + 2} width={Math.max(2, ax(st.mark) - ax(st.at))} height={4} rx={2} className={styles.backlog} />
                    )}
                    <g className={`${styles.marker} ${styles.watermark}`} style={{ transform: `translate(${ax(st.at)}px, ${track.y + 4}px)` }}>
                      <circle r={3.5} />
                    </g>
                  </g>
                );
              })
            )}
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
  const lit: Lit = { nodes: new Set(), cells: new Set(), targets: new Set(), streams: new Set(), tables: new Set(), areas: new Set() };
  const mark = (a: string) => {
    if (a.startsWith("cell:")) {
      const uid = w.refs[a.slice(5)];
      if (uid !== undefined) lit.cells.add(uid);
    } else if (a.startsWith("target:")) lit.targets.add(a.slice(7));
    else if (a.startsWith("table:")) lit.tables.add(a.slice(6));
    else if (a.startsWith("stream:")) lit.streams.add(a.slice(7));
    else if (a === "layer:" || a === "store:") lit.areas.add(a.slice(0, -1));
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
  const any = lit.nodes.size + lit.cells.size + lit.targets.size + lit.streams.size + lit.tables.size + lit.areas.size;
  return any ? lit : undefined;
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
  // captions are always on; narration and music start with the first Play
  const cc = true;
  const [sound, setSound] = useState(true);
  const muted = false;
  const [speed, setSpeed] = useState(1);
  const [cue, setCue] = useState(-1);
  const [card, setCard] = useState<string | undefined>();
  const music = true;
  const music_level = 0.6;
  const ambient = useRef<Ambient | undefined>(undefined);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voice_name, setVoiceName] = useState<string>("");
  const pick_voice = useCallback(
    (): SpeechSynthesisVoice | undefined => voices.find((v) => v.name === voice_name) ?? voices[0],
    [voices, voice_name]
  );


  const menu_ref = useRef<HTMLDivElement>(null);
  const [voice, setVoice] = useState(false);
  const [tip, setTip] = useState<OpenTip | undefined>();
  const [hover, setHover] = useState<string | undefined>();
  const close_timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const box = useRef<HTMLDivElement>(null);
  const fit = useFit(box);
  // the stage takes the whole height but the control row; its bottom strip is kept for the subtitles
  const stage_px = Math.max(360, fit.vh - (fit.full ? 0 : fit.top) - BAR_PX);

  // an intro chapter is chapter 0
  const first = spec.chapters[0]?.id === "intro" ? 0 : 1;
  const frame = all[index]!;
  const chapter = spec.chapters[frame.chapter]!;
  const scene = chapter.scenes[frame.scene]!;
  const step = scene.steps[frame.step]!;
  const view: View = chapter.view ?? "micro";
  const app = useMemo(() => app_at(spec, frame.chapter), [spec, frame.chapter]);
  const layer = useMemo(() => (spec.pipelines.action ?? []).filter((s) => s !== "commit"), [spec]);
  const moves = step.moves ?? [];
  const { total } = schedule(moves);
  // the stage's layout for the space it has: nothing sits small in a big box
  const lay = useMemo(() => {
    const at = (z: number) => {
      const units = fit.mode === "narrow" ? 420 : Math.max(1100, Math.min(2200, (fit.px - 4) / z));
      const per_px = units / Math.max(1, fit.px);
      const cap = CAPTION_PX * per_px;
      const room = stage_px * per_px - cap;
      const l = layout(fit.mode, view, scene.nodes, frame.world, app, layer, units, room);
      return { l: { ...l, height: l.height + cap } };
    };
    // the app and the store each scale their own content to fill; the stage keeps its width
    return at(1).l;
  }, [fit.mode, fit.px, stage_px, view, scene.nodes, frame.world, app, layer]);
  const sel = selected === undefined ? undefined : frame.world.stores.flatMap((s) => s.cells).find((c) => c.uid === selected);
  const lit = useMemo(() => spotlight(step, frame.world), [step, frame.world]);
  const say = fill(step.say, frame.world, all.base);
  const lines = useMemo(() => sentences(say), [say]);
  const speech = useMemo(() => {
    const words = step.speak ? sentences(fill(step.speak, frame.world, all.base)) : lines.map(spoken);
    return words;
  }, [step.speak, frame.world, all.base, lines]);
  // a store animates from the step before only when we moved forward by one
  const animate = index === prevIndex + 1;
  const pointing = new Set(step.ui ?? []);

  useEffect(() => {
    setReduce(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    const can = typeof window !== "undefined" && "speechSynthesis" in window;
    setVoice(can);
    if (can) {
      // the voice list arrives late in some browsers
      const load = () => {
        const lang = document.documentElement.lang || navigator.language || "en-US";
        setVoices([...window.speechSynthesis.getVoices()].sort((a, b) => voice_rank(b, lang) - voice_rank(a, lang)));
      };
      load();
      window.speechSynthesis.addEventListener?.("voiceschanged", load);
    }
    try {
      setVoiceName(window.localStorage.getItem("act-tour-voice") ?? "");
    } catch {
      // storage can be blocked; the best voice is picked instead
    }
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
      setCue(-1);
      setCard(undefined);
      const ch = spec.chapters[all[next]!.chapter]!;
      if (typeof window !== "undefined" && window.location.hash !== `#${ch.id}`) window.history.replaceState(null, "", `#${ch.id}`);
    },
    [all, spec, index]
  );

  // the pacing: the token travels, then each sentence is spoken (or shown for its length), then the next step
  useEffect(() => {
    // stepping still runs the step's captions once, without a voice and without moving on
    if (!playing && voice) window.speechSynthesis.cancel();
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const last = index >= all.length - 1 || all[index + 1]!.chapter !== frame.chapter;
    const talk = playing && voice && sound && !muted;
    const advance = () => {
      if (cancelled || !playing) return;
      if (index >= all.length - 1) return setPlaying(false);
      if (!last) return go(index + 1, true);
      // the chapter is done: a title card for the next one, then on into it
      const next = all[index + 1]!.chapter;
      const text = `Chapter ${next + first} · ${spec.chapters[next]!.title}`;
      setCard(text);
      if (talk) {
        const u = new SpeechSynthesisUtterance(spoken(text.replace(" · ", ". ")));
        u.rate = speed * RATE;
        if (pick_voice()) u.voice = pick_voice()!;
        window.speechSynthesis.speak(u);
      }
      timers.push(setTimeout(() => !cancelled && go(index + 1, true), CARD_MS / speed));
    };
    const beats = speech.length;
    const show = (i: number) => {
      if (cancelled) return;
      if (i >= beats) {
        // a longer breath between steps
        timers.push(setTimeout(advance, STEP_GAP_MS / speed));
        return;
      }
      setCue(i);
      if (talk) {
        const text = speech[i]!;
        const u = new SpeechSynthesisUtterance(text);
        u.rate = speed * RATE;
        const v = pick_voice();
        if (v) {
          u.voice = v;
          u.lang = v.lang;
        } else u.lang = "en-US";
        // the voice drives the pace; a watchdog moves on if it never reports the end
        let done = false;
        const next = () => {
          if (done) return;
          done = true;
          // a breath between sentences
          timers.push(setTimeout(() => show(i + 1), SENTENCE_GAP_MS / speed));
        };
        u.onstart = () => ambient.current?.duck(true);
        u.onend = () => {
          ambient.current?.duck(false);
          next();
        };
        u.onerror = () => {
          ambient.current?.duck(false);
          next();
        };
        timers.push(setTimeout(next, (3000 + text.length * 110) / speed));
        window.speechSynthesis.speak(u);
      } else timers.push(setTimeout(() => show(i + 1), Math.max(1800, speech[i]!.length * 55) / speed));
    };
    timers.push(setTimeout(() => show(0), (reduce ? 0 : total + LAND_MS) / speed));
    return () => {
      cancelled = true;
      for (const t of timers) clearTimeout(t);
      if (voice) window.speechSynthesis.cancel();
    };
  }, [playing, index, all, frame.chapter, lines, speech, total, reduce, go, voice, sound, muted, speed, pick_voice, spec, first]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (menu_ref.current && !menu_ref.current.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menu]);

  // the music plays only while the tour plays, and the sound toggle silences it with the voice
  useEffect(() => {
    const a = ambient.current;
    if (!a) return;
    if (playing && music && sound && !muted) a.start();
    else a.stop();
  }, [playing, music, sound, muted]);
  useEffect(() => ambient.current?.volume(music_level), [music_level]);
  useEffect(() => () => ambient.current?.stop(), []);

  const play = () => {
    // the first Play is the gesture that lets the page make sound
    if (!ambient.current && typeof AudioContext !== "undefined") ambient.current = new Ambient();
    // start (and resume) the music inside the click itself, where the browser allows it
    if (!playing && music) ambient.current?.start();
    if (!playing && !muted) setSound(true);
    setPlaying((p) => !p);
  };

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
      play();
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
  const root_w = box.current?.clientWidth ?? 800;
  const tip_w = Math.min(600, root_w - 16);
  // a beat of speech shows the caption sentence it belongs to
  const caption = lines[Math.min(lines.length - 1, Math.floor((Math.max(0, cue) * lines.length) / Math.max(1, speech.length)))];
  const ui = (key: string) => (pointing.has(key) ? styles.pointing : "");

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the player takes the arrow keys and space
    <div ref={box} className={styles.tour} data-mode={fit.mode} onKeyDown={onKey} tabIndex={-1}>
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
              focus={lit ? [...lit.streams] : undefined}
              onHover={setHover}
            />
          </div>
        ))}
        {sel && <Inspector cell={sel} onClose={() => setSelected(undefined)} />}
        {card && (
          <div className={styles.card} role="status">
            {card}
          </div>
        )}
        <div className={styles.captions} aria-live="polite">
          {cc && caption && <p key={`${index}-${caption}`}>{plain(caption)}</p>}
        </div>
      </div>

      <div className={styles.bar}>
        {/* the whole tour's progress, one segment per chapter */}
        <div className={styles.progress} aria-hidden>
          {spec.chapters.map((c, i) => {
            const fs = all.filter((f) => f.chapter === i);
            const at = i < frame.chapter ? 1 : i > frame.chapter ? 0 : (index - frame.chapter_start + 1) / fs.length;
            return (
              <span key={c.id} style={{ flexGrow: fs.length }} data-now={i === frame.chapter || undefined}>
                <i style={{ width: `${at * 100}%` }} />
              </span>
            );
          })}
        </div>
        <div className={styles.menuWrap} ref={menu_ref}>
          <button
            type="button"
            className={`${styles.menuButton} ${ui("menu")}`}
            onClick={() => setMenu((m) => !m)}
            aria-expanded={menu}
            aria-haspopup="menu"
          >
            <span className={styles.menuLabel}>
              Chapter {frame.chapter + first} of {spec.chapters.length - 1 + first}
            </span>
            <span className={styles.menuTitle}> · {chapter.title}</span>
            <span className={styles.menuStep}>
              {" "}
              · step {index - frame.chapter_start + 1}/{chapterFrames.length}
            </span>
            <span aria-hidden> ▴</span>
          </button>
          {menu && (
            <ol className={styles.menu} data-mode={fit.mode}>
              {spec.chapters.map((c, i) => (
                <li key={c.id}>
                  <button
                    type="button"
                    className={i === frame.chapter ? styles.current : ""}
                    aria-current={i === frame.chapter ? "step" : undefined}
                    ref={(el) => {
                      if (el && i === frame.chapter) el.scrollIntoView({ block: "nearest" });
                    }}
                    onClick={() => go(all.findIndex((f) => f.chapter === i))}
                  >
                    <span className={styles.num}>{i + first}</span>
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
        <div className={styles.transport}>
          <button type="button" onClick={() => go(index - 1)} disabled={atStart} aria-label="Previous step">
            ‹
          </button>
          <button type="button" className={`${styles.play} ${ui("play")}`} onClick={play} aria-label={playing ? "Pause" : "Play"}>
            {playing ? "❚❚" : "▶"}
          </button>
          <button type="button" onClick={() => go(index + 1)} disabled={atEnd} aria-label="Next step">
            ›
          </button>
        </div>
        <div className={styles.toggles}>
          <select className={ui("speed")} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Speed">
            <option value={0.75}>0.75×</option>
            <option value={1}>1×</option>
            <option value={1.25}>1.25×</option>
          </select>
          <button type="button" onClick={fullscreen} aria-label="Full screen" title="Full screen">
            ⛶
          </button>
        </div>
      </div>

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
