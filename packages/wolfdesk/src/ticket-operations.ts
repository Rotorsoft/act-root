import { slice, state } from "@rotorsoft/act";
import { randomUUID } from "crypto";
import * as errors from "./errors.js";
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
import { mustBeOpen, mustBeUser } from "./ticket-invariants.js";

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
  .given([mustBeOpen, mustBeUser])
  .emit((_, { state }, { stream, actor }) => {
    if (state.escalateAfter && state.escalateAfter > new Date())
      throw new errors.TicketEscalationError(
        stream,
        actor?.id || "",
        "Cannot escalate before due date"
      );
    return [
      "TicketEscalationRequested",
      {
        requestedById: actor.id,
        requestId: randomUUID(),
      },
    ];
  })

  .on({ EscalateTicket })
  .given([mustBeOpen])
  .emit((data, { state }, { stream, actor }) => {
    if (state.escalationId)
      throw new errors.TicketEscalationError(
        stream,
        actor?.id || "",
        "Cannot escalate more than once"
      );
    return ["TicketEscalated", { ...data, escalationId: randomUUID() }];
  })

  .on({ ReassignTicket })
  .given([mustBeOpen])
  .emit((data, { state }, { stream, actor }) => {
    if (!state.escalationId)
      throw new errors.TicketEscalationError(
        stream,
        actor?.id || "",
        "Cannot reassign without escalation"
      );
    if (state.reassignAfter && state.reassignAfter > new Date())
      throw new errors.TicketReassingmentError(
        stream,
        actor?.id || "",
        "Cannot reassign before due date"
      );
    const ackedByAgent = Object.values(state.messages).filter(
      (msg) => msg.wasRead && msg.from === state.userId
    ).length;
    if (ackedByAgent)
      throw new errors.TicketReassingmentError(
        stream,
        actor?.id || "",
        "Cannot reassign after agent acknowledged"
      );
    return ["TicketReassigned", data];
  })

  .build();

// --- Slice ---
// prettier-ignore
export const TicketOpsSlice = slice()
  .withState(TicketOperations)
  .on("TicketEscalationRequested").do(async function escalate(event, _stream, app) {
    await app.do(
      "EscalateTicket",
      {
        stream: event.stream,
        actor: { id: randomUUID(), name: "escalate reaction" },
      },
      event.data,
      event
    );
  })
  .build();
