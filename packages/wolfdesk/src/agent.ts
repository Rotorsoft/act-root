import { state, ZodEmpty } from "@rotorsoft/act";
import { z } from "zod";

export const MAX_OPEN_TICKETS = 5;

/**
 * How many open tickets an agent holds, one stream per agent. The schema holds
 * the limit, whichever action takes a ticket, and a lost race fails the whole
 * commit, so the action's retry sees the new count.
 */
export const Agent = state({
  Agent: z.object({ open: z.number().min(0).max(MAX_OPEN_TICKETS) }),
})
  .init(() => ({ open: 0 }))
  .emits({ TicketTaken: ZodEmpty, TicketDropped: ZodEmpty })
  .patch({
    TicketTaken: (_, state) => ({ open: state.open + 1 }),
    TicketDropped: (_, state) => ({ open: state.open - 1 }),
  })
  .build();

/**
 * A load always names a stream, so a ticket with no agent names this one. An
 * action emits nothing to it, which makes that load a read.
 */
export const agentStream = (agentId?: string) =>
  `agent-${agentId ?? "unassigned"}`;
