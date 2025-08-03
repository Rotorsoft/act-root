import { CommittedOf } from "@rotorsoft/act";
import { Events, TodoState } from "./todo";

export type LoadTestOptions = {
  maxEvents: number;
  createMax: number;
  eventFrequency: number;
};

export type Projector = {
  getStats: () => Promise<{
    totalTodos: number;
    activeTodos: number;
    lastEventInStore: number;
    lastProjectedEvent: number;
  }>;
  init: () => Promise<void>;
  projectTodoCreated: (
    event: CommittedOf<typeof Events, "TodoCreated">
  ) => Promise<void>;
  projectTodoUpdated: (
    event: CommittedOf<typeof Events, "TodoUpdated">
  ) => Promise<void>;
  projectTodoDeleted: (
    event: CommittedOf<typeof Events, "TodoDeleted">
  ) => Promise<void>;
  getById: (stream: string) => Promise<TodoState | null>;
};
