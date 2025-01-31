import { randomUUID } from "crypto";
import { Priority } from "../schemas";

export type AvailableAgent = {
  agentId: string;
  reassignAfter: Date;
  escalateAfter: Date;
};

export const assignAgent = (
  ticket_id: string,
  category: string,
  priority: Priority
): AvailableAgent => {
  process.env.NODE_ENV === "development" &&
    console.log("Assigning agent", { ticket_id, category, priority });
  return {
    agentId: randomUUID(),
    reassignAfter: new Date(),
    escalateAfter: new Date(),
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
