import { ZodEmpty } from "@rotorsoft/act";
import { z } from "zod";

export const DIGITS = [
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9"
] as const;
export const OPERATORS = ["+", "-", "*", "/"] as const;
export const SYMBOLS = [".", "="] as const;

export type Digits = (typeof DIGITS)[number];
export type Operators = (typeof OPERATORS)[number];

export const __schemas = {
  __state: z
    .object({
      left: z.string(),
      right: z.string(),
      operator: z.enum(OPERATORS),
      result: z.number()
    })
    .describe("Holds the running calculation"),
  __actions: {
    PressKey: z
      .object({ key: z.enum([...DIGITS, ...OPERATORS, ...SYMBOLS]) })
      .describe("User presses a key - either digit, operator, or symbol"),
    Clear: ZodEmpty
  },
  __events: {
    DigitPressed: z
      .object({ digit: z.enum(DIGITS) })
      .describe("A **digit** is pressed\n\n0-9"),
    OperatorPressed: z
      .object({ operator: z.enum(OPERATORS) })
      .describe("An **operator** is pressed\n\n+-*/"),
    DotPressed: ZodEmpty,
    EqualsPressed: ZodEmpty,
    Cleared: ZodEmpty
  }
} as const;
