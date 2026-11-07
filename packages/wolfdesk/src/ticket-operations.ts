import { randomUUID } from "node:crypto";
import { slice, state } from "@rotorsoft/act";
import { Agent, agentStream } from "./agent.js";
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
  mustNotBeResolved,
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
    Agent,
    (_, state) => state.agentId && agentStream(state.agentId),
    ["TicketDropped"],
    "current"
  )
  .loads(Agent, (data) => agentStream(data.agentId), ["TicketTaken"], "next")
  .requires([mustBeOpen, mustNotBeResolved])
  .emit((data) => [
    ["TicketAssigned", data],
    ["TicketDropped", {}],
    ["TicketTaken", {}],
  ])

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

  // The timer reaction commits to a ticket other reactions are moving, so it can
  // lose a race: the retry reloads and escalates in the same pass, instead of
  // waiting out the reaction's backoff.
  .on({ EscalateTicket }, { maxRetries: 4 })
  .requires([mustBeOpen, mustNotBeEscalated])
  .emit((data) => ["TicketEscalated", { ...data, escalationId: randomUUID() }])

  // Moves the ticket between two agents in one commit.
  .on({ ReassignTicket }, { maxRetries: 4 })
  .loads(
    Agent,
    (_, state) => state.agentId && agentStream(state.agentId),
    ["TicketDropped"],
    "current"
  )
  .loads(Agent, (data) => agentStream(data.agentId), ["TicketTaken"], "next")
  .requires([
    mustBeOpen,
    mustNotBeResolved,
    mustBeEscalated,
    mustBeDueForReassignment,
    mustNotBeAcknowledgedByAgent,
  ])
  .emit((data) => [
    ["TicketReassigned", data],
    ["TicketDropped", {}],
    ["TicketTaken", {}],
  ])

  .build();

// --- Slice ---
// prettier-ignore
export const TicketOpsSlice = slice()
  .withState(Agent)
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
