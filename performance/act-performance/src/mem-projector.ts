/**
 * Projection table for fast reads.
 * Updated by event handlers.
 */
import { sleep, store, type CommittedOf } from "@rotorsoft/act";
import { Events, TodoState } from "./todo";

export function create() {
  const todos = new Map<string, TodoState>();
  return {
    init: async () => {
      await sleep();
      todos.clear();
    },
    /* eslint-disable @typescript-eslint/no-unsafe-argument */
    projectTodoCreated: async ({
      event,
    }: {
      event: CommittedOf<typeof Events, "TodoCreated">;
    }) => {
      await sleep(150);
      todos.set(event.stream, {
        id: event.stream,
        text: event.data.text,
        createdAt: event.created.toISOString(),
        deleted: false,
      });
    },
    projectTodoUpdated: async ({
      event,
    }: {
      event: CommittedOf<typeof Events, "TodoUpdated">;
    }) => {
      await sleep(50);
      todos.set(event.stream, {
        ...todos.get(event.stream)!,
        text: event.data.text,
        updatedAt: event.created.toISOString(),
      });
    },
    projectTodoDeleted: async ({
      event,
    }: {
      event: CommittedOf<typeof Events, "TodoDeleted">;
    }) => {
      await sleep(100);
      todos.set(event.stream, {
        ...todos.get(event.stream)!,
        deleted: true,
        updatedAt: event.created.toISOString(),
      });
    },
    /* eslint-enable @typescript-eslint/no-unsafe-argument */
    getById: async (stream: string) => {
      await sleep();
      return todos.get(stream) || null;
    },
    getStats: async () => {
      let lastEventInStore = -1;
      await store().query((e) => (lastEventInStore = e.id), {
        limit: 1,
        backward: true,
      });
      return {
        totalTodos: todos.size,
        activeTodos: [...todos.values()].filter((t) => !t.deleted).length,
        lastEventInStore,
      };
    },
  };
}
