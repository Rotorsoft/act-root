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
  History,
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
  /** its id before a restore renumbered it, for the slide */
  from_id?: number;
};

export type Target = {
  id: string;
  reaction?: string;
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

export type Ghost = {
  stream: string;
  name: string;
  error: string;
  expected?: number;
  actual?: number;
};

/** Where the action layer stopped an action this step. */
export type Stop = {
  stage: string;
  error: string;
  name: string;
  stream: string;
};

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
  /** the generated events, at scale, drawn as the field of dots */
  bulk: Bulk;
  /** events archived by closes so far */
  archived: number;
  /** where the field's scan cursor stopped, and this step's sweep */
  scan_at: number;
  scan?: { from: number; to: number };
  /** streams leased by a worker: their dots glow */
  glows: { stream: string; worker: string; tone?: Tone }[];
};

/** One generated event; frames share these and keep only ids and flags per store. */
export type BaseEvent = {
  stream: string;
  name: string;
  kind: CellKind;
  day: number;
  version: number;
  pii: boolean;
};

/** Flags on a bulk event in one store. */
export const B_LEAVING = 1;
export const B_ARCHIVED = 2;
export const B_SHREDDED = 4;
export const B_FRESH = 8;

/** Per store, in id order: the base event, its id here, its flags. */
export type Bulk = { idx: number[]; id: number[]; st: number[] };

export type Table = {
  /** rows the read model holds in all, when it holds more than the rows drawn */
  total?: number;
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
  /** the last id each ref'd cell had, for lines about a cell already deleted */
  ids: Record<string, number>;
  next_uid: number;
  next_corr: number;
  next_commit: number;
  /** what this step did, one line per operation, for the activity feed */
  feed: string[];
  /** the head version of each generated stream, by store */
  bulk_versions: Record<string, number>;
  /** counts this step's operations produced, for the Now line and the feed */
  facts: Record<string, number>;
  /** an action the action layer refused this step */
  stop?: Stop;
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
      bulk: { idx: [], id: [], st: [] },
      archived: 0,
      scan_at: -1,
      glows: [],
    })),
    targets: [],
    tables: [],
    states: {},
    flags: {},
    refs: {},
    ids: {},
    next_uid: 0,
    next_corr: 0,
    next_commit: 0,
    feed: [],
    bulk_versions: {},
    facts: {},
  };
}

/** Clears the marks of the previous step and drops the cells it deleted. */
function settle(w: World) {
  for (const s of w.stores) {
    s.cells = s.cells.filter((c) => !c.leaving);
    for (const c of s.cells) {
      delete c.fresh;
      delete c.moved;
      delete c.from_id;
    }
    delete s.ghost;
    delete s.scan;
    const b = s.bulk as Bulk & { from?: number[] };
    delete b.from;
    const keep = b.st.map((f) => !(f & B_LEAVING));
    b.idx = b.idx.filter((_, i) => keep[i]);
    b.id = b.id.filter((_, i) => keep[i]);
    b.st = b.st
      .filter((_, i) => keep[i])
      .map((f) => f & ~B_FRESH & ~B_ARCHIVED);
  }
  for (const t of w.targets) delete t.fresh;
  for (const t of w.tables) t.fresh = [];
  w.feed = [];
  w.facts = {};
  delete w.stop;
  for (const k of Object.keys(w.states)) delete w.states[k]!.fresh;
}

export const DEFAULT_STORE = "main";

// the generated events of the fold being built; frames refer to them by index
let BASE: BaseEvent[] = [];

/** A small seeded generator, so a history is the same on every render. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function push_bulk(w: World, store: Store, e: BaseEvent, fresh: boolean) {
  BASE.push(e);
  store.bulk.idx.push(BASE.length - 1);
  store.bulk.id.push(store.next_id++);
  store.bulk.st.push(fresh ? B_FRESH : 0);
  w.bulk_versions[`${store.name}/${e.stream}`] = e.version;
}

/**
 * Generates `events` events over `days` days. Each kind's streams are born
 * over the period and get most of their traffic while young, so old streams
 * go quiet the way tickets do.
 */
