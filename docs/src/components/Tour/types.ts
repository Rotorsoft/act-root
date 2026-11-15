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

/** One row of the check list an action walks. */
export type Check = { label: string; state: "ok" | "fail" | "todo" | "skip" };

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
  /** an action that never lands: a ghost cell with the error */
  | {
      op: "refuse";
      stream: string;
      name: string;
      error: string;
      store?: string;
    }
  /** subscribe a reaction target (a stream that reactions run on) */
  | {
      op: "target";
      id: string;
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
  /** a note pinned to a cell or a target */
  | { op: "flag"; on: string; text: string; tone?: Tone }
  | { op: "unflag"; on?: string };

export type Step = {
  say: string;
  moves?: Move[];
  ops?: Op[];
  checks?: Check[];
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
  scenes: Scene[];
};

export type TourSpec = {
  title: string;
  stores: { name: string; label: string }[];
  chapters: Chapter[];
};
