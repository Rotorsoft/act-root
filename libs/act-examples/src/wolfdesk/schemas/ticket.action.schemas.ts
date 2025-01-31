import { ZodEmpty } from "@rotorsoft/act";
import { z } from "zod";
import { Attachment, Priority } from "./ticket.state.schemas";

export const actions = {
  OpenTicket: z
    .object({
      productId: z.string().uuid(),
      supportCategoryId: z.string().uuid(),
      priority: z.nativeEnum(Priority),
      title: z.string().min(1),
      message: z.string().min(1),
      closeAfter: z.date().optional(),
    })
    .describe("Opens a new ticket"),
  AssignTicket: z
    .object({
      agentId: z.string().uuid(),
      reassignAfter: z.date(),
      escalateAfter: z.date(),
    })
    .describe("Assigns the ticket to an agent"),
  AddMessage: z
    .object({
      to: z.string().uuid(),
      body: z.string().min(1),
      attachments: z.record(z.string().url(), Attachment),
    })
    .describe("Add a new message to the ticket"),
  CloseTicket: ZodEmpty.describe("Closes the ticket"),
  RequestTicketEscalation: ZodEmpty.describe("Requests a ticket escalation"),
  EscalateTicket: z
    .object({ requestId: z.string().uuid(), requestedById: z.string().uuid() })
    .describe("Escalates the ticket"),
  ReassignTicket: z
    .object({
      agentId: z.string().uuid(),
      reassignAfter: z.date(),
      escalateAfter: z.date(),
    })
    .describe("Reassigns the ticket"),
  MarkMessageDelivered: z
    .object({ messageId: z.string().uuid() })
    .describe("Flags a message as delivered"),
  AcknowledgeMessage: z
    .object({ messageId: z.string().uuid() })
    .describe("Flags the message as read"),
  MarkTicketResolved: ZodEmpty.describe("Flags ticket as resolved"),
} as const;
