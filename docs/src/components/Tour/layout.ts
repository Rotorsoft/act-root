/**
 * Places everything the stage draws, in SVG units, for a wide stage (laptop)
 * or a narrow one (phone). The layout reads only the world and the scene's
 * nodes, so it has no domain knowledge.
 */
import type { Anchor, Node } from "./types";
import type { Cell, Store, Table, Target, World } from "./world";

export type Mode = "wide" | "narrow";

export type Box = { x: number; y: number; w: number; h: number };

export type StoreBox = Box & {
  store: Store;
  cells: { cell: Cell; box: Box }[];
  /** where the next cell would land */
  tail: Box;
  per_row: number;
};

export type StreamRow = {
  stream: string;
  store: string;
  head: number;
  count: number;
  box: Box;
};
export type TargetRow = { target: Target; box: Box };
export type TableBox = { table: Table; box: Box };

export type Layout = {
  width: number;
  height: number;
  cell: { w: number; h: number };
  nodes: { node: Node; box: Box; lines: string[] }[];
  app: Box;
  stores: StoreBox[];
  streams: { box: Box; rows: StreamRow[] };
  targets: { box: Box; rows: TargetRow[] };
  tables: TableBox[];
  anchor: (a: Anchor) => { x: number; y: number } | undefined;
};

const PAD = 16;
const NODE_H = 44;
const LINE = 15;
const STORE_HEAD = 30;
const ROW_TOP = 16;
const ROW_BOTTOM = 18;
const TABLE_ROW = 22;
const SECTION_HEAD = 26;

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

