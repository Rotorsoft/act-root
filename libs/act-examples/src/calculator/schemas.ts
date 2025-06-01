import { ZodEmpty } from "@rotorsoft/act";
import { z } from "zod/v4";

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
  "9",
] as const;
export const OPERATORS = ["+", "-", "*", "/"] as const;
export const SYMBOLS = [".", "="] as const;
export const KEYS = [...DIGITS, ...OPERATORS, ...SYMBOLS] as const;

export type Digits = (typeof DIGITS)[number];
export type Operators = (typeof OPERATORS)[number];
export type Keys = (typeof KEYS)[number];

const DigitPressed = z
  .object({ digit: z.enum(DIGITS) })
  .describe("A **digit** is pressed\n\n0-9");

const OperatorPressed = z
  .object({ operator: z.enum(OPERATORS) })
  .describe("An **operator** is pressed\n\n+-*/");

const DotPressed = ZodEmpty;
const EqualsPressed = ZodEmpty;
const Cleared = ZodEmpty;

const events = {
  DigitPressed,
  OperatorPressed,
  DotPressed,
  EqualsPressed,
  Cleared,
};

const actions = {
  PressKey: z
    .object({ key: z.enum(KEYS) })
    .describe("User presses a key - either digit, operator, or symbol"),
  Clear: ZodEmpty.describe("User clears the calculator"),
};

const state = z
  .object({
    left: z.string().optional(),
    right: z.string().optional(),
    operator: z.enum(OPERATORS).optional(),
    result: z.number(),
  })
  .describe("A calculator");

export const CalculatorSchemas = { events, actions, state } as const;
