import { slice, state, ZodEmpty } from "@rotorsoft/act";
import { z } from "zod";

export const MAX_OPEN_TICKETS = 5;

const AgentFields = z.object({
  name: z.string().min(1),
  supportCategoryId: z.uuid(),
});
const AddAgent = AgentFields.describe("Adds an agent to the desk");
const AgentAdded = AgentFields.describe("An agent joined the desk");

/**
 * An agent on the desk, one stream per agent, with how many open tickets it
 * holds. The schema holds the limit, whichever action takes a ticket, and a
 * lost race fails the whole commit, so the action's retry sees the new count.
 */
export const Agent = state({
  Agent: z.object({
    name: z.string(),
    supportCategoryId: z.string(),
    open: z.number().min(0).max(MAX_OPEN_TICKETS),
  }),
})
  .init(() => ({ name: "", supportCategoryId: "", open: 0 }))
  .emits({ AgentAdded, TicketTaken: ZodEmpty, TicketDropped: ZodEmpty })
  .patch({
    TicketTaken: (_, state) => ({ open: state.open + 1 }),
    TicketDropped: (_, state) => ({ open: state.open - 1 }),
  })

  .on({ AddAgent })
  .requires([
    {
      description: "Agent must not be on the desk",
      holds: (_, state) => !state.name,
    },
  ])
  .emit((data) => ["AgentAdded", data])

  .build();

export const AgentSlice = slice().withState(Agent).build();

/**
 * A load always names a stream, so a ticket with no agent names this one. An
 * action emits nothing to it, which makes that load a read.
 */
export const agentStream = (agentId?: string) =>
  `agent-${agentId ?? "unassigned"}`;

export const agentOfStream = (stream: string) => stream.slice("agent-".length);
