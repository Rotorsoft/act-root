import { type AsCommitted } from "@rotorsoft/act";
import { eq, sql } from "drizzle-orm";
import { builder } from "./bootstrap.js";
import { db, tickets } from "./drizzle/index.js";

export async function opened({
  stream,
  data,
}: AsCommitted<typeof builder.events, "TicketOpened">) {
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
}: AsCommitted<typeof builder.events, "TicketClosed">) {
  await db
    .update(tickets)
    .set(data)
    .where(eq(tickets.id, stream))
    .then(() => console.log(`${stream} => closed`));
}

export async function assigned({
  stream,
  data,
}: AsCommitted<typeof builder.events, "TicketAssigned">) {
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
}: AsCommitted<typeof builder.events, "MessageAdded">) {
  await db
    .update(tickets)
    .set({ messages: sql`${tickets.messages} + 1` })
    .where(eq(tickets.id, stream))
    .then(() => console.log(`${stream} => messageAdded`));
}

export async function escalated({
  stream,
  data,
}: AsCommitted<typeof builder.events, "TicketEscalated">) {
  await db
    .update(tickets)
    .set({ escalationId: data.requestId })
    .where(eq(tickets.id, stream))
    .then(() => console.log(`${stream} => escalated`));
}

export async function reassigned({
  stream,
  data,
}: AsCommitted<typeof builder.events, "TicketReassigned">) {
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
}: AsCommitted<typeof builder.events, "TicketResolved">) {
  await db
    .update(tickets)
    .set(data)
    .where(eq(tickets.id, stream))
    .then(() => console.log(`${stream} => resolved`));
}
