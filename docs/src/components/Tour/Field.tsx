/**
 * The store at scale: every event in the store as one dot, in global id order,
 * wrapping like text. One neutral tone: snapshots are rings, tombstones caps, sensitive
 * events carry a lock. A step animates from the previous store: new events
 * drop in at the tail, deleted ones lift out (into the archive bin when a
 * close archived them), a restore slides every dot to its new id, a scan
 * sweeps a cursor along the log. Drawn on a canvas, so thousands stay smooth.
 */
import { useEffect, useRef, useState } from "react";
import styles from "./styles.module.css";
import { B_ARCHIVED, B_FRESH, B_LEAVING, B_SHREDDED, type BaseEvent, type Store } from "./world";

type Dot = {
  key: string;
  id: number;
  from?: number;
  stream: string;
  name: string;
  version: number;
  kind: "event" | "snapshot" | "tombstone";
  pii: boolean;
  shredded: boolean;
  fresh: boolean;
  leaving: boolean;
  archived: boolean;
  tour: boolean;
};

function dots_of(store: Store, base: BaseEvent[]): Dot[] {
  const out: Dot[] = [];
  const b = store.bulk as Store["bulk"] & { from?: number[] };
  b.idx.forEach((ix, i) => {
    const e = base[ix]!;
    const f = b.st[i]!;
    out.push({
      key: `b${ix}`,
      id: b.id[i]!,
      ...(b.from && { from: b.from[i] }),
      stream: e.stream,
      name: e.name,
      version: e.version,
      kind: e.kind,
      pii: e.pii,
      shredded: !!(f & B_SHREDDED),
      fresh: !!(f & B_FRESH),
      leaving: !!(f & B_LEAVING),
      archived: !!(f & B_ARCHIVED),
      tour: false,
    });
  });
  for (const c of store.cells)
    out.push({
      key: `c${c.uid}`,
      id: c.id,
      ...(c.from_id !== undefined && { from: c.from_id }),
      stream: c.stream,
      name: c.name,
      version: c.version,
      kind: c.kind,
      pii: !!c.pii,
      shredded: !!c.shredded,
      fresh: !!c.fresh,
      leaving: !!c.leaving,
      archived: false,
      tour: true,
    });
  return out;
}

