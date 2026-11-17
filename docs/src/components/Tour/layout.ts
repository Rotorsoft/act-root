/**
 * Places everything the stage draws, in SVG units. Three regions share the
 * width: the callers (and the read models the app writes) in a narrow left
 * column, the running Act app in the middle, the event store on the right. On
 * a phone they stack. The layout reads only the world, the scene's nodes and
 * the app's declared anatomy, so it has no domain knowledge.
 */
import type { Anchor, AppSpec, Node } from "./types";
import type { Cell, Store, Table, Target, World } from "./world";

export type Mode = "wide" | "narrow";
export type View = "macro" | "micro";

export type Box = { x: number; y: number; w: number; h: number };
export type Pt = { x: number; y: number };

/** An element of the app: an action, an event, a reaction, … with its code, if any. */
export type Chip = {
  kind: "action" | "event" | "reaction" | "projection" | "lane" | "op" | "port";
  name: string;
  label: string;
  box: Box;
  code?: string;
};

/** A state inside its slice: its actions flow in on the left, its events out on the right. */
export type StateBox = {
  /** the scene node's label when one state is loaded twice (`Agent · next`) */
  title?: string;
  name: string;
  box: Box;
  lines: string[];
  sub?: string;
  version?: number;
  node?: string;
  code?: string;
};

export type AppLayout = {
  box: Box;
  title: string;
  gate: Box;
  /** the action layer: one ordered pipe of stages, ending at the commit port */
  layer: { stage: string; box: Box }[];
  layer_box: Box;
  vertical: boolean;
  chips: Chip[];
  states: StateBox[];
  slices: { name: string; box: Box; code?: string }[];
  /** arrows: action → state, state → event, event → reaction or projection */
  links: { a: Pt; b: Pt; kind: "in" | "out" | "listen"; pts?: Pt[] }[];
  cards: { node: Node; box: Box; lines: string[] }[];
  port: Pt;
};

export type SubRow = { target: Target; box: Box; track: Box };
export type LaneGroup = {
  lane: string;
  budget?: string;
  head: Box;
  rows: SubRow[];
};

/** Where each subscription column starts, as a share of the row's width. */
export const SUB_COLS = {
  target: 0,
  source: 0.22,
  lane: 0.38,
  status: 0.47,
  lease: 0.64,
  retries: 0.74,
  at: 1,
};

export type StoreBox = {
  store: Store;
  box: Box;
  field: Box;
  legend: Box;
  cells: { cell: Cell; box: Box }[];
  tail: Box;
  per_row: number;
  /** the global-id axis every subscription track shares */
  axis: { x: number; w: number; max: number };
  checkpoint?: Box;
  lanes: LaneGroup[];
  subs_head?: Box;
  /** where a commit the version guard turned back stops: at the store's edge, never in the log */
  bounce?: Box;
  /** the subscription column header, under the checkpoint band */
  cols?: Box;
};

export type TableBox = { table: Table; box: Box };

export type Layout = {
  width: number;
  height: number;
  mode: Mode;
  callers: { node: Node; box: Box }[];
  app: AppLayout;
  stores: StoreBox[];
  tables: TableBox[];
  anchor: (a: Anchor) => Pt | undefined;
  route: (from: Anchor, to: Anchor) => Pt[];
  /** the app element a scene node names, for the spotlight */
  chip_of: (id: string) => { kind: string; name: string } | undefined;
};

const CALLER_H = 58;
const CHIP_H = 19;
const LINE = 13;
const TRACK = 8;

export const text_w = (s: string, px = 10.5) => s.length * px * 0.6 + 12;

/** One line per field, `key: value`, values kept short. */
export function data_lines(
  data: Record<string, unknown> | undefined,
  max = 6
): string[] {
  if (!data) return [];
  const lines = Object.entries(data).map(([k, v]) => `${k}: ${short(v)}`);
  return lines.length > max
    ? [...lines.slice(0, max - 1), `… ${lines.length - max + 1} more`]
    : lines;
}

