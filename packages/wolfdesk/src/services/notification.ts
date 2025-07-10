import { z } from "zod";
import { Message } from "../schemas/index.js";

export const deliverMessage = (
  message: z.infer<typeof Message>
): Promise<void> => {
  process.env.NODE_ENV === "development" &&
    console.log("Delivering message", message);
  return Promise.resolve();
};