export function layout(mode: Mode, nodes: Node[], world: World): Layout {
  const width = mode === "wide" ? 1000 : 420;
  const inner = width - PAD * 2;
  let y = 8;

  // app band: the scene's nodes, in order
  const per_line = mode === "wide" ? Math.max(1, Math.min(nodes.length, 6)) : 3;
  const gap = mode === "wide" ? 14 : 8;
  const node_w = Math.min(
    mode === "wide" ? 176 : 132,
    (inner - gap * (per_line - 1)) / per_line
  );
  const placed: Layout["nodes"] = [];
  const lines_of = (n: Node) =>
    n.kind === "state"
      ? data_lines(world.states[n.id]?.data, mode === "wide" ? 5 : 4)
      : [];
  for (let start = 0; start < nodes.length; start += per_line) {
    const line = nodes.slice(start, start + per_line);
    const used = line.length * node_w + (line.length - 1) * gap;
    let x = PAD + (inner - used) / 2;
    const card = Math.max(0, ...line.map((n) => lines_of(n).length));
    for (const node of line) {
      placed.push({
        node,
        box: { x, y, w: node_w, h: NODE_H },
        lines: lines_of(node),
      });
      x += node_w + gap;
    }
    y += NODE_H + (card ? card * LINE + 14 : 0) + 18;
  }
  if (!nodes.length) y += 20;
  const app: Box = { x: PAD, y: 0, w: inner, h: y };

  // the stores: one log each, wrapped into rows
  const cell = mode === "wide" ? { w: 88, h: 54 } : { w: 89, h: 54 };
  const cgap = 8;
  const per_row = Math.max(1, Math.floor((inner + cgap) / (cell.w + cgap)));
  const stores: StoreBox[] = world.stores.map((store) => {
    const top = y;
    y += STORE_HEAD;
    const slots = store.cells.length + 1; // the tail slot, for a ghost or the next commit
    const rows = Math.ceil(slots / per_row);
    const place = (i: number): Box => ({
      x: PAD + (i % per_row) * (cell.w + cgap),
      y:
        y + Math.floor(i / per_row) * (ROW_TOP + cell.h + ROW_BOTTOM) + ROW_TOP,
      w: cell.w,
      h: cell.h,
    });
    const cells = store.cells.map((c, i) => ({ cell: c, box: place(i) }));
    const tail = place(store.cells.length);
    y += rows * (ROW_TOP + cell.h + ROW_BOTTOM) + 10;
    return {
      store,
      cells,
      tail,
      per_row,
      x: PAD - 8,
      y: top,
      w: inner + 16,
      h: y - top - 4,
    };
  });

  // the stream table and the target table: side by side when wide
  y += 6;
  const streams_rows: StreamRow[] = [];
  for (const s of world.stores)
    for (const c of s.cells) {
      if (c.leaving) continue;
      const row = streams_rows.find(
        (r) => r.stream === c.stream && r.store === s.name
      );
      if (row) {
        row.head = Math.max(row.head, c.version);
        row.count++;
      } else
        streams_rows.push({
          stream: c.stream,
          store: s.name,
          head: c.version,
          count: 1,
          box: { x: 0, y: 0, w: 0, h: 0 },
        });
    }
  const col_w = mode === "wide" ? (inner - 20) / 2 : inner;
  const sx = PAD;
  const tx = mode === "wide" ? PAD + col_w + 20 : PAD;
  let sy = y + SECTION_HEAD;
  for (const r of streams_rows) {
    r.box = { x: sx, y: sy, w: col_w, h: TABLE_ROW };
    sy += TABLE_ROW;
  }
  const streams = {
    box: { x: sx, y, w: col_w, h: Math.max(sy - y, SECTION_HEAD + TABLE_ROW) },
    rows: streams_rows,
  };
  if (mode === "narrow") y = y + streams.box.h + 14;
  let ty = y + SECTION_HEAD;
  const target_rows: TargetRow[] = world.targets.map((target) => {
    const box = { x: tx, y: ty, w: col_w, h: TABLE_ROW };
    ty += TABLE_ROW;
    return { target, box };
  });
  const targets = {
    box: { x: tx, y, w: col_w, h: Math.max(ty - y, SECTION_HEAD + TABLE_ROW) },
    rows: target_rows,
  };
  y =
    Math.max(streams.box.y + streams.box.h, targets.box.y + targets.box.h) + 14;

  // read models, two to a line when wide
  const tables: TableBox[] = [];
  let line_h = 0;
  world.tables.forEach((table, i) => {
    const col = mode === "wide" ? i % 2 : 0;
    if (col === 0 && i > 0) {
      y += line_h + 12;
      line_h = 0;
    }
    const h = SECTION_HEAD + Math.max(1, table.rows.length) * TABLE_ROW + 6;
    tables.push({ table, box: { x: col === 0 ? sx : tx, y, w: col_w, h } });
    line_h = Math.max(line_h, h);
  });
  if (tables.length) y += line_h + 12;

  const height = Math.max(y + 4, 200);

  const anchor = (a: Anchor) => {
    const center = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
    if (a.startsWith("cell:")) {
      const uid = world.refs[a.slice(5)];
      for (const s of stores) {
        const c = s.cells.find((x) => x.cell.uid === uid);
        if (c) return center(c.box);
      }
      return undefined;
    }
    if (a === "log") return center(stores[0]!.tail);
    if (a.startsWith("log:")) {
      const s = stores.find((x) => x.store.name === a.slice(4));
      return s && center(s.tail);
    }
    if (a.startsWith("stream:")) {
      const r = streams_rows.find((x) => x.stream === a.slice(7));
      return r && { x: r.box.x + 60, y: r.box.y + r.box.h / 2 };
    }
    if (a.startsWith("target:")) {
      const r = target_rows.find((x) => x.target.id === a.slice(7));
      return r && { x: r.box.x + 60, y: r.box.y + r.box.h / 2 };
    }
    if (a.startsWith("table:")) {
      const t = tables.find((x) => x.table.name === a.slice(6));
      return t && { x: t.box.x + t.box.w / 2, y: t.box.y + 14 };
    }
    if (a.startsWith("store:")) {
      const s = stores.find((x) => x.store.name === a.slice(6));
      return s && { x: s.x + s.w / 2, y: s.y + 14 };
    }
    const n = placed.find((x) => x.node.id === a);
    return n && center(n.box);
  };

  return {
    width,
    height,
    cell,
    nodes: placed,
    app,
    stores,
    streams,
    targets,
    tables,
    anchor,
  };
}
