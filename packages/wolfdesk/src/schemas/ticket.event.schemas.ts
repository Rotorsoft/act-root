import { z } from "zod";
import { actions } from "./ticket.action.schemas.js";

export const events = {
  TicketOpened: actions.OpenTicket.and(
    z.object({ userId: z.uuid(), messageId: z.uuid() })
  ).describe("A new ticket was opened"),
  TicketAssigned: actions.AssignTicket.describe(
    "An agent was assigned to the ticket"
  ),
  MessageAdded: actions.AddMessage.and(
    z.object({ from: z.uuid(), messageId: z.uuid() })
  ).describe("A user added a message to the ticket"),
  TicketClosed: z
    .object({ closedById: z.uuid() })
    .describe("The ticket was closed"),
  TicketEscalationRequested: z
    .object({ requestedById: z.uuid(), requestId: z.uuid() })
    .describe("A ticket escalation was requested"),
  TicketEscalated: actions.EscalateTicket.and(
    z.object({ escalationId: z.uuid() })
  ).describe("The ticket was escalated"),
  TicketReassigned: actions.ReassignTicket.describe(
    "The ticket was reassigned"
  ),
  MessageDelivered: actions.MarkMessageDelivered.describe(
    "The message was delivered to the recepient"
  ),
  MessageRead: actions.AcknowledgeMessage.describe(
    "The message was acknoledged by the recipient"
  ),
  TicketResolved: z
    .object({ resolvedById: z.uuid() })
    .describe("The ticket was marked as resolved"),
} as const;
