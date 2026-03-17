export type Template = {
  name: string;
  description: string;
  code: string;
};

export const templates: Template[] = [
  {
    name: "Counter",
    description: "Simple counter with increment/decrement",
    code: `import { state } from "@rotorsoft/act";
import { z } from "zod";

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({
    Incremented: z.object({ amount: z.number() }),
    Decremented: z.object({ amount: z.number() }),
  })
  .patch({
    Incremented: ({ data }, state) => ({ count: state.count + data.amount }),
    Decremented: ({ data }, state) => ({ count: state.count - data.amount }),
  })
  .on({ Increment: z.object({ by: z.number() }) })
    .emit((data) => ["Incremented", { amount: data.by }])
  .on({ Decrement: z.object({ by: z.number() }) })
    .emit((data) => ["Decremented", { amount: data.by }])
  .build();

export { Counter };
`,
  },
  {
    name: "Todo List",
    description: "CRUD pattern with invariants",
    code: `import { state, type Invariant } from "@rotorsoft/act";
import { z } from "zod";

const mustBeOpen: Invariant<{ status: string }> = {
  description: "Todo must be open",
  valid: (state) => state.status === "open",
};

const Todo = state({ Todo: z.object({
  title: z.string(),
  status: z.string(),
  createdBy: z.string(),
})})
  .init(() => ({ title: "", status: "open", createdBy: "" }))
  .emits({
    TodoCreated: z.object({ title: z.string(), createdBy: z.string() }),
    TodoCompleted: z.object({ completedBy: z.string() }),
    TodoReopened: z.object({ reopenedBy: z.string() }),
  })
  .patch({
    TodoCreated: ({ data }) => ({ title: data.title, status: "open", createdBy: data.createdBy }),
    TodoCompleted: () => ({ status: "completed" }),
    TodoReopened: () => ({ status: "open" }),
  })
  .on({ CreateTodo: z.object({ title: z.string() }) })
    .emit((data, _, { actor }) => ["TodoCreated", { title: data.title, createdBy: actor.id }])
  .on({ CompleteTodo: z.object({}) })
    .given([mustBeOpen])
    .emit((_, __, { actor }) => ["TodoCompleted", { completedBy: actor.id }])
  .on({ ReopenTodo: z.object({}) })
    .emit((_, __, { actor }) => ["TodoReopened", { reopenedBy: actor.id }])
  .build();

export { Todo };
`,
  },
  {
    name: "Ticket System",
    description: "Multi-state with slices, reactions, and projections",
    code: `import { state, slice, projection } from "@rotorsoft/act";
import { z } from "zod";

// --- States ---

const Ticket = state({ Ticket: z.object({
  title: z.string(),
  status: z.string(),
  assignee: z.string(),
  priority: z.string(),
})})
  .init(() => ({ title: "", status: "open", assignee: "", priority: "medium" }))
  .emits({
    TicketOpened: z.object({ title: z.string(), priority: z.string() }),
    TicketAssigned: z.object({ assignee: z.string() }),
    TicketClosed: z.object({ reason: z.string() }),
    TicketEscalated: z.object({ to: z.string() }),
  })
  .patch({
    TicketOpened: ({ data }) => ({ title: data.title, status: "open", priority: data.priority }),
    TicketAssigned: ({ data }) => ({ assignee: data.assignee }),
    TicketClosed: () => ({ status: "closed" }),
    TicketEscalated: ({ data }) => ({ assignee: data.to, priority: "high" }),
  })
  .on({ OpenTicket: z.object({ title: z.string(), priority: z.string() }) })
    .emit("TicketOpened")
  .on({ AssignTicket: z.object({ assignee: z.string() }) })
    .emit("TicketAssigned")
  .on({ CloseTicket: z.object({ reason: z.string() }) })
    .given([{ description: "Ticket must be open", valid: (s) => s.status === "open" }])
    .emit("TicketClosed")
  .on({ EscalateTicket: z.object({ to: z.string() }) })
    .emit("TicketEscalated")
  .build();

const AgentStats = state({ AgentStats: z.object({
  assigned: z.number(),
  closed: z.number(),
})})
  .init(() => ({ assigned: 0, closed: 0 }))
  .emits({
    AgentAssigned: z.object({ ticketId: z.string() }),
    AgentResolved: z.object({ ticketId: z.string() }),
  })
  .patch({
    AgentAssigned: (_, state) => ({ assigned: state.assigned + 1 }),
    AgentResolved: (_, state) => ({ closed: state.closed + 1 }),
  })
  .on({ TrackAssignment: z.object({ ticketId: z.string() }) })
    .emit("AgentAssigned")
  .on({ TrackResolution: z.object({ ticketId: z.string() }) })
    .emit("AgentResolved")
  .build();

// --- Projection ---

const TicketProjection = projection("tickets")
  .on({ TicketOpened: z.object({ title: z.string(), priority: z.string() }) })
    .do(async ({ stream, data }) => {
      console.log("Ticket opened:", stream, data);
    })
  .on({ TicketClosed: z.object({ reason: z.string() }) })
    .do(async ({ stream, data }) => {
      console.log("Ticket closed:", stream, data);
    })
  .build();

// --- Slice ---

const TicketSlice = slice()
  .withState(Ticket)
  .withState(AgentStats)
  .withProjection(TicketProjection)
  .on("TicketAssigned")
    .do(async (event, stream, app) => {
      await app.do("TrackAssignment", { stream: event.data.assignee, actor: { id: "system", name: "System" } }, { ticketId: stream });
    })
    .to((event) => ({ target: event.data.assignee }))
  .on("TicketClosed")
    .do(async (event, stream, app) => {
      await app.do("TrackResolution", { stream: event.meta.causation.action?.actor?.id ?? "", actor: { id: "system", name: "System" } }, { ticketId: stream });
    })
    .to((event) => ({ target: event.meta.causation.action?.actor?.id ?? "" }))
  .build();

export { Ticket, AgentStats, TicketProjection, TicketSlice };
`,
  },
];
