import { z } from "zod";
import type { CheckWebhookOptions } from "./check.js";

// An empty secret would verify against the empty key, while the webhook
// sender reads it as "unsigned", so the two sides would disagree.
const CheckOptionsSchema = z.object({ secret: z.string().min(1).optional() });

/**
 * Validate receiver options once, when a middleware is built. Throws
 * `ZodError` on an empty `secret`.
 */
export function check_options(options: CheckWebhookOptions): void {
  CheckOptionsSchema.parse({ secret: options.secret });
}
