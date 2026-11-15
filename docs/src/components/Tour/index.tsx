/**
 * The framework tour player. It plays a TourSpec: chapters of scenes of steps,
 * each step a line of narration, tokens that travel between the app's nodes
 * and the store, and ops that change the world the stage draws. The event
 * store (one global log per store) stays in the middle of the stage the whole
 * time, so every operation reads as what it does to that log.
 *
 * Generic on purpose: everything about a domain lives in the spec. Colors come
 * from the `--dg-*` tokens in src/css/custom.css, shared with the Mermaid
 * diagrams and the sequence scenes. The server renders the first step, so the
 * page reads without JavaScript; motion is skipped for readers who prefer less.
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
import { type Box, data_lines, type Layout, layout, type Mode, short } from "./layout";
import styles from "./styles.module.css";
import type { Move, Step, TourSpec } from "./types";
import { type Cell, type Frame, frames as fold } from "./world";

export type { TourSpec } from "./types";

const MOVE_MS = 760;
const PALETTE = 8;

// useLayoutEffect warns on the server; the effect only matters in a browser
const useBrowserLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** `code` and **bold** in narration. */
function rich(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/).map((part, i) => {
    if (part.startsWith("`")) return <code key={i}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**")) return <b key={i}>{part.slice(2, -2)}</b>;
    return part;
  });
}

/** When each move starts, in ms after the step begins, and when the last ends. */
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

const dwell = (step: Step, total: number) => total + Math.max(2600, Math.min(7000, step.say.length * 42));

/** How wide the player is: narrow (a phone), wide, or xl (the narration moves beside the stage). */
type Fit = { mode: "narrow" | "wide" | "xl"; px: number };

function useFit(ref: React.RefObject<HTMLElement | null>): Fit {
  const [fit, setFit] = useState<Fit>({ mode: "wide", px: 1000 });
  useBrowserLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const px = el.clientWidth;
      setFit({ mode: px < 640 ? "narrow" : px >= 1500 ? "xl" : "wide", px });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return fit;
}

// the stage's width in SVG units: one unit per pixel when there is room, so a
// wider screen shows more of the log at the same text size
const RAIL = 238;
const SIDE = 458;
function stage_units(fit: Fit): number {
  if (fit.mode === "narrow") return 420;
  const px = fit.px - RAIL - (fit.mode === "xl" ? SIDE : 0) - 4;
  return Math.max(960, Math.min(1700, px));
}

