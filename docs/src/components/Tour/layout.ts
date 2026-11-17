/**
 * Places everything the stage draws, in SVG units. Three regions share the
 * width: the callers (and the read models the app writes) on the left, the
 * running Act app in the middle, the event store on the right. On a phone they
 * stack. The layout reads only the world, the scene's nodes and the app's
 * declared anatomy, so it has no domain knowledge.
 */
import type { Anchor, AppSpec, Node } from "./types";
import type { Cell, Store, Table, Target, World } from "./world";

export type Mode = "wide" | "narrow";
export type View = "macro" | "micro";

export type Box = { x: number; y: number; w: number; h: number };
export type Pt = { x: number; y: number };

/** An element of the app: an action, an event, a reaction, … with its code, if any. */
export type Chip = {
  kind:
    | "action"
    | "event"
    | "reaction"
    | "projection"
    | "state"
    | "lane"
    | "op"
    | "port";
  name: string;
  label: string;
  box: Box;
  code?: string;
};

export type AppLayout = {
  box: Box;
  title: string;
  gate: Box;
  layer: { stage: string; box: Box }[];
  layer_box: Box;
  chips: Chip[];
  slices: { name: string; box: Box; code?: string }[];
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

export type StoreBox = {
  store: Store;
  box: Box;
  field: Box;
  cells: { cell: Cell; box: Box }[];
  tail: Box;
  per_row: number;
  /** the global-id axis every subscription track shares */
  axis: { x: number; w: number; max: number };
  checkpoint?: Box;
  lanes: LaneGroup[];
  subs_head?: Box;
};

export type StreamRow = {
  stream: string;
  store: string;
  head: number;
  count: number;
  box: Box;
};
export type TableBox = { table: Table; box: Box };

export type Layout = {
  width: number;
  height: number;
  mode: Mode;
  callers: { node: Node; box: Box }[];
  app: AppLayout;
  stores: StoreBox[];
  streams: { box: Box; rows: StreamRow[] };
  tables: TableBox[];
  anchor: (a: Anchor) => Pt | undefined;
  route: (from: Anchor, to: Anchor) => Pt[];
  /** the app element a scene node names, for the spotlight */
  chip_of: (id: string) => Chip | undefined;
};

const CALLER_H = 42;
const CHIP_H = 20;
const LINE = 14;
const TRACK = 10;

export const text_w = (s: string, px = 11) => s.length * px * 0.6 + 14;

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
    const cw = Math.min(w - indent, text_w(it.label) + (it.code ? 18 : 0));
    if (cx + cw > x + w && cx > x + indent) {
      cx = x + indent;
      cy += CHIP_H + 4;
    }
    chips.push({ ...it, box: { x: cx, y: cy, w: cw, h: CHIP_H } });
    cx += cw + 5;
  }
  return items.length ? cy + CHIP_H - y : 0;
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
  const pad = 10;
  const iw = w - pad * 2;
  let cy = y + 30;

  // the ports it's wired to
  const ports = [...(app.ports ?? [])];
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
    ) + 8;

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
    ) + 10;

  // the action layer: every stage an action passes before the store
  const per = narrow
    ? 3
    : Math.max(3, Math.min(layer.length, Math.floor((iw - 16) / 84)));
  const sw = (iw - 16 - (per - 1) * 6) / per;
  const layer_top = cy;
  const stages = layer.map((stage, i) => ({
    stage,
    box: {
      x: x + pad + 4 + (i % per) * (sw + 6),
      y: cy + 24 + Math.floor(i / per) * (CHIP_H + 6),
      w: sw,
      h: CHIP_H,
    },
  }));
  const layer_h = Math.ceil(layer.length / per) * (CHIP_H + 6) + 28;
  const layer_box: Box = {
    x: x + pad - 4,
    y: layer_top - 2,
    w: iw + 8,
    h: layer_h,
  };
  cy += layer_h + 10;

  // slices, each with its states, reactions and projections
  const slices: AppLayout["slices"] = [];
  for (const sl of app.slices) {
    const top = cy;
    cy += 20;
    for (const st of sl.states) {
      const items: Omit<Chip, "box">[] = [
        { kind: "state", name: st.name, label: st.name, code: code[st.name] },
        ...st.actions.map((a) => ({
          kind: "action" as const,
          name: a,
          label: a,
          code: code[a],
        })),
        ...st.events.map((e) => ({
          kind: "event" as const,
          name: e,
          label: e,
        })),
      ];
      cy += flow(chips, items, x + pad + 6, cy, iw - 12) + 5;
    }
    if (sl.reactions?.length)
      cy +=
        flow(
          chips,
          sl.reactions.map((r) => ({
            kind: "reaction" as const,
            name: r,
            label: `↻ ${r}`,
            code: code[r],
          })),
          x + pad + 6,
          cy,
          iw - 12
        ) + 5;
    if (sl.projections?.length)
      cy +=
        flow(
          chips,
          sl.projections.map((p) => ({
            kind: "projection" as const,
            name: p.name,
            label: `▤ ${p.name}${p.of ? ` · .of(${p.of})` : p.on ? ` · on ${p.on.join(", ")}` : ""}`,
            code: code[p.name],
          })),
          x + pad + 6,
          cy,
          iw - 12
        ) + 5;
    cy += 4;
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

  // the states this scene folds: a card each
  const cards: AppLayout["cards"] = [];
  const card_w = narrow ? (iw - 8) / 2 : Math.min(200, (iw - 16) / 3);
  let cx = x + pad;
  let row_h = 0;
  for (const node of nodes.filter((n) => n.kind === "state")) {
    const lines = data_lines(world.states[node.id]?.data, 5);
    if (!lines.length) continue;
    const h = 22 + lines.length * LINE + 6;
    if (cx + card_w > x + pad + iw + 1) {
      cx = x + pad;
      cy += row_h + 6;
      row_h = 0;
    }
    cards.push({ node, box: { x: cx, y: cy, w: card_w, h }, lines });
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
    chips,
    slices,
    cards,
    port: { x: x + w - (narrow ? 10 : 0), y: layer_top + layer_h / 2 },
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
  const pad = 12;
  const gap = narrow ? 14 : 26;
  const L = narrow
    ? width - pad * 2
    : Math.round(Math.max(150, Math.min(220, width * 0.13)));
  const A = narrow
    ? width - pad * 2
    : Math.round(Math.max(380, Math.min(580, width * 0.33)));
  const S = narrow ? width - pad * 2 : width - pad * 2 - L - A - gap * 2;
  const lx = pad;
  const ax = narrow ? pad : lx + L + gap;
  const sx = narrow ? pad : ax + A + gap;

  // the callers
  const callers: Layout["callers"] = [];
  let ly = 8;
  const cnodes = nodes.filter((n) => CALLERS.has(n.kind));
  if (narrow) {
    const cw = (L - 16) / 3;
    cnodes.forEach((node, i) => {
      callers.push({
        node,
        box: {
          x: lx + (i % 3) * (cw + 8),
          y: ly + Math.floor(i / 3) * (CALLER_H + 8),
          w: cw,
          h: CALLER_H,
        },
      });
    });
    ly += Math.ceil(cnodes.length / 3) * (CALLER_H + 8) + 6;
  } else {
    ly += 22;
    for (const node of cnodes) {
      callers.push({ node, box: { x: lx, y: ly, w: L, h: CALLER_H } });
      ly += CALLER_H + 10;
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

  // read models: below the callers on a wide stage, after the store on a phone
  const tables: TableBox[] = [];
  const table_rows = (t: Table) =>
    Math.min(8, t.rows.length) + (t.total !== undefined ? 1 : 0);
  let ty = narrow ? 0 : ly + 16;
  if (!narrow)
    for (const table of world.tables) {
      const h = 26 + Math.max(1, table_rows(table)) * 18 + 8;
      tables.push({ table, box: { x: lx, y: ty, w: L, h } });
      ty += h + 10;
    }

  // the stores
  let sy = narrow ? appl.box.y + appl.box.h + 16 : 8;
  const stores: StoreBox[] = world.stores.map((store) => {
    const top = sy;
    sy += narrow ? 44 : 30;
    const field_h =
      view === "macro" ? Math.round(Math.max(150, Math.min(330, S * 0.4))) : 56;
    const field: Box = { x: sx, y: sy, w: S, h: field_h };
    sy += field_h + 8;

    // the detailed cells: every event the scene works on, or the last row at scale
    const cell = { w: 88, h: 50 };
    const cg = 8;
    const per_row = Math.max(1, Math.floor((S + cg) / (cell.w + cg)));
    const shown = view === "macro" ? store.cells.slice(-per_row) : store.cells;
    const slots = shown.length + (store.ghost ? 1 : 0);
    const place = (i: number): Box => ({
      x: sx + (i % per_row) * (cell.w + cg),
      y: sy + 14 + Math.floor(i / per_row) * (cell.h + 26),
      w: cell.w,
      h: cell.h,
    });
    const cells = shown.map((c, i) => ({ cell: c, box: place(i) }));
    const tail = place(shown.length);
    if (slots) sy += Math.ceil(slots / per_row) * (cell.h + 26) + 6;

    // subscriptions: grouped by lane, each with a track on the id axis
    const axis = { x: sx, w: S, max: Math.max(1, store.next_id - 1) };
    const own = world.targets.filter((t) => t.store === store.name);
    const lanes: LaneGroup[] = [];
    let checkpoint: Box | undefined;
    let subs_head: Box | undefined;
    if (own.length) {
      subs_head = { x: sx, y: sy, w: S, h: 22 };
      sy += 24;
      checkpoint = { x: sx, y: sy, w: S, h: 20 };
      sy += 26;
      for (const lane of [...new Set(own.map((t) => t.lane))]) {
        const head: Box = { x: sx, y: sy, w: S, h: 18 };
        sy += 20;
        const rows: SubRow[] = [];
        const rh = narrow ? 40 : 22;
        for (const target of own.filter((t) => t.lane === lane)) {
          rows.push({
            target,
            box: { x: sx, y: sy, w: S, h: rh },
            track: { x: sx, y: sy + rh, w: S, h: TRACK },
          });
          sy += rh + TRACK + 8;
        }
        lanes.push({
          lane,
          budget: app.lanes?.find((l) => l.name === lane)?.budget,
          head,
          rows,
        });
      }
      sy += 4;
    }
    const box: Box = { x: sx - 8, y: top, w: S + 16, h: sy - top };
    sy += 12;
    return {
      store,
      box,
      field,
      cells,
      tail,
      per_row,
      axis,
      checkpoint,
      lanes,
      subs_head,
    };
  });

  // the streams the scene works on (the field holds the rest)
  const rows: StreamRow[] = [];
  for (const s of world.stores)
    for (const c of s.cells) {
      if (c.leaving) continue;
      const row = rows.find((r) => r.stream === c.stream && r.store === s.name);
      if (row) {
        row.head = Math.max(row.head, c.version);
        row.count++;
      } else
        rows.push({
          stream: c.stream,
          store: s.name,
          head: c.version,
          count: 1,
          box: { x: 0, y: 0, w: 0, h: 0 },
        });
    }
  const streams_box: Box = { x: sx, y: sy, w: S, h: 0 };
  if (rows.length) {
    sy += 22;
    for (const r of rows) {
      r.box = { x: sx, y: sy, w: S, h: 18 };
      sy += 18;
    }
    sy += 8;
  }
  streams_box.h = sy - streams_box.y;

  if (narrow)
    for (const table of world.tables) {
      const h = 26 + Math.max(1, table_rows(table)) * 18 + 8;
      tables.push({ table, box: { x: pad, y: sy, w: S, h } });
      sy += h + 10;
    }

  const height = Math.max(sy, appl.box.y + appl.box.h, ty, ly) + 10;

  const center = (b: Box): Pt => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
  const chip = (kind: Chip["kind"], name: string) =>
    appl.chips.find((c) => c.kind === kind && c.name === name);
  const tail_of = (s: StoreBox | undefined) =>
    s &&
    (s.cells.length || s.store.ghost
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
    if (a.startsWith("stream:")) {
      const r = rows.find((x) => x.stream === a.slice(7));
      return r && { x: r.box.x + 60, y: r.box.y + r.box.h / 2 };
    }
    if (a.startsWith("target:")) {
      for (const s of stores)
        for (const g of s.lanes) {
          const r = g.rows.find((x) => x.target.id === a.slice(7));
          if (r) return { x: r.box.x + 70, y: r.box.y + r.box.h / 2 };
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
    // a scene node: a caller, or the element of the app it names
    const caller = callers.find((c) => c.node.id === a);
    if (caller) return center(caller.box);
    const node = nodes.find((n) => n.id === a);
    if (!node) return undefined;
    if (node.kind === "state") {
      const card = appl.cards.find((c) => c.node.id === a);
      if (card) return center(card.box);
      const st = chip("state", node.label.split(" ·")[0]!);
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
  const enters_by_gate = (a: Anchor) => {
    const node = nodes.find((n) => n.id === a);
    return (
      (node?.kind === "action" && !!chip("action", node.label)) ||
      node?.kind === "state"
    );
  };

  // the token's path: into the app through `app.do`, out through the store port
  const route = (from: Anchor, to: Anchor): Pt[] => {
    const a = anchor(from);
    const b = anchor(to);
    if (!a || !b) return [];
    const ra = region(from);
    const rb = region(to);
    const gate = center(appl.gate);
    const port = appl.port;
    const out: Pt[] = [a];
    if (narrow) {
      out.push(b);
      return out;
    }
    if (ra === "left" && rb === "app" && enters_by_gate(to)) out.push(gate);
    if (ra === "left" && rb === "store")
      out.push({ x: appl.box.x, y: a.y }, port);
    if (ra === "app" && rb === "store") out.push(port);
    if (ra === "store" && rb === "app") out.push(port);
    if (ra === "store" && rb === "left")
      out.push(port, { x: appl.box.x, y: b.y });
    out.push(b);
    return out;
  };

  const chip_of = (id: string): Chip | undefined => {
    const node = nodes.find((n) => n.id === id);
    if (!node) return undefined;
    if (node.kind === "state") return chip("state", node.label.split(" ·")[0]!);
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
    chip_of,
    width,
    height,
    mode,
    callers,
    app: appl,
    stores,
    streams: { box: streams_box, rows },
    tables,
    anchor,
    route,
  };
}
