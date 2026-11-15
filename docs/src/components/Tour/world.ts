/**
 * Folds a tour's ops into worlds, one per step. A world is what the stage
 * draws: the stores and their logs, the reaction targets, the read models, the
 * state cards. Items an op touched in the current step carry `fresh`, and
 * cells it deleted carry `leaving` for that step only, so the stage can
 * animate both and stepping back is just showing an earlier world.
 */
import type {
  Chapter,
  EventIn,
  Op,
  Scene,
  Step,
  Tone,
  TourSpec,
} from "./types";

export type CellKind = "event" | "snapshot" | "tombstone";

export type Cell = {
  uid: number;
  id: number;
  stream: string;
  version: number;
  name: string;
  kind: CellKind;
  data?: Record<string, unknown>;
  pii?: Record<string, unknown>;
  shredded?: boolean;
  ref?: string;
  corr: string;
  cause?: { id: number; name: string };
  bracket?: string;
  /** the commit the cell landed in */
  commit?: number;
  fresh?: boolean;
  leaving?: boolean;
  moved?: boolean;
};

export type Target = {
  id: string;
  store: string;
  source?: string;
  lane: string;
  priority?: number;
  /** uid of the last acked cell, -1 for none */
  at: number;
  mark?: number;
  lease?: string;
  retry: number;
  due?: string;
  blocked?: string;
  fresh?: boolean;
};

export type Ghost = { stream: string; name: string; error: string };

export type Store = {
  name: string;
  label: string;
  cells: Cell[];
  next_id: number;
  checkpoint: number;
  status?: { text: string; tone?: Tone };
  dim_from?: number;
  /** only this stream reads at full strength (a stream query) */
  only?: string;
  ghost?: Ghost;
};

export type Table = {
  name: string;
  title: string;
  rows: [string, Record<string, unknown>][];
  fresh: string[];
};

export type World = {
  stores: Store[];
  targets: Target[];
  tables: Table[];
  states: Record<
    string,
    { data: Record<string, unknown>; version?: number; fresh?: boolean }
  >;
  flags: Record<string, { text: string; tone?: Tone }>;
  refs: Record<string, number>;
  next_uid: number;
  next_corr: number;
  next_commit: number;
  /** what this step did, one line per operation, for the activity feed */
  feed: string[];
};

