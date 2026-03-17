/** Domain model extracted from Act builder code */

export type DomainModel = {
  states: StateNode[];
  slices: SliceNode[];
  projections: ProjectionNode[];
  reactions: ReactionNode[];
};

export type StateNode = {
  name: string;
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
  states: string[]; // state names
  projections: string[];
  reactions: ReactionNode[];
  line?: number;
};

export type ProjectionNode = {
  name: string;
  handles: string[]; // event names
  line?: number;
};

export type ReactionNode = {
  event: string;
  isVoid: boolean;
  line?: number;
};

export type ValidationWarning = {
  message: string;
  severity: "warning" | "error";
  element?: string;
};

export function emptyModel(): DomainModel {
  return { states: [], slices: [], projections: [], reactions: [] };
}
