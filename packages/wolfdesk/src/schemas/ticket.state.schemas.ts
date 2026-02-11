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