export function short(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string")
    return v.length > 22 ? `"${v.slice(0, 20)}…"` : `"${v}"`;
  if (typeof v === "object") {
    const s = JSON.stringify(v);
    return s.length > 24 ? `${s.slice(0, 22)}…` : s;
  }
  return String(v);
}

const CALLERS = new Set(["actor", "worker", "external"]);

/** Places chips left to right, wrapping inside `w`; returns the height used. */
function flow(
  chips: Chip[],
  items: Omit<Chip, "box">[],
  x: number,
  y: number,
  w: number,
  indent = 0
): number {
  let cx = x + indent;
  let cy = y;
  for (const it of items) {
    const cw = Math.min(w - indent, text_w(it.label) + (it.code ? 16 : 0));
    if (cx + cw > x + w && cx > x + indent) {
      cx = x + indent;
      cy += CHIP_H + 4;
    }
    chips.push({ ...it, box: { x: cx, y: cy, w: cw, h: CHIP_H } });
    cx += cw + 5;
  }
  return items.length ? cy + CHIP_H - y : 0;
}

/** Stacks chips in a column; returns the height used. */
function column(
  chips: Chip[],
  items: Omit<Chip, "box">[],
  x: number,
  y: number,
  w: number
): number {
  for (const [i, it] of items.entries())
    chips.push({ ...it, box: { x, y: y + i * (CHIP_H + 4), w, h: CHIP_H } });
  return items.length ? items.length * (CHIP_H + 4) - 4 : 0;
}