function Tokens({ moves, lay, run, reduce }: { moves: Move[]; lay: Layout; run: number; reduce: boolean }) {
  const refs = useRef<(SVGGElement | null)[]>([]);
  useEffect(() => {
    if (reduce) return;
    const { starts } = schedule(moves);
    const anims: Animation[] = [];
    moves.forEach((m, i) => {
      const el = refs.current[i];
      const a = lay.anchor(m.from);
      const b = lay.anchor(m.to);
      if (!el || !a || !b) return;
      // a gentle arc: sample a quadratic curve bowed to one side
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const bow = Math.min(60, len * 0.18);
      const cx = mx - (dy / len) * bow;
      const cy = my + (dx / len) * bow;
      const frames: Keyframe[] = [];
      for (let k = 0; k <= 16; k++) {
        const t = k / 16;
        const x = (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * cx + t * t * b.x;
        const y = (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * cy + t * t * b.y;
        frames.push({ transform: `translate(${x}px, ${y}px)`, opacity: k === 0 ? 0 : k === 16 ? 0.2 : 1 });
      }
      anims.push(
        el.animate(frames, {
          duration: MOVE_MS,
          delay: starts[i],
          easing: "cubic-bezier(.45,.05,.35,1)",
          fill: "both",
        })
      );
    });
    return () => anims.forEach((x) => x.cancel());
    // a new run restarts the tokens even when the step is the same
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

function stream_colors(all: Frame[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const f of all) for (const s of f.world.stores) for (const c of s.cells) if (!map.has(c.stream)) map.set(c.stream, map.size % PALETTE);
  return map;
}

function trim(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function CellView({
  cell,
  box,
  color,
  flag,
  dim,
  selected,
  onSelect,
}: {
  cell: Cell;
  box: Box;
  color: number;
  flag?: { text: string; tone?: string };
  dim: boolean;
  selected: boolean;
  onSelect: (uid: number) => void;
}) {
  const state = cell.leaving ? styles.leaving : cell.fresh ? styles.fresh : cell.moved ? styles.moved : "";
  const label = cell.kind === "event" ? cell.name : cell.kind === "snapshot" ? "◆ snapshot" : "⊘ tombstone";
  return (
    <g className={styles.cellPos} style={{ transform: `translate(${box.x}px, ${box.y}px)` }}>
      <g
        className={`${styles.cell} ${state} ${dim ? styles.dim : ""} ${selected ? styles.selected : ""}`}
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
        <text x={11} y={15} className={styles.cellId}>
          #{cell.id}
        </text>
        <text x={box.w - 6} y={15} className={styles.cellVer}>
          v{cell.version}
        </text>
        <text x={11} y={32} className={styles.cellName}>
          {trim(label, 12)}
        </text>
        <text x={11} y={47} className={styles.cellStream}>
          {trim(cell.stream, 14)}
        </text>
        {cell.pii && (
          <text x={box.w - 6} y={47} className={`${styles.pii} ${cell.shredded ? styles.shredded : ""}`}>
            {cell.shredded ? "pii ✕" : "pii 🔒"}
          </text>
        )}
      </g>
      {flag && (
        <g className={styles.flag} data-tone={flag.tone}>
          <rect x={-2} y={-15} width={Math.min(box.w + 50, flag.text.length * 6.4 + 12)} height={15} rx={7} />
          <text x={4} y={-4}>
            {flag.text}
          </text>
        </g>
      )}
    </g>
  );
}

function Stage({
  lay,
  frame,
  colors,
  moves,
  run,
  reduce,
  enter,
  focus,
  selected,
  onSelect,
}: {
  lay: Layout;
  frame: Frame;
  colors: Map<string, number>;
  moves: Move[];
  run: number;
  reduce: boolean;
  enter: number;
  focus: Set<string>;
  selected?: number;
  onSelect: (uid: number) => void;
}) {
  const w = frame.world;
  const focused = (id: string) => focus.has(id);
  return (
    <svg
      viewBox={`0 0 ${lay.width} ${lay.height}`}
      className={styles.svg}
      style={{ "--enter": `${enter}ms` } as CSSProperties}
      role="img"
      aria-label="The stage: the app above, the event store in the middle, streams and reaction targets below"
    >
      <defs>
        <marker id="tour-tick" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6">
          <path d="M0,10 L5,0 L10,10 z" />
        </marker>
      </defs>
      {/* the app band */}
      {lay.nodes.map(({ node, box, lines }) => {
        const st = w.states[node.id];
        return (
          <g
            key={node.id}
            className={`${styles.node} ${focused(node.id) ? styles.focus : ""}`}
            data-kind={node.kind}
          >
            <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={10} />
            <text x={box.x + box.w / 2} y={box.y + (node.sub ? 19 : 27)} className={styles.nodeLabel}>
              {trim(node.label, Math.floor(box.w / 7.4))}
            </text>
            {node.sub && (
              <text x={box.x + box.w / 2} y={box.y + 34} className={styles.nodeSub}>
                {trim(node.sub, Math.floor(box.w / 6))}
              </text>
            )}
            {lines.length > 0 && (
              <g className={`${styles.stateCard} ${st?.fresh ? styles.fresh : ""}`}>
                <rect x={box.x + 4} y={box.y + box.h + 4} width={box.w - 8} height={lines.length * 15 + 10} rx={6} />
                {lines.map((l, i) => (
                  <text key={i} x={box.x + 12} y={box.y + box.h + 19 + i * 15}>
                    {trim(l, Math.floor((box.w - 20) / 6.3) - (i === 0 && st?.version !== undefined ? 4 : 0))}
                  </text>
                ))}
                {st?.version !== undefined && (
                  <text x={box.x + box.w - 10} y={box.y + box.h + 19} className={styles.stateVer}>
                    v{st.version}
                  </text>
                )}
              </g>
            )}
          </g>
        );
      })}

      {/* the stores: the log in the middle of everything */}
      {lay.stores.map((sb) => {
        const s = sb.store;
        // one bracket per commit, drawn once per row it spans
        const commits = new Map<number, { box: Box; cell: Cell; row: number }[]>();
        sb.cells.forEach((c, i) => {
          if (c.cell.fresh && c.cell.bracket && c.cell.commit !== undefined)
            commits.set(c.cell.commit, [...(commits.get(c.cell.commit) ?? []), { ...c, row: Math.floor(i / sb.per_row) }]);
        });
        const checkpoint = sb.cells.find((c) => c.cell.uid === s.checkpoint);
        const ticks = new Map<number, string[]>();
        for (const t of w.targets)
          if (t.store === s.name && t.at >= 0) ticks.set(t.at, [...(ticks.get(t.at) ?? []), t.id]);
        return (
          <g key={s.name} className={styles.store} data-tone={s.status?.tone}>
            <rect x={sb.x} y={sb.y} width={sb.w} height={sb.h} rx={12} className={styles.storeBox} />
            <text x={sb.x + 12} y={sb.y + 19} className={styles.storeTitle}>
              Event store
              <tspan className={styles.storeSub}> · {s.label} · the all stream</tspan>
            </text>
            {s.status && (
              <text x={sb.x + sb.w - 12} y={sb.y + 19} className={styles.storeStatus} data-tone={s.status.tone}>
                {s.status.text}
              </text>
            )}
            {!sb.cells.length && !s.ghost && (
              <text x={sb.tail.x + 4} y={sb.tail.y + sb.tail.h / 2 + 4} className={styles.empty}>
                empty
              </text>
            )}
            {[...commits.entries()].map(([key, cells]) => {
              const streams = new Set(cells.map((c) => c.cell.stream)).size;
              const label = `${cells[0]!.cell.bracket} · ${cells.length} event${cells.length > 1 ? "s" : ""} · ${streams} stream${streams > 1 ? "s" : ""}`;
              const rows = [...new Set(cells.map((c) => c.row))];
              return (
                <g key={key} className={`${styles.bracket} ${styles.fresh}`}>
                  {rows.map((row, r) => {
                    const seg = cells.filter((c) => c.row === row);
                    const first = seg[0]!.box;
                    const last = seg[seg.length - 1]!.box;
                    const end = first.x > lay.width / 2;
                    return (
                      <g key={row}>
                        <rect x={first.x - 4} y={first.y - 4} width={last.x + last.w - first.x + 8} height={first.h + 8} rx={10} />
                        {r === 0 && (
                          <text
                            x={end ? last.x + last.w : first.x}
                            y={first.y + first.h + 15}
                            style={{ textAnchor: end ? "end" : "start" }}
                          >
                            {label}
                          </text>
                        )}
                      </g>
                    );
                  })}
                </g>
              );
            })}
            {sb.cells.map(({ cell, box }) => (
              <CellView
                key={cell.uid}
                cell={cell}
                box={box}
                color={colors.get(cell.stream) ?? 0}
                flag={cell.ref && w.refs[cell.ref] === cell.uid ? w.flags[`cell:${cell.ref}`] : undefined}
                dim={(s.dim_from !== undefined && cell.id >= s.dim_from) || (s.only !== undefined && cell.stream !== s.only)}
                selected={selected === cell.uid}
                onSelect={onSelect}
              />
            ))}
            {s.ghost && (
              <g className={`${styles.ghost} ${styles.fresh}`} style={{ transform: `translate(${sb.tail.x}px, ${sb.tail.y}px)` }}>
                <rect width={sb.tail.w} height={sb.tail.h} rx={7} />
                <text x={8} y={15} className={styles.cellId}>
                  refused
                </text>
                <text x={8} y={32} className={styles.cellName}>
                  {trim(s.ghost.name, 13)}
                </text>
                <text x={8} y={47} className={styles.ghostError}>
                  {trim(s.ghost.error, 15)}
                </text>
              </g>
            )}
            {checkpoint && (
              <g
                className={styles.checkpoint}
                style={{ transform: `translate(${checkpoint.box.x + checkpoint.box.w}px, ${checkpoint.box.y}px)` }}
              >
                <line x1={4} x2={4} y1={-12} y2={checkpoint.box.h + 4} />
                <text x={-2} y={-4}>
                  checkpoint
                </text>
              </g>
            )}
            {sb.cells.map(({ cell, box }) => {
              const ids = ticks.get(cell.uid);
              if (!ids) return null;
              return (
                <g
                  key={`tick-${cell.uid}`}
                  className={styles.tick}
                  style={{ transform: `translate(${box.x + box.w - 6}px, ${box.y + box.h + 2}px)` }}
                >
                  <path d="M0,0 l5,8 h-10 z" />
                  <text x={-8} y={12}>
                    {trim(ids.join(", "), 22)}
                  </text>
                </g>
              );
            })}
          </g>
        );
      })}

      {/* streams, folded from the log */}
      <g className={styles.section}>
        <text x={lay.streams.box.x} y={lay.streams.box.y + 16} className={styles.sectionTitle}>
          Streams <tspan className={styles.storeSub}>· each folds its own events · head version</tspan>
        </text>
        {lay.streams.rows.map((r) => (
          <g key={`${r.store}-${r.stream}`} className={styles.streamRow} data-color={colors.get(r.stream) ?? 0}>
            <rect className={styles.dot} x={r.box.x} y={r.box.y + 6} width={10} height={10} rx={3} />
            <text x={r.box.x + 16} y={r.box.y + 15}>
              {trim(r.stream, 22)}
              {lay.stores.length > 1 && <tspan className={styles.muted}> ({r.store})</tspan>}
            </text>
            <text x={r.box.x + r.box.w} y={r.box.y + 15} className={styles.right}>
              v{r.head} · {r.count} event{r.count > 1 ? "s" : ""}
            </text>
          </g>
        ))}
        {!lay.streams.rows.length && (
          <text x={lay.streams.box.x} y={lay.streams.box.y + 42} className={styles.muted}>
            no streams yet
          </text>
        )}
      </g>

      {/* reaction targets: watermark, lease, retries, schedules */}
      <g className={styles.section}>
        <text x={lay.targets.box.x} y={lay.targets.box.y + 16} className={styles.sectionTitle}>
          Reaction targets <tspan className={styles.storeSub}>· watermark · lease · schedule</tspan>
        </text>
        {lay.targets.rows.map(({ target: t, box }) => {
          const at = t.at < 0 ? "−1" : `#${w.stores.flatMap((s) => s.cells).find((c) => c.uid === t.at)?.id ?? "?"}`;
          const status = t.blocked
            ? `⛔ ${t.blocked}`
            : t.due
              ? `⏱ ${t.due}${t.retry ? ` · retry ${t.retry}` : ""}`
              : t.lease
                ? `leased by ${t.lease}`
                : t.retry
                  ? `retry ${t.retry}`
                  : "";
          const flag = w.flags[`target:${t.id}`];
          // the row is one line of monospace text: share it between the name and the status
          const room = Math.floor(box.w / 6.7);
          const lane = t.lane !== "default" ? ` [${t.lane}]` : "";
          const right = `at ${at}`.length + 3;
          const name_max = Math.min(26, room - lane.length - right - 12);
          const status_max = Math.max(8, room - Math.min(t.id.length, name_max) - lane.length - right - (flag ? flag.text.length + 3 : 0) - 2);
          return (
            <g
              key={t.id}
              className={`${styles.targetRow} ${t.fresh ? styles.fresh : ""} ${focused(`target:${t.id}`) ? styles.focus : ""}`}
              data-state={t.blocked ? "blocked" : t.due ? "due" : t.lease ? "leased" : "idle"}
            >
              <rect x={box.x - 4} y={box.y + 1} width={box.w + 4} height={box.h - 2} rx={5} className={styles.rowBg} />
              <text x={box.x + 2} y={box.y + 15}>
                {trim(t.id, name_max)}
                {lane && <tspan className={styles.lane}>{lane}</tspan>}
                {t.priority !== undefined && <tspan className={styles.muted}> p{t.priority}</tspan>}
              </text>
              <text x={box.x + box.w - 6} y={box.y + 15} className={styles.right}>
                {flag ? <tspan className={styles.flagText}>{flag.text} · </tspan> : null}
                {status ? <tspan className={styles.status}>{trim(status, status_max)} · </tspan> : null}
                at {at}
              </text>
            </g>
          );
        })}
        {!lay.targets.rows.length && (
          <text x={lay.targets.box.x} y={lay.targets.box.y + 42} className={styles.muted}>
            no reactions yet
          </text>
        )}
      </g>

      {/* read models */}
      {lay.tables.map(({ table, box }) => (
        <g key={table.name} className={styles.table}>
          <rect x={box.x - 6} y={box.y} width={box.w + 6} height={box.h} rx={10} />
          <text x={box.x + 4} y={box.y + 17} className={styles.sectionTitle}>
            {table.title}
          </text>
          {table.rows.map(([key, values], i) => (
            <text
              key={key}
              x={box.x + 4}
              y={box.y + 26 + 15 + i * 22}
              className={table.fresh.includes(key) ? styles.fresh : ""}
            >
              <tspan className={styles.rowKey}>{trim(key, 14)}</tspan>
              <tspan dx={8}>{trim(data_lines(values, 4).join("  "), Math.floor(box.w / 6.6) - 16)}</tspan>
            </text>
          ))}
          {!table.rows.length && (
            <text x={box.x + 4} y={box.y + 41} className={styles.muted}>
              no rows
            </text>
          )}
        </g>
      ))}

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

export default function Tour({ spec }: { spec: TourSpec }) {
  const all = useMemo(() => fold(spec), [spec]);
  const colors = useMemo(() => stream_colors(all), [all]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [run, setRun] = useState(0);
  const [reduce, setReduce] = useState(true);
  const [selected, setSelected] = useState<number | undefined>();
  const box = useRef<HTMLDivElement>(null);
  const fit = useFit(box);
  const mode: Mode = fit.mode === "narrow" ? "narrow" : "wide";
  const units = stage_units(fit);

  const frame = all[index]!;
  const chapter = spec.chapters[frame.chapter]!;
  const scene = chapter.scenes[frame.scene]!;
  const step = scene.steps[frame.step]!;
  const moves = step.moves ?? [];
  const { total } = schedule(moves);
  const lay = useMemo(() => layout(mode, scene.nodes, frame.world, units), [mode, scene.nodes, frame.world, units]);
  const code = useMemo(() => {
    let c = scene.code;
    for (let i = 0; i <= frame.step; i++) c = scene.steps[i]!.code ?? c;
    return c;
  }, [scene, frame.step]);
  const focus = useMemo(() => new Set(step.focus ?? []), [step]);
  const sel = selected === undefined ? undefined : frame.world.stores.flatMap((s) => s.cells).find((c) => c.uid === selected);

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
      setIndex(next);
      setRun((r) => r + 1);
      const ch = spec.chapters[all[next]!.chapter]!;
      if (typeof window !== "undefined" && window.location.hash !== `#${ch.id}`)
        window.history.replaceState(null, "", `#${ch.id}`);
    },
    [all, spec]
  );

  useEffect(() => {
    if (!playing) return;
    const last = index >= all.length - 1 || all[index + 1]!.chapter !== frame.chapter;
    const t = setTimeout(
      () => {
        if (last) setPlaying(false);
        else go(index + 1, true);
      },
      dwell(step, reduce ? 0 : total)
    );
    return () => clearTimeout(t);
  }, [playing, index, all, frame.chapter, step, total, reduce, go]);

  const onKey = (e: KeyboardEvent) => {
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

  return (
    <div
      ref={box}
      className={styles.tour}
      data-mode={fit.mode}
      onKeyDown={onKey}
      // the stage takes the arrow keys and space when it has focus
      tabIndex={-1}
    >
      <nav className={styles.chapters} aria-label="Chapters">
        {mode !== "narrow" ? (
          <ol>
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
        ) : (
          <select
            value={frame.chapter}
            aria-label="Chapter"
            onChange={(e) => go(all.findIndex((f) => f.chapter === Number(e.target.value)))}
          >
            {spec.chapters.map((c, i) => (
              <option key={c.id} value={i}>
                {i + 1}. {c.title}
              </option>
            ))}
          </select>
        )}
      </nav>

      <div className={styles.main}>
        <header className={styles.head}>
          <div>
            <span className={styles.audience}>{chapter.audience}</span>
            <h2>
              {frame.chapter + 1}. {chapter.title}
            </h2>
            <p>{chapter.blurb}</p>
          </div>
          <button type="button" className={styles.full} onClick={fullscreen} aria-label="Full screen">
            ⛶
          </button>
        </header>

        <div className={styles.body}>
        <div className={styles.stageCol}>
        <div className={styles.stageWrap}>
          <Stage
            lay={lay}
            frame={frame}
            colors={colors}
            moves={moves}
            run={run}
            reduce={reduce}
            enter={reduce ? 0 : total}
            focus={focus}
            selected={sel?.uid}
            onSelect={(uid) => setSelected((s) => (s === uid ? undefined : uid))}
          />
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
          <div className={styles.progress} aria-label="Steps in this chapter">
            {chapterFrames.map((f) => {
              const i = all.indexOf(f);
              return (
                <button
                  key={i}
                  type="button"
                  className={`${i === index ? styles.on : i < index ? styles.past : ""} ${f.step === 0 ? styles.sceneStart : ""}`}
                  onClick={() => go(i)}
                  aria-label={`Scene ${f.scene + 1}, step ${f.step + 1}`}
                />
              );
            })}
          </div>
          <span className={styles.count}>
            {index - frame.chapter_start + 1} / {chapterFrames.length}
          </span>
        </div>
        </div>

        <div className={styles.side}>
        <section className={styles.narration} aria-live="polite">
          <h3>
            {scene.title}
            <span>
              {" "}
              · scene {frame.scene + 1} of {chapter.scenes.length}
            </span>
          </h3>
          <p className={styles.say}>{rich(step.say)}</p>
          {step.checks && (
            <ol className={styles.checks} aria-label="What the action checks">
              {step.checks.map((c) => (
                <li key={c.label} data-state={c.state}>
                  <span>{c.state === "ok" ? "✓" : c.state === "fail" ? "✕" : c.state === "skip" ? "–" : "·"}</span>
                  {c.label}
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className={styles.reference}>
          {code && (
            <div className={styles.code}>
              <CodeBlock language="ts">{code}</CodeBlock>
            </div>
          )}
          <div className={styles.links}>
            {scene.api && (
              <p className={styles.api}>
                {scene.api.map((a) => (
                  <code key={a}>{a}</code>
                ))}
              </p>
            )}
            {scene.doc && (
              <p>
                Read: <Link to={scene.doc.href}>{scene.doc.label}</Link>
              </p>
            )}
            {scene.test && (
              <p>
                Proven by: <Link href={scene.test.href}>{scene.test.label}</Link>
              </p>
            )}
            <p className={styles.hint}>Tip: click an event in the log to see its metadata. Arrow keys step, space plays.</p>
          </div>
        </section>
        </div>
        </div>
      </div>
    </div>
  );
}
