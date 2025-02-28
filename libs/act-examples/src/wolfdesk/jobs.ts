import { Actor } from "@rotorsoft/act";
import { randomUUID } from "crypto";
import { and, isNull, lt } from "drizzle-orm";
import { db, tickets } from "../drizzle";
import { act } from "./bootstrap";
import { reassignAgent } from "./services/agent";

// Escalates ticket when expected response time is not met
export const AUTO_ESCALATION_ID = "00000000-0000-1000-0000-100000000000";
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
      .then((tickets) => {
        tickets.forEach((ticket) => {
          act
            .do(
              "EscalateTicket",
              { stream: ticket.id, actor },
              { requestId: randomUUID(), requestedById: AUTO_ESCALATION_ID }
            )
            .catch(reject);
        });
        resolve(tickets.length);
      })
      .catch(reject)
  );
}

// Closes tickets after inactivity period
export const CLOSING_ID = "00000000-0000-1000-0000-200000000000";
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
      .then((tickets) => {
        tickets.forEach((ticket) => {
          act.do("CloseTicket", { stream: ticket.id, actor }, {}).catch(reject);
        });
        resolve(tickets.length);
      })
      .catch(reject)
  );
}

// Reassigns ticket after agent inactivity period
export const REASSIGN_ID = "00000000-0000-1000-0000-300000000000";
export function AutoReassign(batchSize: number) {
  const actor: Actor = {
    id: CLOSING_ID,
    name: "AutoClose",
  };
  return new Promise((resolve, reject) =>
    db
      .select({ id: tickets.id })
      .from(tickets)
      .where(
        and(isNull(tickets.closedById), lt(tickets.reassignAfter, Date.now()))
      )
      .limit(batchSize)
      .then((tickets) => {
        tickets.forEach((ticket) => {
          const agent = reassignAgent(ticket.id);
          act
            .do("ReassignTicket", { stream: ticket.id, actor }, agent)
            .catch(reject);
        });
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
