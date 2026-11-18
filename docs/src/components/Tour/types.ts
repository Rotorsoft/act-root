/**
 * The tour spec: chapters of scenes of steps. Each step says a line, may move
 * tokens between anchors, and applies ops to the world (the stores, their
 * logs, the reaction targets, the read models). The player folds the ops from
 * the start of the tour, so any step can be shown on its own. Nothing here
 * knows a domain: the spec file carries all of it.
 */

/** What a node in the app band stands for, which sets its color. */
export type Kind =
  | "actor"
  | "action"
  | "state"
  | "reaction"
  | "projection"
  | "external"
  | "worker"
  | "store";

export type Tone = "good" | "bad" | "warn" | "muted";

/** One box in the app band. State nodes show their data under the label. */
export type Node = { id: string; kind: Kind; label: string; sub?: string };

/** An event to append. `ref` names the stored cell for later ops and moves. */
export type EventIn = {
  stream: string;
  name: string;
  data?: Record<string, unknown>;
  /** sensitive fields, split off the data into the `pii` column */
  pii?: Record<string, unknown>;
  ref?: string;
  /** a ref of the event that caused this one; it then shares its correlation */
  cause?: string;
  /** names a new correlation; otherwise one is minted from the action */
  corr?: string;
};

/** Where a token starts or ends. */
export type Anchor =
  | string // a node id
  | `cell:${string}` // a stored cell by ref
  | `stream:${string}` // a row in the stream table
  | `target:${string}` // a row in the target table
  | `table:${string}` // a read model
  | `log` // the tail of the default store's log
  | `log:${string}`; // the tail of a named store's log

export type Move = {
  from: Anchor;
  to: Anchor;
  label?: string;
  tone?: Tone;
  /** travel with the previous move instead of after it */
  par?: boolean;
};

/**
 * Where a step stands in a multi-stage operation: the stages before `at` are
 * done, `at` is the active one (red with `fail`, and the rest never run), and
 * `at` past the last stage means all done. `name` picks one of the spec's
 * pipelines.
 */
export type Pipe = { name: string; at: number; fail?: boolean };

/** One kind of stream in a generated history: `prefix-<n>` streams, `count` of them. */
export type StreamKind = {
  prefix: string;
  count: number;
  /** relative share of the traffic */
  weight: number;
  /** the event names a stream of this kind cycles through (the first opens it) */
  events: string[];
  /** a __snapshot__ after every `snapEvery` events on a stream */
  snapEvery?: number;
  /** its events carry sensitive fields */
  pii?: boolean;
};

/** A deterministic history: the same seed always generates the same events. */
export type History = {
  seed: number;
  events: number;
  days: number;
  kinds: StreamKind[];
  store?: string;
};

/** The running app's anatomy, as its registry would list it. */
export type AppSpec = {
  /** how the app was built, shown under its name */
  title?: string;
  slices: {
    name: string;
    /** each state with its actions (inputs), its fields, and the events it emits (outputs) */
    states: {
      name: string;
      actions: string[];
      events: string[];
      fields?: string[];
    }[];
    reactions?: string[];
    /** a projection, its target, and what it folds or listens to */
    projections?: {
      name: string;
      target: string;
      of?: string;
      on?: string[];
    }[];
  }[];
  /** drain lanes beyond the default, with their budgets */
  lanes?: { name: string; budget: string }[];
  /** the event each reaction listens to, for the arrow from that event */
  listens?: Record<string, string>;
  /** the ports it is wired to: `store: PostgresStore`, … */
  ports?: string[];
  /** operator entry points: app.close, app.restore, … */
  ops?: string[];
  /**
   * The code behind an element, keyed by its name: a state, an action, a
   * reaction, a projection, `slice:<name>`, `lane:<name>`, `app.close`, …
   * Shown in a tooltip behind a `</>` icon.
   */
  code?: Record<string, string>;
};

