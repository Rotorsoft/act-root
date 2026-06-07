/** Domain model extracted from Act builder code */

export type ActNode = {
  slices: string[]; // slice variable names
  projections: string[]; // projection variable names
  states: string[]; // standalone state variable names
  line?: number;
};

export type EntryPoint = {
  path: string; // source file path (e.g. "packages/calculator/src/calculator.ts")
  states: StateNode[];
  slices: SliceNode[];
  projections: ProjectionNode[];
  reactions: ReactionNode[];
};

export type DomainModel = {
  entries: EntryPoint[];
  // Flat views for backward compat (union of all entries)
  states: StateNode[];
  slices: SliceNode[];
  projections: ProjectionNode[];
  reactions: ReactionNode[];
  orchestrator?: ActNode;
};

export type StateNode = {
  name: string;
  varName: string;
  events: EventNode[];
  actions: ActionNode[];
  file?: string;
  line?: number;
};

export type EventNode = {
  name: string;
  hasCustomPatch: boolean;
  line?: number;
  /**
   * Best-effort source text of the Zod schema expression as written in
   * `.emits({ EventName: <expr> })`. Captured by re-scanning the source
   * file after evaluation. Absent when the event was found but no source
   * match could be made (synthetic events, unparseable blocks).
   */
  schema?: string;
  /**
   * Runtime Zod schema object captured during evaluation. Only present
   * after parsing — never serialized. The act-contracts CLI uses this
   * to emit JSON Schema via `z.toJSONSchema()`.
   */
  zod?: unknown;
};

export type ActionNode = {
  name: string;
  emits: string[]; // event names this action emits
  invariants: string[];
  line?: number;
};

export type SliceNode = {
  name: string;
  states: string[]; // resolved state domain names
  stateVars: string[]; // original variable names from .withState()
  projections: string[];
  reactions: ReactionNode[];
  error?: string; // extraction/compilation error for this slice
  file?: string; // source file path
  line?: number;
};

export type ProjectionNode = {
  name: string;
  varName: string;
  handles: string[]; // event names
  file?: string;
  line?: number;
};

export type ReactionNode = {
  event: string;
  handlerName: string; // function name or "on EventName"
  dispatches: string[]; // action names this reaction calls via app.do()
  file?: string;
  line?: number;
};

export type ValidationWarning = {
  message: string;
  severity: "warning" | "error";
  element?: string;
};

export function emptyModel(): DomainModel {
  return {
    entries: [],
    states: [],
    slices: [],
    projections: [],
    reactions: [],
    orchestrator: undefined,
  };
}
