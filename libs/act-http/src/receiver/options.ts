import { z } from "zod";
import type { CheckWebhookOptions } from "./check.js";

// A NaN or infinite bound makes both window checks false, so a replay of
// any age would pass.
export const MaxAgeSecondsSchema = z.number().min(0).default(300);

// An empty secret would verify against the empty key, while the webhook
// sender reads it as "unsigned", so the two sides would disagree.
const CheckOptionsSchema = z.object({
  secret: z.string().min(1).optional(),
  verify: z.object({ maxAgeSeconds: MaxAgeSecondsSchema }).optional(),
});

/**
 * Validate receiver options once, when a middleware is built. Throws
 * `ZodError` on an empty `secret` or a bad `verify.maxAgeSeconds`.
 */
export function check_options(options: CheckWebhookOptions): void {
  CheckOptionsSchema.parse({ secret: options.secret, verify: options.verify });
}
