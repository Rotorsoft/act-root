import { Actor } from "@rotorsoft/act";
import { randomUUID } from "crypto";
import { and, isNull, lt } from "drizzle-orm";
import { app } from "./bootstrap.js";
import { db, tickets } from "./drizzle/index.js";
import { reassignAgent } from "./services/agent.js";

// Escalates ticket when expected response time is not met
export const AUTO_ESCALATION_ID = randomUUID();
export function AutoEscalate(batchSize: number) {
  const actor: Actor = {
    id: AUTO_ESCALATION_ID,
    name: "AutoEscalate",
  };
  return new Promise((resolve, reject) =>
    db
      .select()
      .from(tickets)
      .where(lt(tickets.escalateAfter, Date.now()))
      .limit(batchSize)
      .then(async (tickets) => {
        for (const ticket of tickets) {
          await app
            .do(
              "EscalateTicket",
              { stream: ticket.id, actor },
              { requestId: randomUUID(), requestedById: AUTO_ESCALATION_ID }
            )
            .catch(console.error);
        }
        resolve(tickets.length);
      })
      .catch(reject)
  );
}

// Closes tickets after inactivity period
export const CLOSING_ID = randomUUID();
export function AutoClose(batchSize: number) {
  const actor: Actor = {
    id: CLOSING_ID,
    name: "AutoClose",
  };
  return new Promise((resolve, reject) =>
    db
      .select({ id: tickets.id })
      .from(tickets)
      .where(lt(tickets.closeAfter, Date.now()))
      .limit(batchSize)
      .then(async (tickets) => {
        for (const ticket of tickets) {
          await app
            .do("CloseTicket", { stream: ticket.id, actor }, {})
            .catch(console.error);
        }
        resolve(tickets.length);
      })
      .catch(reject)
  );
}

// Reassigns ticket after agent inactivity period
export const REASSIGN_ID = randomUUID();
export function AutoReassign(batchSize: number) {
  const actor: Actor = {
    id: REASSIGN_ID,
    name: "AutoReassign",
  };
  return new Promise((resolve, reject) =>
    db
      .select()
      .from(tickets)
      .where(
        and(isNull(tickets.closedById), lt(tickets.reassignAfter, Date.now()))
      )
      .limit(batchSize)
      .then(async (tickets) => {
        for (const ticket of tickets) {
          console.log("Reassigning", ticket);
          const agent = reassignAgent(ticket.id);
          await app
            .do("ReassignTicket", { stream: ticket.id, actor }, agent)
            .catch(console.error);
        }
        resolve(tickets.length);
      })
      .catch(reject)
  );
}

export function start_jobs() {
  setInterval(AutoReassign, 10_000);
  setInterval(AutoEscalate, 10_000);
  setInterval(AutoClose, 15_000);
}
