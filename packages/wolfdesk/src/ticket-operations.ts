import { state } from "@rotorsoft/act";
import { randomUUID } from "crypto";
import * as errors from "./errors.js";
import * as schemas from "./schemas/index.js";
import { mustBeOpen, mustBeUser, ticketInit } from "./ticket-invariants.js";

const operationsEvents = {
  TicketAssigned: schemas.events.TicketAssigned,
  TicketEscalationRequested: schemas.events.TicketEscalationRequested,
  TicketEscalated: schemas.events.TicketEscalated,
  TicketReassigned: schemas.events.TicketReassigned,
};

export const TicketOperations = state("Ticket", schemas.Ticket)
  .init(ticketInit)
  .emits(operationsEvents)
  .patch({
    TicketAssigned: ({ data }) => data,
    TicketEscalationRequested: ({ data }) => data,
    TicketEscalated: ({ data }) => data,
    TicketReassigned: ({ data }) => data,
  })

  .on("AssignTicket", schemas.actions.AssignTicket)
  .given([mustBeOpen])
  .emit((data) => ["TicketAssigned", data])

  .on("RequestTicketEscalation", schemas.actions.RequestTicketEscalation)
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

  .on("EscalateTicket", schemas.actions.EscalateTicket)
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

  .on("ReassignTicket", schemas.actions.ReassignTicket)
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
