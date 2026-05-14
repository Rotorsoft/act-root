import { z } from "zod";

export const Incremented = z.object({ amount: z.number().int() });
export const Decremented = z.object({ amount: z.number().int() });
export const Reset = z.object({});

export const CounterSchemas = {
  Incremented,
  Decremented,
  Reset,
} as const;

export type CounterEvents = {
  Incremented: z.infer<typeof Incremented>;
  Decremented: z.infer<typeof Decremented>;
  Reset: z.infer<typeof Reset>;
};

export const COUNTER_EVENT_NAMES = [
  "Incremented",
  "Decremented",
  "Reset",
] as const;
