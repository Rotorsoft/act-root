import { ZodEmpty } from "@rotorsoft/act";
import { z } from "zod";
import { Attachment, Priority } from "./ticket.state.schemas.js";

// --- ticket-creation actions ---
export const OpenTicket = z
  .object({
    productId: z.uuid(),
    supportCategoryId: z.uuid(),
    priority: z.enum(Priority),
    title: z.string().min(1),
    message: z.string().min(1),
    closeAfter: z.date().optional(),
  })
  .describe("Opens a new ticket");

export const CloseTicket = ZodEmpty.describe("Closes the ticket");

export const MarkTicketResolved = ZodEmpty.describe("Flags ticket as resolved");

// --- ticket-messaging actions ---
export const AddMessage = z
  .object({
    to: z.uuid(),
    body: z.string().min(1),
    attachments: z.record(z.url(), Attachment),
  })
  .describe("Add a new message to the ticket");

export const MarkMessageDelivered = z
  .object({ messageId: z.uuid() })
  .describe("Flags a message as delivered");

export const AcknowledgeMessage = z
  .object({ messageId: z.uuid() })
  .describe("Flags the message as read");

// --- ticket-operations actions ---
export const AssignTicket = z
  .object({
    agentId: z.uuid(),
    reassignAfter: z.date(),
    escalateAfter: z.date(),
  })
  .describe("Assigns the ticket to an agent");

export const RequestTicketEscalation = z
  .object({})
  .describe("Requests a ticket escalation");

export const EscalateTicket = z
  .object({ requestId: z.uuid(), requestedById: z.uuid() })
  .describe("Escalates the ticket");

export const ReassignTicket = z
  .object({
    agentId: z.uuid(),
    reassignAfter: z.date(),
    escalateAfter: z.date(),
  })
  .describe("Reassigns the ticket");