function app_layout(
  app: AppSpec,
  nodes: Node[],
  world: World,
  x: number,
  y: number,
  w: number,
  layer: string[],
  narrow: boolean
): AppLayout {
  const code = app.code ?? {};
  const chips: Chip[] = [];
  const links: AppLayout["links"] = [];
  const pad = 10;
  const iw = w - pad * 2;
  let cy = y + 26;

  // the ports it's wired to
  // only the ports a scene names (a cache, a second store); the app's wiring stays off screen
  const ports: string[] = [];
  for (const n of nodes.filter((n) => n.kind === "store")) {
    const p = `${n.label}${n.sub ? `: ${n.sub}` : ""}`;
    if (!ports.some((q) => q.startsWith(n.label))) ports.push(p);
  }
  cy +=
    flow(
      chips,
      ports.map((p) => ({
        kind: "port",
        name: p.split(":")[0]!.trim(),
        label: p,
      })),
      x + pad,
      cy,
      iw
    ) + 7;

  // the gate every action enters by, then the operator entry points
  const declared = new Set(
    app.slices.flatMap((s) => s.states.flatMap((st) => st.actions))
  );
  const ops = [...(app.ops ?? [])];
  for (const n of nodes)
    if (n.kind === "action" && !declared.has(n.label) && !ops.includes(n.label))
      ops.push(n.label);
  const gate: Box = { x: x + pad, y: cy, w: text_w("app.do") + 4, h: CHIP_H };
  chips.push({ kind: "op", name: "app.do", label: "app.do", box: gate });
  cy +=
    Math.max(
      CHIP_H,
      flow(
        chips,
        ops.map((o) => ({ kind: "op", name: o, label: o, code: code[o] })),
        x + pad,
        cy,
        iw,
        gate.w + 6
      )
    ) + 8;

  // the action layer: one ordered pipe, across on a wide stage, down on a phone
  const layer_top = cy;
  const vertical = narrow;
  const arrow = 12;
  const stages: AppLayout["layer"] = [];
  let layer_h: number;
  if (vertical) {
    const sw = Math.min(170, iw - 20);
    for (const [i, stage] of layer.entries())
      stages.push({
        stage,
        box: {
          x: x + pad + 6,
          y: cy + 20 + i * (CHIP_H + 6),
          w: sw,
          h: CHIP_H,
        },
      });
    layer_h = 20 + layer.length * (CHIP_H + 6) + 4;
  } else {
    const sw = (iw - 26 - arrow * (layer.length - 1)) / layer.length;
    for (const [i, stage] of layer.entries())
      stages.push({
        stage,
        box: {
          x: x + pad + 4 + i * (sw + arrow),
          y: cy + 20,
          w: sw,
          h: CHIP_H,
        },
      });
    layer_h = 20 + CHIP_H + 8;
  }
  const layer_box: Box = {
    x: x + pad - 4,
    y: layer_top - 2,
    w: iw + 8,
    h: layer_h,
  };
  const last = stages[stages.length - 1]?.box;
  const port: Pt = vertical
    ? { x: x + w - 12, y: (last?.y ?? cy) + CHIP_H / 2 }
    : { x: x + w, y: (last?.y ?? cy) + CHIP_H / 2 };
  cy += layer_h + 10;

  // the states that scene nodes fold, by state name: their values replace the field list
  const by_state = new Map<string, Node[]>();
  for (const n of nodes.filter((n) => n.kind === "state")) {
    const base = n.label.split(" ·")[0]!;
    by_state.set(base, [...(by_state.get(base) ?? []), n]);
  }

  // slices: each state as actions → state → events, then the reactions and projections that listen
  const slices: AppLayout["slices"] = [];
  const states: StateBox[] = [];
  const cards: AppLayout["cards"] = [];
  const event_at = new Map<string, Box>();
  const state_at = new Map<string, Box>();
  for (const sl of app.slices) {
    // a reaction's arrow comes from an event of its own slice
    event_at.clear();
    const top = cy;
    cy += 20;
    const inner = iw - 12;
    const aw = narrow ? inner * 0.32 : inner * 0.3;
    const ew = narrow ? inner * 0.32 : inner * 0.32;
    const gap = 16;
    const sw = inner - aw - ew - gap * 2;
    for (const st of sl.states) {
      const own = by_state.get(st.name) ?? [];
      const loaded = own.filter((n) => world.states[n.id]);
      const instances = loaded.length ? loaded : [undefined];
      const sx = x + pad + 6 + aw + gap;
      const ex = sx + sw + gap;
      const ah = column(
        chips,
        st.actions.map((a) => ({
          kind: "action" as const,
          name: a,
          label: a,
          code: code[a],
        })),
        x + pad + 6,
        cy,
        aw
      );
      const eh = column(
        chips,
        st.events.map((e) => ({ kind: "event" as const, name: e, label: e })),
        ex,
        cy,
        ew
      );
      let iy = cy;
      let box: Box = { x: sx, y: cy, w: sw, h: 0 };
      instances.forEach((n, k) => {
        const values = n ? data_lines(world.states[n.id]?.data, 5) : [];
        const lines = values.length ? values : (st.fields ?? []).map((f) => f);
        const ih = 22 + Math.max(1, lines.length) * LINE + 6;
        const b: Box = {
          x: sx,
          y: iy,
          w: sw,
          h:
            instances.length === 1
              ? Math.max(ih, Math.min(Math.max(ah, eh), ih + 20))
              : ih,
        };
        states.push({
          name: st.name,
          box: b,
          lines,
          code: code[st.name],
          ...(instances.length > 1 && n && { title: n.label }),
          ...(n && {
            node: n.id,
            sub: n.sub,
            version: world.states[n.id]?.version,
          }),
        });
        if (k === 0) box = b;
        iy += b.h + 6;
      });
      const h = Math.max(ah, eh, iy - cy - 6);
      state_at.set(st.name, box);
      for (const c of chips.filter(
        (c) =>
          c.kind === "action" && st.actions.includes(c.name) && c.box.y >= cy
      )) {
        links.push({
          a: { x: c.box.x + c.box.w, y: c.box.y + CHIP_H / 2 },
          b: {
            x: box.x,
            y: box.y + Math.min(box.h / 2, c.box.y - cy + CHIP_H / 2 + 4),
          },
          kind: "in",
        });
      }
      for (const c of chips.filter(
        (c) => c.kind === "event" && st.events.includes(c.name) && c.box.y >= cy
      )) {
        event_at.set(c.name, c.box);
        links.push({
          a: {
            x: box.x + box.w,
            y: box.y + Math.min(box.h / 2, c.box.y - cy + CHIP_H / 2 + 4),
          },
          b: { x: c.box.x, y: c.box.y + CHIP_H / 2 },
          kind: "out",
        });
      }
      cy += h + 6;
    }
    const listeners: Omit<Chip, "box">[] = [
      ...(sl.reactions ?? []).map((r) => ({
        kind: "reaction" as const,
        name: r,
        label: `↻ ${r}`,
        code: code[r],
      })),
      ...(sl.projections ?? []).map((p) => ({
        kind: "projection" as const,
        name: p.name,
        label: `▤ ${p.name} → ${p.target}`,
        code: code[p.name],
      })),
    ];
    if (listeners.length) {
      const before = chips.length;
      cy += 12;
      cy += flow(chips, listeners, x + pad + 6, cy, iw - 12) + 6;
      for (const c of chips.slice(before)) {
        const proj = sl.projections?.find((p) => p.name === c.name);
        const from =
          c.kind === "reaction"
            ? event_at.get(app.listens?.[c.name] ?? "")
            : proj?.of
              ? state_at.get(proj.of)
              : event_at.get(proj?.on?.[0] ?? "");
        if (from) {
          const lane_y = c.box.y - 6;
          const right = from.x + from.w + 4;
          const a =
            c.kind === "projection" && proj?.of
              ? { x: from.x + from.w / 2, y: from.y + from.h }
              : { x: from.x + from.w, y: from.y + from.h / 2 };
          const pts =
            c.kind === "projection" && proj?.of
              ? [
                  a,
                  { x: a.x, y: lane_y },
                  { x: c.box.x + c.box.w / 2, y: lane_y },
                  { x: c.box.x + c.box.w / 2, y: c.box.y },
                ]
              : [
                  a,
                  { x: right, y: a.y },
                  { x: right, y: lane_y },
                  { x: c.box.x + c.box.w / 2, y: lane_y },
                  { x: c.box.x + c.box.w / 2, y: c.box.y },
                ];
          links.push({
            a,
            b: { x: c.box.x + c.box.w / 2, y: c.box.y },
            kind: "listen",
            pts,
          });
        }
      }
    }
    slices.push({
      name: sl.name,
      box: { x: x + pad, y: top, w: iw, h: cy - top },
      code: code[`slice:${sl.name}`],
    });
    cy += 8;
  }
  if (app.lanes?.length)
    cy +=
      flow(
        chips,
        app.lanes.map((l) => ({
          kind: "lane" as const,
          name: l.name,
          label: `lane ${l.name} · ${l.budget}`,
          code: code[`lane:${l.name}`],
        })),
        x + pad,
        cy,
        iw
      ) + 8;

  // state cards for scene nodes not shown inside a state
  for (const n of nodes.filter(
    (n) =>
      n.kind === "state" &&
      world.states[n.id] &&
      !states.some((s) => s.node === n.id) &&
      !cards.some((c) => c.node === n)
  ))
    cards.push({
      node: n,
      box: { x: 0, y: 0, w: 0, h: 0 },
      lines: data_lines(world.states[n.id]?.data, 5),
    });
  const card_w = narrow ? (iw - 8) / 2 : Math.min(200, (iw - 16) / 3);
  let cx = x + pad;
  let row_h = 0;
  for (const card of cards) {
    const h = 22 + card.lines.length * LINE + 6;
    if (cx + card_w > x + pad + iw + 1) {
      cx = x + pad;
      cy += row_h + 6;
      row_h = 0;
    }
    card.box = { x: cx, y: cy, w: card_w, h };
    cx += card_w + 8;
    row_h = Math.max(row_h, h);
  }
  cy += row_h + (row_h ? 10 : 0);

  return {
    box: { x, y, w, h: cy - y },
    title: app.title ?? "act().build()",
    gate,
    layer: stages,
    layer_box,
    vertical,
    chips,
    states,
    slices,
    links,
    cards,
    port,
  };
}

