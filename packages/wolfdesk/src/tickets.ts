import { type CommittedOf } from "@rotorsoft/act";
import { eq, sql } from "drizzle-orm";
import { db, tickets } from "./drizzle/index.js";
import { TicketCreation, TicketMessaging, TicketOperations } from "./ticket.js";

export async function opened({
  stream,
  data,
}: CommittedOf<typeof TicketCreation.events, "TicketOpened">) {
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
    .then(() => console.log(`${stream} => opened`));
}

export async function closed({
  stream,
  data,
}: CommittedOf<typeof TicketCreation.events, "TicketClosed">) {
  await db
    .update(tickets)
    .set(data)
    .where(eq(tickets.id, stream))
    .then(() => console.log(`${stream} => closed`));
}

export async function assigned({
  stream,
  data,
}: CommittedOf<typeof TicketOperations.events, "TicketAssigned">) {
  const { reassignAfter, escalateAfter, ...other } = data;
  await db
    .update(tickets)
    .set({
      reassignAfter: reassignAfter?.getTime() ?? null,
      escalateAfter: escalateAfter?.getTime() ?? null,
      ...other,
    })
    .where(eq(tickets.id, stream))
    .then(() => console.log(`${stream} => assigned`));
}

export async function messageAdded({
  stream,
}: CommittedOf<typeof TicketMessaging.events, "MessageAdded">) {
  await db
    .update(tickets)
    .set({ messages: sql`${tickets.messages} + 1` })
    .where(eq(tickets.id, stream))
    .then(() => console.log(`${stream} => messageAdded`));
}

export async function escalated({
  stream,
  data,
}: CommittedOf<typeof TicketOperations.events, "TicketEscalated">) {
  await db
    .update(tickets)
    .set({ escalationId: data.requestId })
    .where(eq(tickets.id, stream))
    .then(() => console.log(`${stream} => escalated`));
}

export async function reassigned({
  stream,
  data,
}: CommittedOf<typeof TicketOperations.events, "TicketReassigned">) {
  const { reassignAfter, escalateAfter, ...other } = data;
  await db
    .update(tickets)
    .set({
      reassignAfter: reassignAfter?.getTime() ?? null,
      escalateAfter: escalateAfter?.getTime() ?? null,
      ...other,
    })
    .where(eq(tickets.id, stream))
    .then(() => console.log(`${stream} => reassigned`));
}

export async function resolved({
  stream,
  data,
}: CommittedOf<typeof TicketCreation.events, "TicketResolved">) {
  await db
    .update(tickets)
    .set(data)
    .where(eq(tickets.id, stream))
    .then(() => console.log(`${stream} => resolved`));
}
