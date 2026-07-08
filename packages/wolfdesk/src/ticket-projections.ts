import { log, projection, state } from "@rotorsoft/act";
import { db, tickets } from "./drizzle/index.js";
import {
  MessageAdded,
  MessageDelivered,
  MessageRead,
  TicketAssigned,
  TicketClosed,
  TicketEscalated,
  TicketEscalationRequested,
  TicketOpened,
  TicketReassigned,
  TicketResolved,
  TicketState,
} from "./schemas/ticket.schemas.js";
import { TicketCreation } from "./ticket-creation.js";
import { TicketMessaging } from "./ticket-messaging.js";
import { TicketOperations } from "./ticket-operations.js";

/**
 * The full Ticket state: one artifact composing the slices' schemas and
 * reducers — the same shared instances, no duplicated logic. State
 * projections fold the full state, never partial slices, and built
 * partials expose their `init` and `patch`, so composition is a spread.
 */
export const Ticket = state({ Ticket: TicketState })
  .init(() => ({
    ...TicketMessaging.init(),
    ...TicketOperations.init(),
    ...TicketCreation.init(),
  }))
  .emits({
    TicketOpened,
    TicketClosed,
    TicketResolved,
    MessageAdded,
    MessageDelivered,
    MessageRead,
    TicketAssigned,
    TicketEscalationRequested,
    TicketEscalated,
    TicketReassigned,
  })
  .patch({
    ...TicketCreation.patch,
    ...TicketMessaging.patch,
    ...TicketOperations.patch,
  })
  .build();

// Replayed event data crosses the store as JSON, so a folded date can be
// a Date (live commit) or an ISO string (replay) — normalize either.
const ms = (d?: Date | string) => (d ? new Date(d).getTime() : null);

// The tickets list: one row per stream, folded by the full Ticket state.
// The flush massages state into columns inline — dates to millis, the
// messages record to a count — and upserts keyed on the stream.
export const TicketProjection = projection("tickets")
  .of(Ticket)
  .flush(async (rows) => {
    for (const row of rows) {
      const s = row.state;
      const columns = {
        productId: s.productId,
        supportCategoryId: s.supportCategoryId,
        escalationId: s.escalationId ?? null,
        priority: s.priority,
        title: s.title,
        messages: Object.keys(s.messages).length,
        userId: s.userId,
        agentId: s.agentId ?? null,
        resolvedById: s.resolvedById ?? null,
        closedById: s.closedById ?? null,
        reassignAfter: ms(s.reassignAfter),
        escalateAfter: ms(s.escalateAfter),
        closeAfter: ms(s.closeAfter),
      };
      await db
        .insert(tickets)
        .values({ id: row.stream, ...columns })
        .onConflictDoUpdate({ target: tickets.id, set: columns })
        .then(() => log().info(`${row.stream} => projected @${row.event_id}`));
    }
  })
  .build();