export function layout(
  mode: Mode,
  view: View,
  nodes: Node[],
  world: World,
  app: AppSpec,
  layer: string[],
  units = 1000
): Layout {
  const narrow = mode === "narrow";
  const width = narrow ? 420 : units;
  const pad = 10;
  const gap = narrow ? 14 : 20;
  // callers narrow, then the app and the store sharing the rest about 40 / 48
  // actors are icons at the edge; the app and the store are the two centers
  const L = narrow ? width - pad * 2 : 84;
  const A = narrow
    ? width - pad * 2
    : Math.round((width - pad * 2 - L - gap * 2) * 0.44);
  const S = narrow ? width - pad * 2 : width - pad * 2 - L - A - gap * 2;
  const lx = pad;
  const ax = narrow ? pad : lx + L + gap;
  const sx = narrow ? pad : ax + A + gap;

  // the callers
  const callers: Layout["callers"] = [];
  let ly = 8;
  const cnodes = nodes.filter((n) => CALLERS.has(n.kind));
  if (narrow) {
    const cw = (L - 16) / 5;
    cnodes.forEach((node, i) => {
      callers.push({
        node,
        box: {
          x: lx + (i % 5) * (cw + 4),
          y: ly + Math.floor(i / 5) * (CALLER_H + 4),
          w: cw,
          h: CALLER_H,
        },
      });
    });
    ly += Math.ceil(cnodes.length / 5) * (CALLER_H + 4) + 6;
  } else {
    ly += 16;
    for (const node of cnodes) {
      callers.push({ node, box: { x: lx, y: ly, w: L, h: CALLER_H } });
      ly += CALLER_H + 14;
    }
  }

  // the app
  const appl = app_layout(
    app,
    nodes,
    world,
    ax,
    narrow ? ly + 4 : 8,
    A,
    layer,
    narrow
  );

  // read models: under the callers on a wide stage, after the store on a phone
  const tables: TableBox[] = [];
  const table_rows = (t: Table) =>
    Math.min(6, t.rows.length) + (t.total !== undefined ? 1 : 0);
  let ty = narrow ? 0 : ly + 14;
  if (!narrow)
    for (const table of world.tables) {
      const h = 24 + Math.max(1, table_rows(table)) * 16 + 8;
      tables.push({ table, box: { x: lx, y: ty, w: L, h } });
      ty += h + 10;
    }

  // the stores
  let sy = narrow ? appl.box.y + appl.box.h + 16 : 8;
  const stores: StoreBox[] = world.stores.map((store) => {
    const top = sy;
    sy += narrow ? 42 : 28;
    // a commit the version guard turned back gets a row of its own at the store's entry edge
    let bounce_row: Box | undefined;
    if (store.ghost && !narrow) {
      bounce_row = { x: sx, y: sy, w: Math.min(S, 400), h: 18 };
      sy += 24;
    }
    // a small store gets only a strip; the room goes to the cells
    const field_h =
      store.next_id < 300
        ? 24
        : view === "macro"
          ? Math.round(Math.max(140, Math.min(300, S * 0.34)))
          : 48;
    const field: Box = { x: sx, y: sy, w: S, h: field_h };
    sy += field_h + 4;
    const legend: Box = { x: sx, y: sy, w: S, h: 0 };
    sy += 6;

    // the detailed cells: the lens on the field; at scale only the newest row
    const cell = { w: 84, h: 46 };
    const cg = 6;
    const per_row = Math.max(1, Math.floor((S + cg) / (cell.w + cg)));
    const shown = view === "macro" ? store.cells.slice(-per_row) : store.cells;
    const slots = shown.length;
    const place = (i: number): Box => ({
      x: sx + (i % per_row) * (cell.w + cg),
      y: sy + 12 + Math.floor(i / per_row) * (cell.h + 20),
      w: cell.w,
      h: cell.h,
    });
    const cells = shown.map((c, i) => ({ cell: c, box: place(i) }));
    const tail = place(shown.length);
    if (slots) sy += Math.ceil(slots / per_row) * (cell.h + 20) + 4;

    // subscriptions: grouped by lane, a header row, each with a track on the id axis
    const axis = { x: sx, w: S, max: Math.max(1, store.next_id - 1) };
    const own = world.targets.filter((t) => t.store === store.name);
    const lanes: LaneGroup[] = [];
    let checkpoint: Box | undefined;
    let subs_head: Box | undefined;
    let cols: Box | undefined;
    if (own.length) {
      // minimal: the correlate checkpoint, then one labelled track per subscription
      checkpoint = { x: sx, y: sy, w: S, h: 18 };
      sy += 22;
      for (const lane of [...new Set(own.map((t) => t.lane))]) {
        const head: Box = { x: sx, y: sy, w: S, h: 0 };
        const rows: SubRow[] = [];
        const rh = 13;
        for (const target of own.filter((t) => t.lane === lane)) {
          rows.push({
            target,
            box: { x: sx, y: sy, w: S, h: rh },
            track: { x: sx, y: sy + rh, w: S, h: TRACK },
          });
          sy += rh + TRACK + 5;
        }
        lanes.push({
          lane,
          budget: app.lanes?.find((l) => l.name === lane)?.budget,
          head,
          rows,
        });
      }
      sy += 2;
    }
    const box: Box = { x: sx - 8, y: top, w: S + 16, h: sy - top };
    sy += 12;
    return {
      store,
      box,
      field,
      legend,
      cells,
      tail,
      per_row,
      axis,
      checkpoint,
      lanes,
      subs_head,
      cols,
      ...(store.ghost && {
        bounce: narrow
          ? { x: sx + S - 132, y: top + 4, w: 132, h: 46 }
          : bounce_row!,
      }),
    };
  });

  if (narrow)
    for (const table of world.tables) {
      const h = 24 + Math.max(1, table_rows(table)) * 16 + 8;
      tables.push({ table, box: { x: pad, y: sy, w: S, h } });
      sy += h + 10;
    }

  const height = Math.max(sy, appl.box.y + appl.box.h, ty, ly) + 8;

  const center = (b: Box): Pt => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
  const chip = (kind: Chip["kind"], name: string) =>
    appl.chips.find((c) => c.kind === kind && c.name === name);
  const state_box = (node: Node) =>
    appl.states.find((s) => s.node === node.id) ??
    appl.states.find((s) => s.name === node.label.split(" ·")[0]);
  const tail_of = (s: StoreBox | undefined) =>
    s &&
    (s.bounce
      ? { x: s.bounce.x + 10, y: s.bounce.y + s.bounce.h / 2 }
      : s.cells.length
        ? center(s.tail)
        : { x: s.field.x + s.field.w - 12, y: s.field.y + s.field.h - 10 });

  const anchor = (a: Anchor): Pt | undefined => {
    if (a === "gate") return center(appl.gate);
    if (a === "port") return appl.port;
    if (a.startsWith("layer:")) {
      const s = appl.layer.find((l) => l.stage === a.slice(6));
      return s && center(s.box);
    }
    if (a.startsWith("cell:")) {
      const uid = world.refs[a.slice(5)];
      for (const s of stores) {
        const c = s.cells.find((x) => x.cell.uid === uid);
        if (c) return center(c.box);
      }
      return tail_of(stores[0]);
    }
    if (a === "log") return tail_of(stores[0]);
    if (a.startsWith("log:"))
      return tail_of(stores.find((x) => x.store.name === a.slice(4)));
    if (a.startsWith("field:")) {
      const s = stores.find((x) => x.store.name === a.slice(6)) ?? stores[0];
      return s && center(s.field);
    }
    if (a.startsWith("stream:")) return stores[0] && center(stores[0].field);
    if (a.startsWith("target:")) {
      for (const s of stores)
        for (const g of s.lanes) {
          const r = g.rows.find((x) => x.target.id === a.slice(7));
          if (r) return { x: r.box.x + 60, y: r.box.y + r.box.h / 2 };
        }
      return undefined;
    }
    if (a.startsWith("table:")) {
      const t = tables.find((x) => x.table.name === a.slice(6));
      return t && { x: t.box.x + t.box.w / 2, y: t.box.y + 14 };
    }
    if (a.startsWith("store:")) {
      const s = stores.find((x) => x.store.name === a.slice(6));
      return s && { x: s.box.x + s.box.w / 2, y: s.box.y + 14 };
    }
    const caller = callers.find((c) => c.node.id === a);
    if (caller) return center(caller.box);
    const node = nodes.find((n) => n.id === a);
    if (!node) return undefined;
    if (node.kind === "state") {
      const card = appl.cards.find((c) => c.node.id === a);
      if (card) return center(card.box);
      const st = state_box(node);
      return st && center(st.box);
    }
    const kinds: Record<string, Chip["kind"][]> = {
      action: ["action", "op"],
      reaction: ["reaction"],
      projection: ["projection"],
    };
    for (const k of kinds[node.kind] ?? []) {
      const c = chip(k, node.label) ?? chip(k, node.id);
      if (c) return center(c.box);
    }
    if (node.kind === "store") {
      const c = appl.chips.find(
        (x) => x.kind === "port" && x.label.startsWith(node.label)
      );
      return c && center(c.box);
    }
    return undefined;
  };

  type Region = "left" | "app" | "store";
  const region = (a: Anchor): Region => {
    if (/^(cell:|log|stream:|target:|store:|field:)/.test(a)) return "store";
    if (a.startsWith("table:")) return "left";
    if (a === "gate" || a === "port" || a.startsWith("layer:")) return "app";
    const node = nodes.find((n) => n.id === a);
    return node && CALLERS.has(node.kind) ? "left" : "app";
  };
  const is_action = (a: Anchor) => {
    const node = nodes.find((n) => n.id === a);
    return node?.kind === "action" && !!chip("action", node.label);
  };
  const is_state = (a: Anchor) =>
    nodes.find((n) => n.id === a)?.kind === "state";
  const pipe_start = () => center(appl.layer[0]!.box);
  const pipe_end = () => center(appl.layer[appl.layer.length - 1]!.box);

  // the token's path: in at `app.do`, along the action layer, out through the commit port
  const route = (from: Anchor, to: Anchor): Pt[] => {
    const a = anchor(from);
    const b = anchor(to);
    if (!a || !b) return [];
    const ra = region(from);
    const rb = region(to);
    const out: Pt[] = [a];
    const has_layer = appl.layer.length > 0;
    if (ra === "left" && rb === "app" && (is_action(to) || is_state(to)))
      out.push(center(appl.gate));
    if (ra === "left" && rb === "store")
      out.push({ x: appl.box.x, y: a.y }, appl.port);
    // a commit leaves along the pipe: through every stage, then the port
    if (ra === "app" && rb === "store") {
      if (has_layer && (is_action(from) || is_state(from)))
        out.push(pipe_start(), pipe_end());
      out.push(appl.port);
    }
    if (ra === "store" && rb === "app") out.push(appl.port);
    if (ra === "store" && rb === "left")
      out.push(appl.port, { x: appl.box.x, y: b.y });
    out.push(b);
    return out;
  };

  const chip_of = (id: string) => {
    const node = nodes.find((n) => n.id === id);
    if (!node) return undefined;
    if (node.kind === "state") {
      const st = state_box(node);
      return st && { kind: "state", name: st.name };
    }
    if (node.kind === "action")
      return chip("action", node.label) ?? chip("op", node.label);
    if (node.kind === "reaction")
      return chip("reaction", node.label) ?? chip("reaction", node.id);
    if (node.kind === "projection")
      return chip("projection", node.label) ?? chip("projection", node.id);
    if (node.kind === "store")
      return appl.chips.find(
        (x) => x.kind === "port" && x.label.startsWith(node.label)
      );
    return undefined;
  };

  return {
    width,
    height,
    mode,
    callers,
    app: appl,
    stores,
    tables,
    anchor,
    route,
    chip_of,
  };
}