function generate(
  w: World,
  store: Store,
  h: Pick<History, "seed" | "events" | "days" | "kinds"> & { day0?: number },
  fresh: boolean
) {
  const r = rng(h.seed);
  const total = h.kinds.reduce((n, k) => n + k.weight, 0);
  const day0 = h.day0 ?? 0;
  for (let i = 0; i < h.events; i++) {
    const f = (i + 1) / h.events;
    let pick = r() * total;
    const kind = h.kinds.find((k) => (pick -= k.weight) < 0) ?? h.kinds[0]!;
    const newest = Math.max(
      0,
      Math.min(kind.count - 1, Math.floor(f * kind.count))
    );
    const window = Math.max(3, Math.round(kind.count * 0.15));
    const j = Math.max(
      0,
      newest - Math.floor(r() * r() * Math.min(newest + 1, window))
    );
    const stream = `${kind.prefix}-${1000 + j}`;
    const key = `${store.name}/${stream}`;
    const v = (w.bulk_versions[key] ?? -1) + 1;
    const cycle = Math.max(1, kind.events.length - 1);
    const name =
      v === 0
        ? kind.events[0]!
        : (kind.events[1 + ((v - 1) % cycle)] ?? kind.events[0]!);
    const day = day0 + Math.floor(f * h.days);
    push_bulk(
      w,
      store,
      { stream, name, kind: "event", day, version: v, pii: !!kind.pii },
      fresh
    );
    if (kind.snapEvery && (v + 1) % kind.snapEvery === 0)
      push_bulk(
        w,
        store,
        {
          stream,
          name: "__snapshot__",
          kind: "snapshot",
          day,
          version: v + 1,
          pii: false,
        },
        fresh
      );
  }
}

/** The bulk events of a store, alive, grouped by stream in id order. */
function bulk_streams(store: Store) {
  const by = new Map<string, number[]>();
  const b = store.bulk;
  b.idx.forEach((ix, i) => {
    if (b.st[i]! & B_LEAVING) return;
    const s = BASE[ix]!.stream;
    const list = by.get(s);
    if (list) list.push(i);
    else by.set(s, [i]);
  });
  return by;
}

