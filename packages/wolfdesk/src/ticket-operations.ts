import { randomUUID } from "node:crypto";
import { slice, state } from "@rotorsoft/act";
import { AgentLoad, agentStream } from "./agent-load.js";
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
} from "./ticket-preconditions.js";

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

  .on({ AssignTicket }, { maxRetries: 4 })
  .loads(
    AgentLoad,
    (_, state) => agentStream(state.agentId),
    ["TicketDropped"],
    "current"
  )
  .loads(
    AgentLoad,
    (data) => agentStream(data.agentId),
    ["TicketTaken"],
    "next"
  )
  .requires([mustBeOpen])
  .emit((data, { state }) =>
    state.agentId
      ? [
          ["TicketAssigned", data],
          ["TicketDropped", {}],
          ["TicketTaken", {}],
        ]
      : [
          ["TicketAssigned", data],
          ["TicketTaken", {}],
        ]
  )

  .on({ RequestTicketEscalation })
  .requires([mustBeOpen, mustBeUser, mustBeDueForEscalation])
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
  .requires([mustBeOpen, mustNotBeEscalated])
  .emit((data) => ["TicketEscalated", { ...data, escalationId: randomUUID() }])

  // Moves the ticket between two agents in one commit.
  .on({ ReassignTicket }, { maxRetries: 4 })
  .loads(
    AgentLoad,
    (_, state) => agentStream(state.agentId),
    ["TicketDropped"],
    "current"
  )
  .loads(
    AgentLoad,
    (data) => agentStream(data.agentId),
    ["TicketTaken"],
    "next"
  )
  .requires([
    mustBeOpen,
    mustBeEscalated,
    mustBeDueForReassignment,
    mustNotBeAcknowledgedByAgent,
  ])
  .emit((data, { state }) =>
    state.agentId
      ? [
          ["TicketReassigned", data],
          ["TicketDropped", {}],
          ["TicketTaken", {}],
        ]
      : [
          ["TicketReassigned", data],
          ["TicketTaken", {}],
        ]
  )

  .build();

// --- Slice ---
// prettier-ignore
export const TicketOpsSlice = slice()
  .withState(AgentLoad)
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