export type Op =
  /** append events in one commit; each stream takes its next version */
  | { op: "commit"; events: EventIn[]; store?: string; bracket?: string }
  /** append a __snapshot__ on the stream's next version */
  | {
      op: "snapshot";
      stream: string;
      data?: Record<string, unknown>;
      ref?: string;
      store?: string;
    }
  /** a commit the store's version guard turns back (`ConcurrencyError`): a bounced ghost at the store's edge */
  | {
      op: "refuse";
      stream: string;
      name: string;
      error: string;
      expected?: number;
      actual?: number;
      store?: string;
    }
  /** an action refused in the app's action layer, at `stage`: nothing reaches the store */
  | { op: "reject"; stream: string; name: string; error: string; stage: string }
  /** subscribe a reaction target (a stream that reactions run on) */
  | {
      op: "target";
      id: string;
      /** the reaction or projection that runs on it */
      reaction?: string;
      source?: string;
      lane?: string;
      priority?: number;
      store?: string;
    }
  | { op: "untarget"; id: string }
  /** correlate's checkpoint, after the cell named */
  | { op: "checkpoint"; at: string; store?: string }
  /** the highest event a target has work for */
  | { op: "mark"; target: string; at: string }
  | { op: "lease"; target: string; by: string }
  | { op: "release"; target: string }
  /** the target's watermark moves past the cell named; clears retries and dues */
  | { op: "ack"; target: string; at: string }
  | { op: "retry"; target: string; retry: number; due?: string }
  | { op: "defer"; target: string; due: string }
  | { op: "block"; target: string; error: string }
  | { op: "unblock"; target: string }
  /** watermark back to -1 */
  | { op: "reset"; target: string }
  /** delete every cell of a stream and seed one cell at v0 */
  | {
      op: "truncate";
      stream: string;
      seed: "tombstone" | "snapshot";
      data?: Record<string, unknown>;
      ref?: string;
      store?: string;
    }
  /** delete the cells of a stream below the cell named */
  | { op: "prune"; stream: string; below: string; store?: string }
  /** wipe the pii of every cell of a stream */
  | { op: "forget"; stream: string; store?: string }
  /** rebuild a store from another (or itself): ids renumber densely */
  | {
      op: "restore";
      from?: string;
      store?: string;
      dropSnapshots?: boolean;
      rename?: Record<string, string>;
    }
  /** add a store (a second log) or relabel one; `remove` takes it away */
  | { op: "store"; name: string; label: string; remove?: boolean }
  /** a badge on a store: a breaker, a cache, an adapter note */
  | { op: "status"; store?: string; text?: string; tone?: Tone }
  /** a read model; `rows` replaces its rows, `clear` empties it */
  | {
      op: "table";
      name: string;
      title?: string;
      clear?: boolean;
      remove?: boolean;
    }
  | { op: "row"; table: string; key: string; values: Record<string, unknown> }
  /** what a state node shows; `null` clears it */
  | {
      op: "state";
      node: string;
      data: Record<string, unknown> | null;
      version?: number;
    }
  /** dim the cells from the one named on (time travel), or every stream but `only`; with neither, undim */
  | { op: "dim"; from?: string; only?: string; store?: string }
  /** generated traffic at scale: `count` events on streams of the history's kinds */
  | {
      op: "burst";
      count: number;
      seed: number;
      kinds: StreamKind[];
      day: number;
      store?: string;
    }
  /** close `count` streams of a kind whose last event is before `idle` (a day): archive, delete, seed a tombstone */
  | {
      op: "retire";
      prefix: string;
      count: number;
      idle: number;
      is?: string[];
      archive?: boolean;
      store?: string;
    }
  /** a rolling window on every stream of a kind: delete below the closest snapshot older than `cutoff` (a day) */
  | { op: "keep"; prefix: string; cutoff: number; store?: string }
  /** a cursor sweeps the log: from the checkpoint (correlate) or from the start (a replay) */
  | { op: "scan"; from: "checkpoint" | "start"; store?: string }
  /** workers lease streams: their dots glow in the worker's color; no `worker` clears */
  | {
      op: "glow";
      worker?: string;
      prefix?: string;
      count?: number;
      streams?: string[];
      tone?: Tone;
      store?: string;
    }
  /** a read model folds every stream of a kind: its row count and the events replayed come from the store */
  | { op: "project"; table: string; prefix: string; store?: string }
  /** a note pinned to a cell or a target */
  | { op: "flag"; on: string; text: string; tone?: Tone }
  | { op: "unflag"; on?: string };

export type Step = {
  /** one short line: who does what to which target, with the API in backticks */
  now: string;
  /** what the Now/Next bar previews; by default the next step's `now` */
  next?: string;
  say: string;
  /** the spoken form of `say`, when it must differ (ids, API names); captions always show `say` */
  speak?: string;
  /** controls of the player this step points at (chapter 0): `play`, `cc`, `sound`, `menu`, `transcript`, `tip` */
  ui?: string[];
  moves?: Move[];
  ops?: Op[];
  pipe?: Pipe;
  /** replaces the scene's code card from this step on */
  code?: string;
  /** node ids, cells (`cell:ref`) or targets (`target:id`) to light up */
  focus?: string[];
};

export type Link = { label: string; href: string };

export type Scene = {
  title: string;
  nodes: Node[];
  steps: Step[];
  code?: string;
  /** the public API this scene shows */
  api?: string[];
  doc?: Link;
  test?: Link;
};

export type Chapter = {
  id: string;
  title: string;
  audience: string;
  blurb: string;
  /** start from empty stores holding these events, instead of the last chapter's */
  seed?: EventIn[];
  /** generated history committed before the seed (a fresh store needs `seed`, even empty) */
  history?: History[];
  /** the app's anatomy from this chapter on */
  app?: AppSpec;
  /** macro: the whole store as a field of dots; micro: the detailed cells */
  view?: "macro" | "micro";
  scenes: Scene[];
};

export type TourSpec = {
  title: string;
  /** the stages of each multi-stage operation, named for `Step.pipe` */
  pipelines: Record<string, string[]>;
  stores: { name: string; label: string }[];
  chapters: Chapter[];
};

/** one recorded sentence of the narration: its text and the key of its clip, `static/tour/voice/<key>.m4a` */
export type VoiceLine = { key: string; text: string };
