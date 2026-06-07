import { ZodEmpty } from "@rotorsoft/act";
import { z } from "zod";

// --- Primitives ---

export enum Priority {
  Low = "Low",
  Medium = "Medium",
  High = "High",
}

export const Attachment = z.object({
  url: z.url(),
});

export const Message = z.object({
  messageId: z.uuid(),
  body: z.string().min(1),
  from: z.uuid(),
  to: z.uuid().optional(),
  wasDelivered: z.boolean().optional(),
  wasRead: z.boolean().optional(),
  attachments: z.record(z.url(), Attachment),
});

// --- Shared field groups ---

const OpenTicketFields = z.object({
  productId: z.uuid(),
  supportCategoryId: z.uuid(),
  priority: z.enum(Priority),
  title: z.string().min(1),
  message: z.string().min(1),
  closeAfter: z.date().optional(),
});

const MessageFields = z.object({
  to: z.uuid(),
  body: z.string().min(1),
  attachments: z.record(z.url(), Attachment),
});

const AssignmentFields = z.object({
  agentId: z.uuid(),
  reassignAfter: z.date(),
  escalateAfter: z.date(),
});

const EscalationFields = z.object({
  requestId: z.uuid(),
  requestedById: z.uuid(),
});

const MessageIdField = z.object({ messageId: z.uuid() });

// --- Actions ---

export const OpenTicket = OpenTicketFields.describe("Opens a new ticket");

export const CloseTicket = ZodEmpty.describe("Closes the ticket");

export const MarkTicketResolved = ZodEmpty.describe("Flags ticket as resolved");

export const AddMessage = MessageFields.describe(
  "Add a new message to the ticket"
);

export const MarkMessageDelivered = MessageIdField.describe(
  "Flags a message as delivered"
);

export const AcknowledgeMessage = MessageIdField.describe(
  "Flags the message as read"
);

export const AssignTicket = AssignmentFields.describe(
  "Assigns the ticket to an agent"
);

export const RequestTicketEscalation = z
  .object({})
  .describe("Requests a ticket escalation");

export const EscalateTicket = EscalationFields.describe("Escalates the ticket");

export const ReassignTicket = AssignmentFields.describe("Reassigns the ticket");

// --- Events ---

export const TicketOpened = OpenTicketFields.and(
  z.object({ userId: z.uuid(), messageId: z.uuid() })
).describe("A new ticket was opened");

export const TicketClosed = z
  .object({ closedById: z.uuid() })
  .describe("The ticket was closed");

export const TicketResolved = z
  .object({ resolvedById: z.uuid() })
  .describe("The ticket was marked as resolved");

export const MessageAdded = MessageFields.and(
  z.object({ from: z.uuid(), messageId: z.uuid() })
).describe("A user added a message to the ticket");

export const MessageDelivered = MessageIdField.describe(
  "The message was delivered to the recepient"
);

export const MessageRead = MessageIdField.describe(
  "The message was acknoledged by the recipient"
);

export const TicketAssigned = AssignmentFields.describe(
  "An agent was assigned to the ticket"
);

export const TicketEscalationRequested = EscalationFields.describe(
  "A ticket escalation was requested"
);

export const TicketEscalated = EscalationFields.and(
  z.object({ escalationId: z.uuid() })
).describe("The ticket was escalated");

export const TicketReassigned = AssignmentFields.describe(
  "The ticket was reassigned"
);

// --- Partial state schemas for "Ticket" ---

const TicketBase = z.object({
  productId: z.uuid(),
  userId: z.uuid(),
  messages: z.record(z.uuid(), Message),
});

export const TicketCreationState = TicketBase.extend({
  supportCategoryId: z.uuid(),
  priority: z.enum(Priority),
  title: z.string().min(1),
  closedById: z.uuid().optional(),
  resolvedById: z.uuid().optional(),
  closeAfter: z.date().optional(),
});

export const TicketMessagingState = TicketBase;

export const TicketOperationsState = TicketBase.extend({
  agentId: z.uuid().optional(),
  requestId: z.uuid().optional(),
  requestedById: z.uuid().optional(),
  escalationId: z.uuid().optional(),
  reassignAfter: z.date().optional(),
  escalateAfter: z.date().optional(),
});
