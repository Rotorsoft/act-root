import { randomUUID } from "node:crypto";
import { slice, state } from "@rotorsoft/act";
import {
  AssignTicket,
  EscalateTicket,
  ReassignTicket,
  RequestTicketEscalation,
  TicketAssigned,
  TicketEscalated,
  TicketEscalationRequested,
  TicketOperationsState,
  TicketReassigned,
} from "./schemas/ticket.schemas.js";
import {
  mustBeDueForEscalation,
  mustBeDueForReassignment,
  mustBeEscalated,
  mustBeOpen,
  mustBeUser,
  mustNotBeAcknowledgedByAgent,
  mustNotBeEscalated,
} from "./ticket-invariants.js";

// --- State ---
export const TicketOperations = state({ Ticket: TicketOperationsState })
  .init(() => ({
    productId: "",
    userId: "",
    messages: {},
  }))
  .emits({
    TicketAssigned,
    TicketEscalationRequested,
    TicketEscalated,
    TicketReassigned,
  })

  .on({ AssignTicket })
  .given([mustBeOpen])
  .emit("TicketAssigned")

  .on({ RequestTicketEscalation })
  .given([mustBeOpen, mustBeUser, mustBeDueForEscalation])
  .emit((_, __, { actor }) => {
    return [
      "TicketEscalationRequested",
      {
        requestedById: actor.id,
        requestId: randomUUID(),
      },
    ];
  })

  .on({ EscalateTicket })
  .given([mustBeOpen, mustNotBeEscalated])
  .emit((data) => ["TicketEscalated", { ...data, escalationId: randomUUID() }])

  .on({ ReassignTicket })
  .given([
    mustBeOpen,
    mustBeEscalated,
    mustBeDueForReassignment,
    mustNotBeAcknowledgedByAgent,
  ])
  .emit("TicketReassigned")

  .build();

// --- Slice ---
// prettier-ignore
export const TicketOpsSlice = slice()
  .withState(TicketOperations)
  .on("TicketEscalationRequested")
  .do(async function escalate(event, _stream, app) {
    await app.do(
      "EscalateTicket",
      {
        stream: event.stream,
        actor: { id: randomUUID(), name: "escalate reaction" },
      },
      event.data,
      { reactingTo: event }
    );
  })
  .build();
