import { type AsCommitted } from "@rotorsoft/act";
import { eq, sql } from "drizzle-orm";
import { db, tickets } from "../drizzle";
import { act } from "./app";

export async function opened(event: AsCommitted<typeof act, "TicketOpened">) {
  const { closeAfter, ...other } = event.data;
  await db
    .insert(tickets)
    .values({
      id: event.stream,
      messages: 0,
      closeAfter: closeAfter?.getTime() ?? null,
      ...other,
    })
    .onConflictDoNothing();
}

export async function closed(event: AsCommitted<typeof act, "TicketClosed">) {
  await db.update(tickets).set(event.data).where(eq(tickets.id, event.stream));
}

export async function assigned(
  event: AsCommitted<typeof act, "TicketAssigned">
) {
  const { reassignAfter, escalateAfter, ...other } = event.data;
  await db
    .update(tickets)
    .set({
      reassignAfter: reassignAfter?.getTime() ?? null,
      escalateAfter: escalateAfter?.getTime() ?? null,
      ...other,
    })
    .where(eq(tickets.id, event.stream));
}

export async function messageAdded(
  event: AsCommitted<typeof act, "MessageAdded">
) {
  await db
    .update(tickets)
    .set({ messages: sql`${tickets.messages} + 1` })
    .where(eq(tickets.id, event.stream));
}

export async function escalated(
  event: AsCommitted<typeof act, "TicketEscalated">
) {
  await db
    .update(tickets)
    .set({ escalationId: event.data.requestId })
    .where(eq(tickets.id, event.stream));
}

export async function reassigned(
  event: AsCommitted<typeof act, "TicketReassigned">
) {
  const { reassignAfter, escalateAfter, ...other } = event.data;
  await db
    .update(tickets)
    .set({
      reassignAfter: reassignAfter?.getTime() ?? null,
      escalateAfter: escalateAfter?.getTime() ?? null,
      ...other,
    })
    .where(eq(tickets.id, event.stream));
}

export async function resolved(
  event: AsCommitted<typeof act, "TicketResolved">
) {
  await db.update(tickets).set(event.data).where(eq(tickets.id, event.stream));
}
