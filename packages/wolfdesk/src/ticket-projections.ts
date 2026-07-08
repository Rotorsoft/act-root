import { log, projection } from "@rotorsoft/act";
import { db, tickets } from "./drizzle/index.js";
import { TicketCreation } from "./ticket-creation.js";
import { TicketMessaging } from "./ticket-messaging.js";
import { TicketOperations } from "./ticket-operations.js";

// Replayed event data crosses the store as JSON, so a folded date can be
// a Date (live commit) or an ISO string (replay) — normalize either.
const ms = (d?: Date | string) => (d ? new Date(d).getTime() : null);

// The tickets list: one row per stream, folded by the FULL Ticket state.
// The partials are passed for typing and event registration only — the
// orchestrator resolves the registry-merged state at build and refuses a
// fold that misses any partial. The flush massages state into columns
// inline — dates to millis, the messages record to a count — and upserts
// keyed on the stream.
export const TicketProjection = projection("tickets")
  .of(TicketCreation, TicketMessaging, TicketOperations)
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
