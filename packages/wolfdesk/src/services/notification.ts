import type { z } from "zod";
import type { Message } from "../schemas/index.js";

// Simulates a flaky downstream delivery channel: the first few attempts on
// a fresh message id fail, so the `deliver` reaction's exponential backoff
// is observable in console logs. Set WOLFDESK_DELIVERY_FAILS=0 to disable.
const failuresLeft = new Map<string, number>();
const initialFailures = Number(process.env.WOLFDESK_DELIVERY_FAILS ?? 2);

export const deliverMessage = async (
  message: z.infer<typeof Message>
): Promise<void> => {
  if (process.env.NODE_ENV === "development" && initialFailures > 0) {
    const remaining = failuresLeft.get(message.messageId) ?? initialFailures;
    if (remaining > 0) {
      failuresLeft.set(message.messageId, remaining - 1);
      console.log(
        `Delivery flake for ${message.messageId} — ${remaining} attempts remaining`
      );
      throw new Error("delivery channel transiently unavailable");
    }
    failuresLeft.delete(message.messageId);
  }
  process.env.NODE_ENV === "development" &&
    console.log("Delivering message", message);
};
