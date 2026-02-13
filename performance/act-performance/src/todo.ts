import { state } from "@rotorsoft/act";
import { z } from "zod";

// State schema
const TodoState = z.object({
  id: z.string(),
  text: z.string(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  deleted: z.boolean().optional(),
});

type TodoState = z.infer<typeof TodoState>;

// Event schemas
const TodoCreated = z.object({ text: z.string() });
const TodoUpdated = z.object({ text: z.string() });
const TodoDeleted = z.object({});

export const Events = {
  TodoCreated,
  TodoUpdated,
  TodoDeleted,
};

// Action schemas
const CreateTodo = z.object({ text: z.string() });
const UpdateTodo = z.object({ text: z.string() });
const DeleteTodo = z.object({});

export const Todo = state({ Todo: TodoState })
  .init(() => ({ id: "", text: "", createdAt: "", deleted: false }))
  .emits(Events)
  .patch({
    TodoCreated: (event) => ({
      id: event.stream,
      text: event.data.text,
      createdAt: event.created.toISOString(),
      deleted: false,
    }),
    TodoUpdated: (event, state) => ({
      ...state,
      text: event.data.text,
      updatedAt: event.created.toISOString(),
    }),
    TodoDeleted: (event, state) => ({
      ...state,
      deleted: true,
      updatedAt: event.created.toISOString(),
    }),
  })
  .on({ create: CreateTodo })
  .emit((action) => ["TodoCreated", { text: action.text }])
  .on({ update: UpdateTodo })
  .emit((action, state) => {
    if (!state || ("deleted" in state && state.deleted))
      throw new Error("Todo not found");
    return ["TodoUpdated", { text: action.text }];
  })
  .on({ delete: DeleteTodo })
  .emit((_action, state) => {
    if (!state || ("deleted" in state && state.deleted))
      throw new Error("Todo not found");
    return ["TodoDeleted", {}];
  })
  .build();

export type { TodoState };
