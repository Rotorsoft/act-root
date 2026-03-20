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
  varName: string; // variable name holding this state (e.g., TicketCreation)
  events: EventNode[];
  actions: ActionNode[];
  line?: number;
};

export type EventNode = {
  name: string;
  hasCustomPatch: boolean;
  line?: number;
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
  line?: number;
};

export type ProjectionNode = {
  name: string;
  varName: string;
  handles: string[]; // event names
  line?: number;
};

export type ReactionNode = {
  event: string;
  handlerName: string; // function name or "on EventName"
  dispatches: string[]; // action names this reaction calls via app.do()
  isVoid: boolean;
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
