import { slice, state } from "@rotorsoft/act";
import { randomUUID } from "crypto";
import { z } from "zod";
import * as errors from "./errors.js";
import { Message } from "./schemas/ticket.state.schemas.js";
import { mustBeOpen, mustBeUser } from "./ticket-invariants.js";

// --- Action schemas ---
const AssignTicket = z
  .object({
    agentId: z.uuid(),
    reassignAfter: z.date(),
    escalateAfter: z.date(),
  })
  .describe("Assigns the ticket to an agent");
const RequestTicketEscalation = z
  .object({})
  .describe("Requests a ticket escalation");
const EscalateTicket = z
  .object({ requestId: z.uuid(), requestedById: z.uuid() })
  .describe("Escalates the ticket");
const ReassignTicket = z
  .object({
    agentId: z.uuid(),
    reassignAfter: z.date(),
    escalateAfter: z.date(),
  })
  .describe("Reassigns the ticket");

// --- Event schemas ---
const TicketAssigned = AssignTicket.describe(
  "An agent was assigned to the ticket"
);
const TicketEscalationRequested = z
  .object({ requestedById: z.uuid(), requestId: z.uuid() })
  .describe("A ticket escalation was requested");
const TicketEscalated = EscalateTicket.and(
  z.object({ escalationId: z.uuid() })
).describe("The ticket was escalated");
const TicketReassigned = ReassignTicket.describe("The ticket was reassigned");

// --- State ---
export const TicketOperations = state(
  "Ticket",
  z.object({
    productId: z.uuid(),
    userId: z.uuid(),
    messages: z.record(z.uuid(), Message),
    agentId: z.uuid().optional(),
    requestId: z.uuid().optional(),
    requestedById: z.uuid().optional(),
    escalationId: z.uuid().optional(),
    reassignAfter: z.date().optional(),
    escalateAfter: z.date().optional(),
  })
)
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
  .patch({
    TicketAssigned: ({ data }) => data,
    TicketEscalationRequested: ({ data }) => data,
    TicketEscalated: ({ data }) => data,
    TicketReassigned: ({ data }) => data,
  })

  .on("AssignTicket", AssignTicket)
  .given([mustBeOpen])
  .emit((data) => ["TicketAssigned", data])

  .on("RequestTicketEscalation", RequestTicketEscalation)
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

  .on("EscalateTicket", EscalateTicket)
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

  .on("ReassignTicket", ReassignTicket)
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
  .with(TicketOperations)
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
