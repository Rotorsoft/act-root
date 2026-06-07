import { log, projection } from "@rotorsoft/act";
import { eq, sql } from "drizzle-orm";
import { db, tickets } from "./drizzle/index.js";
import {
  MessageAdded,
  TicketAssigned,
  TicketClosed,
  TicketEscalated,
  TicketOpened,
  TicketReassigned,
  TicketResolved,
} from "./schemas/ticket.schemas.js";

// prettier-ignore
export const TicketProjection = projection("tickets")
  .on({ TicketOpened })
  .do(async function opened({ stream, data }) {
    const { closeAfter, ...other } = data;
    await db
      .insert(tickets)
      .values({
        id: stream,
        messages: 0,
        closeAfter: closeAfter?.getTime() ?? null,
        ...other,
      })
      .onConflictDoNothing()
      .then(() => log().info(`${stream} => opened`));
  })
  .on({ TicketClosed })
  .do(async function closed({ stream, data }) {
    await db
      .update(tickets)
      .set(data)
      .where(eq(tickets.id, stream))
      .then(() => log().info(`${stream} => closed`));
  })
  .on({ TicketResolved })
  .do(async function resolved({ stream, data }) {
    await db
      .update(tickets)
      .set(data)
      .where(eq(tickets.id, stream))
      .then(() => log().info(`${stream} => resolved`));
  })
  .on({ MessageAdded })
  .do(async function messageAdded({ stream }) {
    await db
      .update(tickets)
      .set({ messages: sql`${tickets.messages} + 1` })
      .where(eq(tickets.id, stream))
      .then(() => log().info(`${stream} => messageAdded`));
  })
  .on({ TicketAssigned })
  .do(async function assigned({ stream, data }) {
    const { reassignAfter, escalateAfter, ...other } = data;
    await db
      .update(tickets)
      .set({
        reassignAfter: reassignAfter?.getTime() ?? null,
        escalateAfter: escalateAfter?.getTime() ?? null,
        ...other,
      })
      .where(eq(tickets.id, stream))
      .then(() => log().info(`${stream} => assigned`));
  })
  .on({ TicketEscalated })
  .do(async function escalated({ stream, data }) {
    await db
      .update(tickets)
      .set({ escalationId: data.request_id })
      .where(eq(tickets.id, stream))
      .then(() => log().info(`${stream} => escalated`));
  })
  .on({ TicketReassigned })
  .do(async function reassigned({ stream, data }) {
    const { reassignAfter, escalateAfter, ...other } = data;
    await db
      .update(tickets)
      .set({
        reassignAfter: reassignAfter?.getTime() ?? null,
        escalateAfter: escalateAfter?.getTime() ?? null,
        ...other,
      })
      .where(eq(tickets.id, stream))
      .then(() => log().info(`${stream} => reassigned`));
  })
  .build();
