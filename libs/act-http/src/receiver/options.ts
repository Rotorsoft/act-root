import { z } from "zod";

// A NaN or infinite bound makes both window checks false, so a replay of
// any age would pass.
export const MaxAgeSecondsSchema = z.number().min(0).default(300);

// An empty secret would verify against the empty key, while the webhook
// sender reads it as "unsigned", so the two sides would disagree.
export const ReceiverOptionsSchema = z.object({
  secret: z.string().min(1).optional(),
  verify: z.object({ maxAgeSeconds: MaxAgeSecondsSchema }).optional(),
});
