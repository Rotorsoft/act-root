import { DeferSignal } from "@rotorsoft/act";
import { and, asc, eq, lt, ne } from "drizzle-orm";
import { MAX_OPEN_TICKETS } from "../agent.js";
import { agents, db } from "../drizzle/index.js";
import type { Priority } from "../schemas/index.js";

export type AvailableAgent = {
  agentId: string;
  reassignAfter: Date;
  escalateAfter: Date;
};

const HOUR = 60 * 60 * 1000;
const WAIT = 60 * 1000;

/**
 * The agent with the fewest open tickets in the ticket's category. The table
 * only suggests: it can lag the agent's stream, and the commit refuses a full
 * agent, so the reaction's retry picks again. With nobody free the ticket
 * waits, and the reaction looks again in a minute.
 */
async function pick(category: string, current?: string) {
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.supportCategoryId, category),
        lt(agents.open, MAX_OPEN_TICKETS),
        current ? ne(agents.id, current) : undefined
      )
    )
    .orderBy(asc(agents.open), asc(agents.id))
    .limit(1);
  if (!agent) throw new DeferSignal({ at: new Date(Date.now() + WAIT) });
  return agent.id;
}

export const assignAgent = async (
  ticket_id: string,
  category: string,
  priority: Priority
): Promise<AvailableAgent> => {
  process.env.NODE_ENV === "development" &&
    console.log("Assigning agent", { ticket_id, category, priority });
  // Realistic SLA windows so the deferred escalate/reassign automations wake
  // in the future rather than firing the instant a ticket is assigned.
  return {
    agentId: await pick(category),
    reassignAfter: new Date(Date.now() + HOUR),
    escalateAfter: new Date(Date.now() + HOUR),
  };
};

export const reassignAgent = async (
  ticket_id: string,
  category: string,
  current?: string
): Promise<AvailableAgent> => {
  process.env.NODE_ENV === "development" &&
    console.log("Reassigning agent", { ticket_id, category });
  return {
    agentId: await pick(category, current),
    reassignAfter: new Date(Date.now() + 100000),
    escalateAfter: new Date(Date.now() + 100000),
  };
};
