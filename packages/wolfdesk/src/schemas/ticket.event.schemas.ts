import { z } from "zod";
import { Priority } from "./ticket.state.schemas.js";

// --- ticket-creation events ---
export const TicketOpened = z
  .object({
    productId: z.uuid(),
    supportCategoryId: z.uuid(),
    priority: z.enum(Priority),
    title: z.string().min(1),
    message: z.string().min(1),
    closeAfter: z.date().optional(),
  })
  .and(z.object({ userId: z.uuid(), messageId: z.uuid() }))
  .describe("A new ticket was opened");

export const TicketClosed = z
  .object({ closedById: z.uuid() })
  .describe("The ticket was closed");

export const TicketResolved = z
  .object({ resolvedById: z.uuid() })
  .describe("The ticket was marked as resolved");

// --- ticket-messaging events ---
export const MessageAdded = z
  .object({
    to: z.uuid(),
    body: z.string().min(1),
    attachments: z.record(z.url(), z.object({ url: z.url() })),
  })
  .and(z.object({ from: z.uuid(), messageId: z.uuid() }))
  .describe("A user added a message to the ticket");

export const MessageDelivered = z
  .object({ messageId: z.uuid() })
  .describe("The message was delivered to the recepient");

export const MessageRead = z
  .object({ messageId: z.uuid() })
  .describe("The message was acknoledged by the recipient");

// --- ticket-operations events ---
export const TicketAssigned = z
  .object({
    agentId: z.uuid(),
    reassignAfter: z.date(),
    escalateAfter: z.date(),
  })
  .describe("An agent was assigned to the ticket");

export const TicketEscalationRequested = z
  .object({ requestedById: z.uuid(), requestId: z.uuid() })
  .describe("A ticket escalation was requested");

export const TicketEscalated = z
  .object({ requestId: z.uuid(), requestedById: z.uuid() })
  .and(z.object({ escalationId: z.uuid() }))
  .describe("The ticket was escalated");

export const TicketReassigned = z
  .object({
    agentId: z.uuid(),
    reassignAfter: z.date(),
    escalateAfter: z.date(),
  })
  .describe("The ticket was reassigned");
