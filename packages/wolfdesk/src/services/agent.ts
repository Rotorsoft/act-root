import { randomUUID } from "node:crypto";
import type { Priority } from "../schemas/index.js";

export type AvailableAgent = {
  agentId: string;
  reassignAfter: Date;
  escalateAfter: Date;
};

const HOUR = 60 * 60 * 1000;

export const assignAgent = (
  ticket_id: string,
  category: string,
  priority: Priority
): AvailableAgent => {
  process.env.NODE_ENV === "development" &&
    console.log("Assigning agent", { ticket_id, category, priority });
  // Realistic SLA windows so the deferred escalate/reassign automations wake
  // in the future rather than firing the instant a ticket is assigned.
  return {
    agentId: randomUUID(),
    reassignAfter: new Date(Date.now() + HOUR),
    escalateAfter: new Date(Date.now() + HOUR),
  };
};

export const reassignAgent = (ticket_id: string): AvailableAgent => {
  process.env.NODE_ENV === "development" &&
    console.log("Reassigning agent", { ticket_id });
  return {
    agentId: randomUUID(),
    reassignAfter: new Date(Date.now() + 100000),
    escalateAfter: new Date(Date.now() + 100000),
  };
};
