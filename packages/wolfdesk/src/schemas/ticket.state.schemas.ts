import { z } from "zod";

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

export const Ticket = z.object({
  productId: z.uuid(),
  supportCategoryId: z.uuid(),
  priority: z.enum(Priority),
  title: z.string().min(1),
  userId: z.uuid(),
  messages: z.record(z.uuid(), Message),
  agentId: z.uuid().optional(),
  requestId: z.uuid().optional(),
  requestedById: z.uuid().optional(),
  escalationId: z.uuid().optional(),
  resolvedById: z.uuid().optional(),
  closedById: z.uuid().optional(),
  reassignAfter: z.date().optional(),
  escalateAfter: z.date().optional(),
  closeAfter: z.date().optional(),
});