export type Frame = {
  chapter: number;
  scene: number;
  step: number;
  /** index of the first frame of this chapter and of this scene */
  chapter_start: number;
  scene_start: number;
  world: World;
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function empty(spec: TourSpec): World {
  return {
    stores: spec.stores.map((s) => ({
      ...s,
      cells: [],
      next_id: 0,
      checkpoint: -1,
    })),
    targets: [],
    tables: [],
    states: {},
    flags: {},
    refs: {},
    next_uid: 0,
    next_corr: 0,
    next_commit: 0,
    feed: [],
  };
}

/** Clears the marks of the previous step and drops the cells it deleted. */
function settle(w: World) {
  for (const s of w.stores) {
    s.cells = s.cells.filter((c) => !c.leaving);
    for (const c of s.cells) {
      delete c.fresh;
      delete c.moved;
    }
    delete s.ghost;
  }
  for (const t of w.targets) delete t.fresh;
  for (const t of w.tables) t.fresh = [];
  w.feed = [];
  for (const k of Object.keys(w.states)) delete w.states[k]!.fresh;
}

export const DEFAULT_STORE = "main";

function store_of(w: World, name = w.stores[0]?.name ?? DEFAULT_STORE): Store {
  const s = w.stores.find((x) => x.name === name);
  if (!s) throw new Error(`tour: unknown store "${name}"`);
  return s;
}

/** The cell a ref names, in any store. */
export function find_cell(
  w: World,
  ref: string
): { store: Store; cell: Cell } | undefined {
  const uid = w.refs[ref];
  if (uid === undefined) return undefined;
  for (const store of w.stores) {
    const cell = store.cells.find((c) => c.uid === uid);
    if (cell) return { store, cell };
  }
  return undefined;
}

function uid_of(w: World, ref: string): number {
  const uid = w.refs[ref];
  if (uid === undefined) throw new Error(`tour: unknown cell ref "${ref}"`);
  return uid;
}

function head(store: Store, stream: string): number {
  let v = -1;
  for (const c of store.cells)
    if (c.stream === stream && !c.leaving && c.version > v) v = c.version;
  return v;
}

function target_of(w: World, id: string): Target {
  const t = w.targets.find((x) => x.id === id);
  if (!t) throw new Error(`tour: unknown target "${id}"`);
  return t;
}

function append(
  w: World,
  store: Store,
  e: Omit<EventIn, "cause"> & {
    kind?: CellKind;
    cause?: string;
    version?: number;
  },
  corr: string,
  fresh: boolean,
  bracket?: string
) {
  const cause = e.cause ? find_cell(w, e.cause)?.cell : undefined;
  const cell: Cell = {
    uid: w.next_uid++,
    id: store.next_id++,
    stream: e.stream,
    version: e.version ?? head(store, e.stream) + 1,
    name: e.name,
    kind:
      e.kind ??
      (e.name === "__snapshot__"
        ? "snapshot"
        : e.name === "__tombstone__"
          ? "tombstone"
          : "event"),
    corr,
    ...(e.data && { data: e.data }),
    ...(e.pii && { pii: e.pii }),
    ...(e.ref && { ref: e.ref }),
    ...(cause && { cause: { id: cause.id, name: cause.name } }),
    ...(bracket && { bracket }),
    ...(fresh && { fresh: true }),
  };
  if (e.ref) w.refs[e.ref] = cell.uid;
  store.cells.push(cell);
  return cell;
}

function corr_for(w: World, events: EventIn[]): string {
  const named = events.find((e) => e.corr)?.corr;
  if (named) return named;
  const caused = events.find((e) => e.cause);
  if (caused) {
    const c = find_cell(w, caused.cause!);
    if (c) return c.cell.corr;
  }
  return `c${++w.next_corr}`;
}

function commit(
  w: World,
  events: EventIn[],
  store_name: string | undefined,
  fresh: boolean,
  bracket?: string
) {
  const store = store_of(w, store_name);
  const corr = corr_for(w, events);
  const commit = ++w.next_commit;
  for (const e of events)
    append(w, store, e, corr, fresh, bracket).commit = commit;
}

function apply(w: World, op: Op) {
  switch (op.op) {
    case "commit":
      return commit(
        w,
        op.events,
        op.store,
        true,
        op.bracket ?? (op.events.length > 1 ? "one commit" : undefined)
      );
    case "snapshot": {
      const store = store_of(w, op.store);
      const last = [...store.cells]
        .reverse()
        .find((c) => c.stream === op.stream && !c.leaving);
      append(
        w,
        store,
        {
          stream: op.stream,
          name: "__snapshot__",
          kind: "snapshot",
          data: op.data,
          ref: op.ref,
        },
        last?.corr ?? `c${++w.next_corr}`,
        true
      );
      return;
    }
    case "refuse":
      store_of(w, op.store).ghost = {
        stream: op.stream,
        name: op.name,
        error: op.error,
      };
      return;
    case "target": {
      const existing = w.targets.find((t) => t.id === op.id);
      const t: Target = existing ?? {
        id: op.id,
        store: op.store ?? w.stores[0]!.name,
        lane: "default",
        at: -1,
        retry: 0,
      };
      if (op.source !== undefined) t.source = op.source;
      if (op.lane !== undefined) t.lane = op.lane;
      if (op.priority !== undefined) t.priority = op.priority;
      t.fresh = true;
      if (!existing) w.targets.push(t);
      return;
    }
    case "untarget":
      w.targets = w.targets.filter((t) => t.id !== op.id);
      return;
    case "checkpoint":
      store_of(w, op.store).checkpoint = uid_of(w, op.at);
      return;
    case "mark": {
      const t = target_of(w, op.target);
      t.mark = uid_of(w, op.at);
      t.fresh = true;
      return;
    }
    case "lease": {
      const t = target_of(w, op.target);
      t.lease = op.by;
      t.fresh = true;
      return;
    }
    case "release": {
      const t = target_of(w, op.target);
      delete t.lease;
      t.fresh = true;
      return;
    }
    case "ack": {
      const t = target_of(w, op.target);
      t.at = uid_of(w, op.at);
      t.retry = 0;
      delete t.due;
      delete t.lease;
      t.fresh = true;
      return;
    }
    case "retry": {
      const t = target_of(w, op.target);
      t.retry = op.retry;
      if (op.due) t.due = op.due;
      else delete t.due;
      delete t.lease;
      t.fresh = true;
      return;
    }
    case "defer": {
      const t = target_of(w, op.target);
      t.due = op.due;
      delete t.lease;
      t.fresh = true;
      return;
    }
    case "block": {
      const t = target_of(w, op.target);
      t.blocked = op.error;
      delete t.lease;
      delete t.due;
      t.fresh = true;
      return;
    }
    case "unblock": {
      const t = target_of(w, op.target);
      delete t.blocked;
      t.retry = 0;
      t.fresh = true;
      return;
    }
    case "reset": {
      const t = target_of(w, op.target);
      t.at = -1;
      t.retry = 0;
      delete t.blocked;
      delete t.due;
      t.fresh = true;
      return;
    }
    case "truncate": {
      const store = store_of(w, op.store);
      for (const c of store.cells) if (c.stream === op.stream) c.leaving = true;
      append(
        w,
        store,
        {
          stream: op.stream,
          name: op.seed === "tombstone" ? "__tombstone__" : "__snapshot__",
          kind: op.seed,
          data: op.data,
          ref: op.ref,
          version: 0,
        },
        `c${++w.next_corr}`,
        true
      );
      return;
    }
    case "prune": {
      const store = store_of(w, op.store);
      const below = find_cell(w, op.below)?.cell;
      if (!below) throw new Error(`tour: unknown cell ref "${op.below}"`);
      for (const c of store.cells)
        if (c.stream === op.stream && c.id < below.id) c.leaving = true;
      return;
    }
    case "forget": {
      const store = store_of(w, op.store);
      for (const c of store.cells)
        if (c.stream === op.stream && c.pii) {
          c.shredded = true;
          c.moved = true;
        }
      return;
    }
    case "restore": {
      const sink = store_of(w, op.store);
      const source = store_of(w, op.from ?? sink.name);
      const seen = new Set<string>();
      const kept: Cell[] = [];
      for (const c of source.cells) {
        if (c.leaving) continue;
        const first = !seen.has(c.stream);
        seen.add(c.stream);
        if (op.dropSnapshots && c.kind === "snapshot" && !first) continue;
        kept.push(c);
      }
      const ids = new Map<number, number>();
      const rebuilt = kept.map((c, i) => {
        ids.set(c.id, i);
        const name = op.rename?.[c.name] ?? c.name;
        return {
          ...clone(c),
          id: i,
          name,
          moved: true,
          uid: source === sink ? c.uid : w.next_uid++,
        };
      });
      for (const c of rebuilt) {
        if (c.cause)
          c.cause = {
            id: ids.get(c.cause.id) ?? -1,
            name: op.rename?.[c.cause.name] ?? c.cause.name,
          };
        if (c.ref && source !== sink) w.refs[c.ref] = c.uid;
      }
      if (source === sink) {
        const by_uid = new Map(rebuilt.map((c) => [c.uid, c]));
        sink.cells = sink.cells.map(
          (c) => by_uid.get(c.uid) ?? { ...c, leaving: true }
        );
      } else {
        for (const c of sink.cells) c.leaving = true;
        sink.cells = [
          ...sink.cells,
          ...rebuilt.map((c) => ({ ...c, fresh: true })),
        ];
      }
      sink.next_id = rebuilt.length;
      sink.checkpoint = -1;
      return;
    }
    case "store": {
      const existing = w.stores.find((s) => s.name === op.name);
      if (op.remove) {
        w.stores = w.stores.filter((s) => s.name !== op.name);
        w.targets = w.targets.filter((t) => t.store !== op.name);
      } else if (existing) existing.label = op.label;
      else
        w.stores.push({
          name: op.name,
          label: op.label,
          cells: [],
          next_id: 0,
          checkpoint: -1,
        });
      return;
    }
    case "status": {
      const store = store_of(w, op.store);
      if (op.text)
        store.status = { text: op.text, ...(op.tone && { tone: op.tone }) };
      else delete store.status;
      return;
    }
    case "table": {
      const existing = w.tables.find((t) => t.name === op.name);
      if (op.remove) {
        w.tables = w.tables.filter((t) => t.name !== op.name);
        return;
      }
      const t = existing ?? {
        name: op.name,
        title: op.title ?? op.name,
        rows: [],
        fresh: [],
      };
      if (op.title) t.title = op.title;
      if (op.clear) t.rows = [];
      if (!existing) w.tables.push(t);
      return;
    }
    case "row": {
      const t = w.tables.find((x) => x.name === op.table);
      if (!t) throw new Error(`tour: unknown table "${op.table}"`);
      const i = t.rows.findIndex(([k]) => k === op.key);
      if (i >= 0) t.rows[i] = [op.key, op.values];
      else t.rows.push([op.key, op.values]);
      t.fresh.push(op.key);
      return;
    }
    case "state":
      if (op.data === null) delete w.states[op.node];
      else
        w.states[op.node] = {
          data: op.data,
          ...(op.version !== undefined && { version: op.version }),
          fresh: true,
        };
      return;
    case "dim": {
      const store = store_of(w, op.store);
      if (op.from) store.dim_from = find_cell(w, op.from)?.cell.id;
      else delete store.dim_from;
      if (op.only) store.only = op.only;
      else delete store.only;
      return;
    }
    case "flag":
      w.flags[op.on] = { text: op.text, ...(op.tone && { tone: op.tone }) };
      return;
    case "unflag":
      if (op.on) delete w.flags[op.on];
      else w.flags = {};
      return;
  }
}

const at_id = (w: World, ref: string) => {
  const c = find_cell(w, ref)?.cell;
  return c ? `#${c.id}` : "?";
};
const cell_line = (c: Cell) =>
  `#${c.id} \`${c.name}\` · ${c.stream} v${c.version}`;

/** One feed line per operation, from the world just after it ran. */
function narrate(w: World, op: Op) {
  const say = (line: string) => w.feed.push(line);
  switch (op.op) {
    case "commit": {
      const store = store_of(w, op.store);
      const cells = store.cells.slice(-op.events.length);
      const one = cells.length > 1 ? " (one commit)" : "";
      for (const c of cells) say(`${cell_line(c)} committed${one}`);
      return;
    }
    case "snapshot":
    case "truncate": {
      const c = store_of(w, op.store).cells.at(-1);
      if (op.op === "truncate") say(`${op.stream}: events deleted`);
      if (c)
        say(`${cell_line(c)} ${op.op === "truncate" ? "seeded" : "committed"}`);
      return;
    }
    case "refuse":
      return say(
        `refused: \`${op.error}\` · ${op.name} on ${op.stream}, nothing stored`
      );
    case "target":
      return say(
        `target \`${op.id}\` subscribed${op.lane ? ` on lane ${op.lane}` : ""}${op.priority !== undefined ? `, priority ${op.priority}` : ""}`
      );
    case "untarget":
      return say(`target \`${op.id}\` done`);
    case "checkpoint":
      return say(`correlate checkpoint → ${at_id(w, op.at)}`);
    case "mark":
      return say(`work marked on \`${op.target}\` up to ${at_id(w, op.at)}`);
    case "lease":
      return say(`\`${op.target}\` leased by ${op.by}`);
    case "release":
      return say(`lease on \`${op.target}\` released`);
    case "ack":
      return say(
        `\`${op.target}\` acked at ${at_id(w, op.at)}, lease released`
      );
    case "retry":
      return say(
        `\`${op.target}\` failed: retry ${op.retry}${op.due ? `, due in ${op.due}` : ""}`
      );
    case "defer":
      return say(`\`${op.target}\` deferred until ${op.due}`);
    case "block":
      return say(`\`${op.target}\` blocked: ${op.error}`);
    case "unblock":
      return say(`\`${op.target}\` unblocked`);
    case "reset":
      return say(`\`${op.target}\` reset: watermark −1`);
    case "prune": {
      const n = store_of(w, op.store).cells.filter(
        (c) => c.leaving && c.stream === op.stream
      ).length;
      return say(
        `${op.stream}: ${n} events pruned below ${at_id(w, op.below)}`
      );
    }
    case "forget": {
      const n = store_of(w, op.store).cells.filter(
        (c) => c.stream === op.stream && c.shredded
      ).length;
      return say(`${op.stream}: pii wiped on ${n} event${n === 1 ? "" : "s"}`);
    }
    case "restore": {
      const sink = store_of(w, op.store);
      const n = sink.cells.filter((c) => !c.leaving).length;
      return say(
        `restored ${n} events into ${sink.label}, ids #0 to #${n - 1}`
      );
    }
    case "store":
      return say(op.remove ? `store ${op.name} removed` : `store: ${op.label}`);
    case "status":
      return op.text
        ? say(`${store_of(w, op.store).label}: ${op.text}`)
        : undefined;
    case "table":
      return op.clear
        ? say(`${op.name} emptied`)
        : op.remove
          ? undefined
          : say(`read model ${op.title ?? op.name}`);
    case "row": {
      // rows flushed together read as one line
      const last = w.feed.length - 1;
      const head = `${op.table}: `;
      if (
        w.feed[last]?.startsWith(head) &&
        w.feed[last]!.endsWith(" written")
      ) {
        const n = w.feed[last]!.match(/(\d+) rows? written$/)?.[1] ?? "1";
        w.feed[last] = `${head}${Number(n) + 1} rows written`;
        return;
      }
      return say(`${head}1 row written`);
    }
    default:
      return;
  }
}

/** Every step of the tour, in order, with the world after it. */
export function frames(spec: TourSpec): Frame[] {
  const out: Frame[] = [];
  let w = empty(spec);
  spec.chapters.forEach((chapter: Chapter, ci) => {
    const chapter_start = out.length;
    // a chapter starts with no notes, cards or badges left from the last one
    w = clone(w);
    w.flags = {};
    w.states = {};
    for (const s of w.stores) {
      delete s.status;
      delete s.dim_from;
      delete s.only;
    }
    if (chapter.seed) {
      w = empty(spec);
      // seeded events commit one per correlation, unless they name a cause
      for (const e of chapter.seed) commit(w, [e], undefined, false);
    }
    chapter.scenes.forEach((scene: Scene, si) => {
      const scene_start = out.length;
      scene.steps.forEach((step: Step, ti) => {
        w = clone(w);
        settle(w);
        for (const op of step.ops ?? []) {
          apply(w, op);
          narrate(w, op);
        }
        out.push({
          chapter: ci,
          scene: si,
          step: ti,
          chapter_start,
          scene_start,
          world: w,
        });
      });
    });
  });
  return out;
}
