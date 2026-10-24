/**
 * An animated sequence diagram for the docs: participants across the top, and
 * steps that draw themselves one at a time. Messages in one step travel
 * together, which is the point of these scenes: two workers claiming at the
 * same moment, two callers racing for one stream version.
 *
 * The server renders the finished diagram, so it reads without JavaScript.
 * In the browser it rewinds and plays once when scrolled into view, unless the
 * reader prefers reduced motion. Colors come from the `--dg-*` tokens in
 * src/css/custom.css, shared with the Mermaid diagrams.
 */
import { type CSSProperties, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import styles from "./styles.module.css";

export type Kind =
  | "actor"
  | "action"
  | "state"
  | "event"
  | "projection"
  | "reaction"
  | "external"
  | "store";

export type Tone = "good" | "bad" | "muted";

export type Participant = { id: string; label: string; kind: Kind };

/** An arrow from one participant to another; `tone` colors a verdict. */
export type Message = { from: string; to: string; label: string; tone?: Tone };

/** A box under one participant, or centered across two (`at: [a, b]`). Lines split on `\n`. */
export type Note = { at: string | [string, string]; text: string; tone?: Tone };

/** What happens at once: its messages travel together, its notes appear together. */
export type Step = { say: string; messages?: Message[]; notes?: Note[] };

export type SceneSpec = { title: string; participants: Participant[]; steps: Step[] };

const COL = 168;
const PAD = 12;
const HEAD = 40;
const GAP = 14;
const MSG_H = 36;
const LINE_H = 16;
const NOTE_PAD = 9;
const CHAR_W = 6.7;

type Row =
  | { kind: "message"; step: number; y: number; message: Message }
  | { kind: "note"; step: number; y: number; h: number; note: Note };

function layout(spec: SceneSpec) {
  const index = new Map(spec.participants.map((p, i) => [p.id, i]));
  const x = (id: string) => {
    const i = index.get(id);
    if (i === undefined) throw new Error(`scene "${spec.title}": unknown participant ${id}`);
    return PAD + COL * i + COL / 2;
  };
  const rows: Row[] = [];
  let y = HEAD + GAP;
  spec.steps.forEach((step, s) => {
    for (const message of step.messages ?? []) {
      rows.push({ kind: "message", step: s, y, message });
      y += MSG_H;
    }
    // a step's notes share one row, each under its own participant
    const notes = step.notes ?? [];
    if (notes.length) {
      const h = Math.max(...notes.map((n) => n.text.split("\n").length)) * LINE_H + NOTE_PAD * 2;
      for (const note of notes) rows.push({ kind: "note", step: s, y, h, note });
      y += h + GAP;
    }
  });
  return { x, rows, width: PAD * 2 + COL * spec.participants.length, height: y + GAP };
}

/** `code` spans in captions. */
function say(text: string): ReactNode[] {
  return text.split(/(`[^`]+`)/).map((part, i) =>
    part.startsWith("`") ? <code key={i}>{part.slice(1, -1)}</code> : part
  );
}

const dwell = (step: Step) => Math.min(4200, 1300 + step.say.length * 22);

export default function Scene({ scene }: { scene: SceneSpec }) {
  const { x, rows, width, height } = layout(scene);
  const total = scene.steps.length;
  // steps shown; `total` is the finished diagram the server renders
  const [shown, setShown] = useState(total);
  const [playing, setPlaying] = useState(false);
  const [animate, setAnimate] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setAnimate(!reduce);
    if (reduce || !box.current) return;
    setShown(0);
    const seen = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        seen.disconnect();
        setPlaying(true);
      },
      { threshold: 0.35 }
    );
    seen.observe(box.current);
    return () => seen.disconnect();
  }, []);

  useEffect(() => {
    if (!playing) return;
    if (shown >= total) return setPlaying(false);
    const t = setTimeout(() => setShown((s) => s + 1), shown === 0 ? 300 : dwell(scene.steps[shown - 1]!));
    return () => clearTimeout(t);
  }, [playing, shown, total, scene.steps]);

  const play = useCallback(() => {
    if (shown >= total) setShown(0);
    setPlaying((p) => !p);
  }, [shown, total]);
  const go = (to: number) => {
    setPlaying(false);
    setShown(Math.max(0, Math.min(total, to)));
  };

  const current = shown - 1;
  const done = shown >= total;
  const caption =
    shown === 0 ? (
      <>
        <b>{scene.title}.</b> Press play to watch it happen.
      </>
    ) : (
      say(scene.steps[current]!.say)
    );

  return (
    <figure ref={box} className={styles.scene} aria-label={scene.title}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className={styles.svg}
        role="img"
        aria-label={`${scene.title}: ${scene.steps.map((s) => s.say).join(" ")}`}
      >
        {scene.participants.map((p) => (
          <g key={p.id} className={styles.participant} data-kind={p.kind}>
            <line x1={x(p.id)} x2={x(p.id)} y1={HEAD} y2={height - GAP / 2} className={styles.life} />
            <rect x={x(p.id) - COL / 2 + 8} y={2} width={COL - 16} height={HEAD - 6} rx={9} />
            <text x={x(p.id)} y={HEAD / 2 + 3}>
              {p.label}
            </text>
          </g>
        ))}
        {rows.map((row, i) => {
          if (row.step >= shown) return null;
          const state = !animate || done ? "" : row.step === current ? styles.now : styles.past;
          if (row.kind === "message") {
            const { from, to, label, tone } = row.message;
            const x1 = x(from);
            const x2 = x(to);
            const dir = Math.sign(x2 - x1);
            const end = x2 - dir * 2;
            const ay = row.y + 20;
            return (
              <g key={i} className={`${styles.message} ${state}`} data-tone={tone}>
                <text x={(x1 + x2) / 2} y={row.y + 12}>
                  {label}
                </text>
                <line x1={x1} x2={end - dir * 7} y1={ay} y2={ay} pathLength={1} />
                <path d={`M${end},${ay} l${-dir * 9},-4.5 v9 z`} className={styles.head} />
                {animate && row.step === current && (
                  <circle cx={x1} cy={ay} r={5} className={styles.token} style={{ "--dx": `${end - x1}px` } as CSSProperties} />
                )}
              </g>
            );
          }
          const { at, text, tone } = row.note;
          const [a, b] = Array.isArray(at) ? at : [at, at];
          const lines = text.split("\n");
          const left = Math.min(x(a), x(b)) - COL / 2 + 6;
          const w = Math.abs(x(b) - x(a)) + COL - 12;
          const wide = Math.max(...lines.map((l) => l.length)) * CHAR_W + 2 * NOTE_PAD;
          const nw = Math.min(w, Math.max(wide, 60));
          const nx = left + (w - nw) / 2;
          return (
            <g key={i} className={`${styles.note} ${state}`} data-tone={tone}>
              <rect x={nx} y={row.y} width={nw} height={row.h} rx={7} />
              <text x={nx + nw / 2} y={row.y + NOTE_PAD + 11}>
                {lines.map((l, j) => (
                  <tspan key={j} x={nx + nw / 2} dy={j ? LINE_H : 0}>
                    {l}
                  </tspan>
                ))}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className={styles.caption}>
        <div className={styles.controls}>
          <button type="button" onClick={() => go(shown - 1)} aria-label="Previous step" disabled={shown === 0}>
            ‹
          </button>
          <button type="button" onClick={play} className={styles.play}>
            {playing ? "Pause" : done ? "Replay" : "Play"}
          </button>
          <button type="button" onClick={() => go(shown + 1)} aria-label="Next step" disabled={done}>
            ›
          </button>
          <span className={styles.count}>
            {shown} / {total}
          </span>
        </div>
        <p className={styles.say} aria-live="polite">
          {caption}
        </p>
      </figcaption>
    </figure>
  );
}