/** What a store holds right now, for the counter and the Now lines. */
export function census(store: Store, base: BaseEvent[]) {
  const heads = new Map<string, { id: number; kind: CellKind }>();
  let events = 0;
  let snapshots = 0;
  const b = store.bulk;
  b.idx.forEach((ix, i) => {
    if (b.st[i]! & B_LEAVING) return;
    const e = base[ix]!;
    events++;
    if (e.kind === "snapshot") snapshots++;
    const h = heads.get(e.stream);
    if (!h || b.id[i]! > h.id)
      heads.set(e.stream, { id: b.id[i]!, kind: e.kind });
  });
  for (const c of store.cells) {
    if (c.leaving) continue;
    events++;
    if (c.kind === "snapshot") snapshots++;
    const h = heads.get(c.stream);
    if (!h || c.id > h.id) heads.set(c.stream, { id: c.id, kind: c.kind });
  }
  let closed = 0;
  for (const h of heads.values()) if (h.kind === "tombstone") closed++;
  return {
    events,
    streams: heads.size,
    closed,
    snapshots,
    archived: store.archived,
  };
}

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
  if (e.ref) {
    w.refs[e.ref] = cell.uid;
    w.ids[e.ref] = cell.id;
  }
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
        ...(op.expected !== undefined && { expected: op.expected }),
        ...(op.actual !== undefined && { actual: op.actual }),
      };
      return;
    case "reject":
      w.stop = {
        stage: op.stage,
        error: op.error,
        name: op.name,
        stream: op.stream,
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
      if (op.reaction !== undefined) t.reaction = op.reaction;
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
      store.bulk.idx.forEach((ix, i) => {
        if (BASE[ix]!.stream === op.stream && BASE[ix]!.pii)
          store.bulk.st[i] = store.bulk.st[i]! | B_SHREDDED;
      });
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
      // bulk and cells, merged in id order, as the scan reads them
      type Entry = {
        id: number;
        stream: string;
        kind: CellKind;
        b?: number;
        c?: Cell;
      };
      const entries: Entry[] = [];
      source.bulk.idx.forEach((ix, i) => {
        if (source.bulk.st[i]! & B_LEAVING) return;
        entries.push({
          id: source.bulk.id[i]!,
          stream: BASE[ix]!.stream,
          kind: BASE[ix]!.kind,
          b: i,
        });
      });
      for (const c of source.cells)
        if (!c.leaving)
          entries.push({ id: c.id, stream: c.stream, kind: c.kind, c });
      entries.sort((x, y) => x.id - y.id);
      const seen = new Set<string>();
      const kept = entries.filter((e) => {
        const first = !seen.has(e.stream);
        seen.add(e.stream);
        return !(op.dropSnapshots && e.kind === "snapshot" && !first);
      });
      w.facts.dropped = entries.length - kept.length;
      w.facts.restored = kept.length;
      const ids = new Map<number, number>(kept.map((e, i) => [e.id, i]));
      const bulk: Bulk & { from: number[] } = {
        idx: [],
        id: [],
        st: [],
        from: [],
      };
      const cells: Cell[] = [];
      kept.forEach((e, i) => {
        if (e.b !== undefined) {
          let ix = source.bulk.idx[e.b]!;
          const name = op.rename?.[BASE[ix]!.name];
          if (name) {
            BASE.push({ ...BASE[ix]!, name });
            ix = BASE.length - 1;
          }
          bulk.idx.push(ix);
          bulk.id.push(i);
          bulk.st.push((source.bulk.st[e.b]! & B_SHREDDED) | B_FRESH);
          bulk.from.push(e.id);
        } else {
          const c = e.c!;
          const moved: Cell = {
            ...clone(c),
            id: i,
            name: op.rename?.[c.name] ?? c.name,
            moved: true,
            from_id: c.id,
            uid: source === sink ? c.uid : w.next_uid++,
          };
          if (moved.cause)
            moved.cause = {
              id: ids.get(moved.cause.id) ?? -1,
              name: op.rename?.[moved.cause.name] ?? moved.cause.name,
            };
          if (moved.ref && source !== sink) w.refs[moved.ref] = moved.uid;
          if (moved.ref) w.ids[moved.ref] = moved.id;
          cells.push(source === sink ? moved : { ...moved, fresh: true });
        }
      });
      for (const c of sink.cells) c.leaving = true;
      sink.cells =
        source === sink
          ? cells
          : [...sink.cells.filter((c) => c.leaving), ...cells];
      const old = sink.bulk;
      sink.bulk = bulk;
      if (source !== sink) {
        // the sink's old contents go
        old.idx.forEach((ix, i) => {
          bulk.idx.push(ix);
          bulk.id.push(old.id[i]!);
          bulk.st.push(B_LEAVING);
          bulk.from.push(old.id[i]!);
        });
      }
      sink.next_id = kept.length;
      sink.checkpoint = -1;
      sink.scan_at = -1;
      return;
    }
    case "project": {
      const store = store_of(w, op.store);
      const t = w.tables.find((x) => x.name === op.table);
      if (!t) throw new Error(`tour: unknown table "${op.table}"`);
      const rows = new Set<string>();
      let events = 0;
      const own = (stream: string) => stream.startsWith(`${op.prefix}-`);
      store.bulk.idx.forEach((ix, i) => {
        const e = BASE[ix]!;
        if (
          store.bulk.st[i]! & B_LEAVING ||
          !own(e.stream) ||
          e.kind !== "event"
        )
          return;
        rows.add(e.stream);
        events++;
      });
      for (const c of store.cells)
        if (!c.leaving && own(c.stream) && c.kind === "event") {
          rows.add(c.stream);
          events++;
        }
      t.total = rows.size;
      w.facts.rows = rows.size;
      w.facts.replayed = events;
      return;
    }
    case "burst": {
      const store = store_of(w, op.store);
      const before = store.next_id;
      generate(
        w,
        store,
        {
          seed: op.seed,
          events: op.count,
          days: 1,
          kinds: op.kinds,
          day0: op.day,
        },
        true
      );
      w.facts.burst = store.next_id - before;
      return;
    }
    case "retire": {
      const store = store_of(w, op.store);
      const streams = bulk_streams(store);
      const chosen: string[] = [];
      for (const [stream, at] of streams) {
        if (chosen.length >= op.count) break;
        if (!stream.startsWith(`${op.prefix}-`)) continue;
        const last = at[at.length - 1]!;
        const head = BASE[store.bulk.idx[last]!]!;
        if (head.kind === "tombstone" || head.day > op.idle) continue;
        if (op.is && !op.is.includes(head.name)) continue;
        chosen.push(stream);
      }
      let events = 0;
      for (const stream of chosen) {
        for (const i of streams.get(stream)!) {
          store.bulk.st[i] =
            store.bulk.st[i]! | B_LEAVING | (op.archive ? B_ARCHIVED : 0);
          events++;
        }
        push_bulk(
          w,
          store,
          {
            stream,
            name: "__tombstone__",
            kind: "tombstone",
            day: op.idle,
            version: 0,
            pii: false,
          },
          true
        );
      }
      if (op.archive) store.archived += events;
      w.facts.retired = chosen.length;
      w.facts.retired_events = events;
      return;
    }
    case "keep": {
      const store = store_of(w, op.store);
      let pruned = 0;
      let streams_pruned = 0;
      for (const [stream, at] of bulk_streams(store)) {
        if (!stream.startsWith(`${op.prefix}-`)) continue;
        // the closest snapshot older than the cutoff, and nothing below it survives
        let floor = -1;
        for (const i of at) {
          const e = BASE[store.bulk.idx[i]!]!;
          if (e.kind === "snapshot" && e.day < op.cutoff)
            floor = store.bulk.id[i]!;
        }
        if (floor < 0) continue;
        let n = 0;
        for (const i of at)
          if (store.bulk.id[i]! < floor) {
            store.bulk.st[i] = store.bulk.st[i]! | B_LEAVING;
            n++;
          }
        if (n) {
          pruned += n;
          streams_pruned++;
        }
      }
      w.facts.pruned = pruned;
      w.facts.pruned_streams = streams_pruned;
      return;
    }
    case "scan": {
      const store = store_of(w, op.store);
      const tail = store.next_id - 1;
      const from = op.from === "start" ? -1 : store.scan_at;
      store.scan = { from, to: tail };
      store.scan_at = tail;
      w.facts.scanned = tail - from;
      return;
    }
    case "glow": {
      const store = store_of(w, op.store);
      if (!op.worker) {
        store.glows = [];
        return;
      }
      // the streams named, or those with the latest activity, newest first
      const recent: string[] = [...(op.streams ?? [])];
      for (
        let i = store.bulk.idx.length - 1;
        !op.streams && i >= 0 && recent.length < (op.count ?? 6);
        i--
      ) {
        const e = BASE[store.bulk.idx[i]!]!;
        if (store.bulk.st[i]! & B_LEAVING) continue;
        if (op.prefix && !e.stream.startsWith(`${op.prefix}-`)) continue;
        if (
          store.glows.some((g) => g.stream === e.stream) ||
          recent.includes(e.stream)
        )
          continue;
        recent.push(e.stream);
      }
      for (const stream of recent)
        store.glows.push({
          stream,
          worker: op.worker,
          ...(op.tone && { tone: op.tone }),
        });
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
          bulk: { idx: [], id: [], st: [] },
          archived: 0,
          scan_at: -1,
          glows: [],
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

/** A count as people write it: 1,842. */
export const fmt = (n: number) => n.toLocaleString("en-US");

/**
 * Fills a spec line from the world: `{#ref}` is the id of a stored cell
 * (`{@ref}` without the `#`),
 * `{name}` a count this step produced (`retired`, `pruned`, …) or the first
 * store's census (`events`, `streams`, `closed`, `snapshots`, `archived`).
 * So every number the tour shows comes from the fold.
 */
export function fill(text: string, w: World, base: BaseEvent[]): string {
  return text.replace(
    /\{([#@]?)([\w-]+)\}/g,
    (all, hash: string, key: string) => {
      if (hash) {
        const id = find_cell(w, key)?.cell.id ?? w.ids[key];
        return id !== undefined ? `${hash === "#" ? "#" : ""}${id}` : all;
      }
      if (key in w.facts) return fmt(w.facts[key]!);
      const store = w.stores[0];
      if (store) {
        const n = census(store, base) as Record<string, number>;
        if (key in n) return fmt(n[key]!);
      }
      return all;
    }
  );
}

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
        `bounced at the store: \`${op.error}\` · ${op.stream}${op.expected !== undefined ? ` expected v${op.expected}` : ""}${op.actual !== undefined ? `, head v${op.actual}` : ""}; nothing appended`
      );
    case "reject":
      return say(
        `refused in the action layer at ${op.stage}: \`${op.error}\`; nothing sent to the store`
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
      return say(
        `restored ${fmt(w.facts.restored ?? 0)} events into ${sink.label}, ids #0 to #${fmt((w.facts.restored ?? 1) - 1)}${w.facts.dropped ? `, ${fmt(w.facts.dropped)} snapshots dropped` : ""}`
      );
    }
    case "burst":
      return say(`traffic: ${fmt(w.facts.burst ?? 0)} events committed`);
    case "retire":
      return say(
        `closed ${fmt(w.facts.retired ?? 0)} ${op.prefix} streams: ${fmt(w.facts.retired_events ?? 0)} events ${op.archive ? "archived and " : ""}deleted, one \`__tombstone__\` seed each`
      );
    case "keep":
      return say(
        `window kept: ${fmt(w.facts.pruned ?? 0)} events pruned on ${fmt(w.facts.pruned_streams ?? 0)} ${op.prefix} streams`
      );
    case "scan":
      return say(
        `${op.from === "start" ? "replay" : "correlate"} cursor swept ${fmt(w.facts.scanned ?? 0)} events`
      );
    case "glow":
      return op.worker
        ? say(
            op.streams
              ? `${op.streams.join(", ")} leased by ${op.worker}: its dots glow`
              : `${op.worker} leases ${op.count ?? 6} ${op.prefix ?? ""} streams`
          )
        : undefined;
    case "project":
      return say(
        `${op.table}: replayed ${fmt(w.facts.replayed ?? 0)} events → ${fmt(w.facts.rows ?? 0)} rows`
      );
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
export type Frames = Frame[] & { base: BaseEvent[] };

export function frames(spec: TourSpec): Frames {
  BASE = [];
  const out = [] as unknown as Frames;
  out.base = BASE;
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
      s.glows = [];
    }
    if (chapter.seed) {
      w = empty(spec);
      for (const h of chapter.history ?? [])
        generate(w, store_of(w, h.store), h, false);
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
