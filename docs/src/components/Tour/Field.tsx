/**
 * The store at scale: every event in the store as one dot, in global id order,
 * wrapping like text. Snapshots are rings, tombstones dark caps, sensitive
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

const KINDS = ["ticket", "agent", "user", "ledger"];
const kind_of = (stream: string) => {
  const i = KINDS.findIndex((k) => stream.startsWith(`${k}-`));
  return i < 0 ? 4 : i;
};

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export default function Field({
  store,
  base,
  run,
  enter,
  reduce,
  hover,
  onHover,
}: {
  store: Store;
  base: BaseEvent[];
  run: number;
  enter: number;
  reduce: boolean;
  hover?: string;
  onHover: (stream: string | undefined) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | undefined>();
  const geo = useRef<{ pitch: number; cols: number; dots: Map<number, Dot> }>({ pitch: 8, cols: 1, dots: new Map() });

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
    const palette = [v("--t-s0", "#2f6fdf"), v("--t-s1", "#0f9a8a"), v("--t-s2", "#c2389a"), v("--t-s3", "#7a8a14"), v("--dg-note", "#8a93a3")];
    const snap = v("--dg-state", "#a87d00");
    const tomb = v("--dg-line", "#5d6574");
    const bad = v("--dg-bad", "#c62828");
    const pink = v("--dg-external", "#c8336f");
    const accent = v("--dg-action", "#2b5fd0");
    const reaction = v("--dg-reaction", "#7f4cc7");
    const text = v("--ifm-font-color-base", "#222");
    const workers = [accent, v("--dg-event", "#d96a14"), v("--dg-projection", "#17875c"), reaction];

    const dots = dots_of(store, base);
    const max_id = dots.reduce((m, d) => Math.max(m, d.id, d.from ?? 0), 0);
    const n = Math.max(64, max_id + 1);
    const W = size.w - 8;
    const H = size.h - 8;
    // the largest pitch that fits every id in the box
    let pitch = Math.min(14, Math.sqrt((W * H) / n));
    let cols = Math.max(1, Math.floor(W / pitch));
    while (Math.ceil(n / cols) * pitch > H && pitch > 2) {
      pitch -= 0.25;
      cols = Math.max(1, Math.floor(W / pitch));
    }
    const r = Math.max(1, pitch * 0.36);
    const pos = (id: number) => ({ x: 4 + (id % cols) * pitch + pitch / 2, y: 4 + Math.floor(id / cols) * pitch + pitch / 2 });
    const bin = { x: size.w - 34, y: size.h - 22 };
    geo.current = { pitch, cols, dots: new Map(dots.filter((d) => !d.leaving).map((d) => [d.id, d])) };
    const glow = new Map(store.glows.map((g) => [g.stream, g.worker]));
    const worker_list = [...new Set(store.glows.map((g) => g.worker))];
    const tour_ids = dots.filter((d) => d.tour && !d.leaving).map((d) => d.id);

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
        const dim = hover && d.stream !== hover ? 0.18 : 1;
        ctx.globalAlpha = alpha * dim;
        const rr = r * scale * (hover && d.stream === hover ? 1.35 : 1);
        const g = glow.get(d.stream);
        if (g) {
          ctx.fillStyle = workers[worker_list.indexOf(g) % workers.length]!;
          ctx.globalAlpha = 0.28 * dim;
          ctx.beginPath();
          ctx.arc(p.x, p.y, rr * 2.3, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = alpha * dim;
        }
        if (d.kind === "snapshot") {
          ctx.strokeStyle = snap;
          ctx.lineWidth = Math.max(1, rr * 0.55);
          ctx.beginPath();
          ctx.arc(p.x, p.y, rr * 1.05, 0, Math.PI * 2);
          ctx.stroke();
        } else if (d.kind === "tombstone") {
          ctx.fillStyle = tomb;
          ctx.fillRect(p.x - rr * 1.1, p.y - rr * 1.1, rr * 2.2, rr * 2.2);
          ctx.strokeStyle = text;
          ctx.lineWidth = Math.max(0.8, rr * 0.35);
          ctx.beginPath();
          ctx.moveTo(p.x - rr * 0.7, p.y - rr * 0.7);
          ctx.lineTo(p.x + rr * 0.7, p.y + rr * 0.7);
          ctx.moveTo(p.x + rr * 0.7, p.y - rr * 0.7);
          ctx.lineTo(p.x - rr * 0.7, p.y + rr * 0.7);
          ctx.stroke();
        } else {
          ctx.fillStyle = palette[kind_of(d.stream)]!;
          ctx.beginPath();
          ctx.arc(p.x, p.y, rr, 0, Math.PI * 2);
          ctx.fill();
          if (d.pii) {
            ctx.strokeStyle = d.shredded ? bad : pink;
            ctx.lineWidth = Math.max(0.8, rr * 0.4);
            ctx.beginPath();
            if (d.shredded) {
              ctx.moveTo(p.x - rr, p.y - rr);
              ctx.lineTo(p.x + rr, p.y + rr);
            } else ctx.arc(p.x, p.y, rr * 1.45, 0, Math.PI * 2);
            ctx.stroke();
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
  }, [store, base, run, enter, reduce, hover, size]);

  const move = (e: React.MouseEvent) => {
    const rect = canvas.current!.getBoundingClientRect();
    const { pitch, cols, dots } = geo.current;
    const col = Math.floor((e.clientX - rect.left - 4) / pitch);
    const row = Math.floor((e.clientY - rect.top - 4) / pitch);
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