/** Each stream's own hue, stable across steps: the field shades a stream by it. */
export function stream_hue(stream: string): number {
  let h = 2166136261;
  for (let i = 0; i < stream.length; i++) h = Math.imul(h ^ stream.charCodeAt(i), 16777619);
  return (h >>> 0) % 360;
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export default function Field({
  store,
  base,
  run,
  enter,
  reduce,
  hover,
  focus,
  onHover,
}: {
  store: Store;
  base: BaseEvent[];
  run: number;
  enter: number;
  reduce: boolean;
  hover?: string;
  /** the streams the current step acts on: lit in full color, the rest dimmed */
  focus?: string[];
  onHover: (stream: string | undefined) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | undefined>();
  const geo = useRef<{ pitch: number; cols: number; oy: number; dots: Map<number, Dot> }>({ pitch: 8, cols: 1, oy: 4, dots: new Map() });

  useEffect(() => {
    const el = canvas.current?.parentElement;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const cv = canvas.current;
    if (!cv || !size.w || !size.h) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(size.w * dpr);
    cv.height = Math.round(size.h * dpr);
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const css = getComputedStyle(cv);
    const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    const tomb = v("--dg-line", "#5d6574");
    const accent = v("--dg-action", "#2b5fd0");
    const reaction = v("--dg-reaction", "#7f4cc7");
    const text = v("--ifm-font-color-base", "#222");

    const dots = dots_of(store, base);
    const max_id = dots.reduce((m, d) => Math.max(m, d.id, d.from ?? 0), 0);
    const n = Math.max(64, max_id + 1);
    // a gutter on the left for the id of each labelled row
    const G = 40;
    const W = size.w - G - 6;
    const H = size.h - 8;
    // the largest pitch that fits every id in the box, kept small so it reads as one log
    let pitch = Math.min(18, Math.sqrt((W * H) / n));
    let cols = Math.max(1, Math.floor(W / pitch));
    while (Math.ceil(n / cols) * pitch > H && pitch > 2) {
      pitch -= 0.25;
      cols = Math.max(1, Math.floor(W / pitch));
    }
    const r = Math.max(0.9, pitch * 0.34);
    // a field taller than its dots need centers them, so a small log never hugs the top
    const oy = Math.max(4, (size.h - Math.ceil(n / cols) * pitch) / 2);
    const pos = (id: number) => ({ x: G + (id % cols) * pitch + pitch / 2, y: oy + Math.floor(id / cols) * pitch + pitch / 2 });
    const rows = Math.ceil(n / cols);
    const tick_every = Math.max(1, Math.ceil(18 / pitch));
    const bin = { x: size.w - 34, y: size.h - 22 };
    geo.current = { pitch, cols, oy, dots: new Map(dots.filter((d) => !d.leaving).map((d) => [d.id, d])) };
    const glow = new Map(store.glows.map((g) => [g.stream, g.worker]));
    const worker_list = [...new Set(store.glows.map((g) => g.worker))];
    const tour_ids = dots.filter((d) => d.tour && !d.leaving).map((d) => d.id);
    // one neutral tone for every dot; the scene's streams (or the hovered one) in one accent
    const neutral = v("--act-text-muted", "#7a8394");
    const lit = new Set(hover ? [hover] : (focus ?? []));

    const T = 900;
    const delay = reduce ? 0 : enter;
    const scan_ms = store.scan ? Math.max(1200, Math.min(2600, (store.scan.to - store.scan.from) * 2)) : 0;
    const total = reduce ? 0 : delay + Math.max(T, scan_ms) + 60;
    const start = performance.now();
    let raf = 0;

    const draw = (now: number) => {
      const t = reduce ? 1 : Math.max(0, Math.min(1, (now - start - delay) / T));
      const k = ease(t);
      const st = reduce || !store.scan ? 1 : Math.max(0, Math.min(1, (now - start - delay) / scan_ms));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size.w, size.h);

      // the id axis: the first id of every few rows
      ctx.fillStyle = v("--act-text-muted", "#6b7486");
      ctx.font = "9px ui-monospace, monospace";
      ctx.textAlign = "right";
      for (let row = 0; row < rows; row += tick_every) {
        const y = oy + row * pitch + pitch / 2 + 3;
        ctx.fillText(`#${(row * cols).toLocaleString("en-US")}`, G - 5, y);
      }
      ctx.textAlign = "left";

      // the lens: where the detailed cells below sit in the field
      if (tour_ids.length) {
        const lo = Math.min(...tour_ids);
        const hi = Math.max(...tour_ids);
        ctx.strokeStyle = accent;
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = 1.2;
        ctx.setLineDash([3, 2]);
        for (let row = Math.floor(lo / cols); row <= Math.floor(hi / cols); row++) {
          const a = Math.max(lo, row * cols);
          const b = Math.min(hi, row * cols + cols - 1);
          const pa = pos(a);
          const pb = pos(b);
          ctx.strokeRect(pa.x - pitch / 2, pa.y - pitch / 2, pb.x - pa.x + pitch, pitch);
        }
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }

      const scan_id = store.scan ? store.scan.from + (store.scan.to - store.scan.from) * st : -1;
      for (const d of dots) {
        let p = pos(d.id);
        let alpha = 1;
        let scale = 1;
        if (d.from !== undefined && d.from !== d.id && !d.leaving) {
          const a = pos(d.from);
          p = { x: a.x + (p.x - a.x) * k, y: a.y + (p.y - a.y) * k };
        }
        if (d.fresh && d.from === undefined) {
          alpha = k;
          scale = 0.4 + 0.6 * k;
          p = { x: p.x, y: p.y - (1 - k) * pitch * 3 };
        }
        if (d.leaving) {
          if (d.archived) {
            const a = pos(d.id);
            const lift = Math.sin(k * Math.PI) * 18;
            p = { x: a.x + (bin.x - a.x) * k, y: a.y + (bin.y - a.y) * k - lift };
            scale = 1 - 0.5 * k;
            alpha = 1 - 0.6 * k;
          } else {
            scale = 1 - 0.8 * k;
            alpha = 1 - k;
          }
          if (t >= 1) continue;
        }
        const g = glow.get(d.stream);
        const on = lit.has(d.stream) || !!g;
        // every stream in its own muted hue; the lit ones in full color, the rest dimmed
        const hue = stream_hue(d.stream);
        const dim = on ? 1 : lit.size || glow.size ? 0.25 : 0.7;
        const tone = d.kind === "event" || d.kind === "snapshot" ? (on ? `hsl(${hue} 72% 48%)` : `hsl(${hue} 26% 60%)`) : on ? accent : neutral;
        ctx.globalAlpha = alpha * dim;
        const rr = r * scale * (on ? 1.2 : 1);
        if (g) {
          // a worker's streams: a soft halo, filled for the first worker, ringed for the next
          const second = worker_list.indexOf(g) % 2 === 1;
          ctx.globalAlpha = 0.3;
          ctx.fillStyle = accent;
          ctx.strokeStyle = accent;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(p.x, p.y, rr * 2.2, 0, Math.PI * 2);
          if (second) ctx.stroke();
          else ctx.fill();
          ctx.globalAlpha = alpha * dim;
        } else if (on) {
          ctx.globalAlpha = 0.22 * alpha;
          ctx.fillStyle = tone;
          ctx.beginPath();
          ctx.arc(p.x, p.y, rr * 2, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = alpha * dim;
        }
        if (d.kind === "snapshot") {
          // a ring: the state, folded
          ctx.strokeStyle = tone;
          ctx.lineWidth = Math.max(0.9, rr * 0.45);
          ctx.beginPath();
          ctx.arc(p.x, p.y, rr * 1.05, 0, Math.PI * 2);
          ctx.stroke();
        } else if (d.kind === "tombstone") {
          // a cap: the stream is closed
          ctx.fillStyle = tone;
          ctx.fillRect(p.x - rr * 1.05, p.y - rr * 1.05, rr * 2.1, rr * 2.1);
          ctx.fillStyle = text;
          ctx.fillRect(p.x - rr * 1.05, p.y - rr * 1.05, rr * 2.1, Math.max(0.8, rr * 0.5));
        } else {
          ctx.fillStyle = tone;
          ctx.beginPath();
          ctx.arc(p.x, p.y, rr, 0, Math.PI * 2);
          ctx.fill();
          if (d.pii) {
            // a small mark in the dot: its sensitive fields sit in the pii column
            ctx.fillStyle = v("--act-surface-1", "#fff");
            if (d.shredded) ctx.fillRect(p.x - rr * 0.8, p.y - rr * 0.15, rr * 1.6, Math.max(0.8, rr * 0.3));
            else {
              ctx.beginPath();
              ctx.arc(p.x, p.y, rr * 0.45, 0, Math.PI * 2);
              ctx.fill();
            }
          }
        }
        // the dots a scan has passed brighten for a moment
        if (store.scan && d.id <= scan_id && d.id > store.scan.from && st < 1) {
          ctx.globalAlpha = 0.35 * (1 - (scan_id - d.id) / Math.max(1, store.scan.to - store.scan.from));
          ctx.fillStyle = reaction;
          ctx.beginPath();
          ctx.arc(p.x, p.y, rr * 1.8, 0, Math.PI * 2);
          ctx.fill();
        }
        if (d.tour && d.fresh && t >= 1 && !reduce) {
          ctx.globalAlpha = 0.8;
          ctx.strokeStyle = accent;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(p.x, p.y, rr * 2.2, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;

      // the scan cursor
      if (store.scan && st > 0 && st < 1) {
        const p = pos(Math.max(0, Math.round(scan_id)));
        ctx.fillStyle = reaction;
        ctx.fillRect(p.x - 1, p.y - pitch, 2, pitch * 2);
        ctx.beginPath();
        ctx.arc(p.x, p.y - pitch, 3, 0, Math.PI * 2);
        ctx.fill();
      }

      // the archive bin
      if (store.archived > 0 || dots.some((d) => d.leaving && d.archived)) {
        ctx.fillStyle = v("--act-surface-2", "#eee");
        ctx.strokeStyle = tomb;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.roundRect(bin.x - 14, bin.y - 9, 28, 20, 4);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = text;
        ctx.font = "600 10px system-ui, sans-serif";
        ctx.textAlign = "right";
        ctx.fillText(`archive · ${store.archived.toLocaleString("en-US")} events`, bin.x - 18, bin.y + 4);
        ctx.textAlign = "left";
      }

      if (now - start < total) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
    // a new run replays the step's motion
  }, [store, base, run, enter, reduce, hover, size, focus?.join("|")]);

  const move = (e: React.MouseEvent) => {
    const rect = canvas.current!.getBoundingClientRect();
    const { pitch, cols, oy, dots } = geo.current;
    const col = Math.floor((e.clientX - rect.left - 40) / pitch);
    const row = Math.floor((e.clientY - rect.top - oy) / pitch);
    const d = col >= 0 && col < cols ? dots.get(row * cols + col) : undefined;
    onHover(d?.stream);
    setTip(d ? { x: e.clientX - rect.left, y: e.clientY - rect.top, text: `#${d.id} ${d.name} · ${d.stream} v${d.version}` } : undefined);
  };

  return (
    <>
      <canvas
        ref={canvas}
        className={styles.field}
        onMouseMove={move}
        onMouseLeave={() => {
          onHover(undefined);
          setTip(undefined);
        }}
        aria-label={`${store.label}: every event as a dot, in id order`}
        role="img"
      />
      {tip && (
        <span className={styles.fieldTip} style={{ left: tip.x + 12, top: tip.y + 12 }}>
          {tip.text}
        </span>
      )}
    </>
  );
}
