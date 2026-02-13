import { state, ZodEmpty, type Patch } from "@rotorsoft/act";
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
  "9",
] as const;
export const OPERATORS = ["+", "-", "*", "/"] as const;
export const SYMBOLS = [".", "="] as const;
export const KEYS = [...DIGITS, ...OPERATORS, ...SYMBOLS] as const;

export type Digits = (typeof DIGITS)[number];
export type Operators = (typeof OPERATORS)[number];
export type Keys = (typeof KEYS)[number];

const Events = {
  DigitPressed: z
    .object({ digit: z.enum(DIGITS) })
    .describe("A **digit** is pressed\n\n0-9"),
  OperatorPressed: z
    .object({ operator: z.enum(OPERATORS) })
    .describe("An **operator** is pressed\n\n+-*/"),
  DotPressed: ZodEmpty,
  EqualsPressed: ZodEmpty,
  Cleared: ZodEmpty,
};

const Actions = {
  PressKey: z
    .object({ key: z.enum(KEYS) })
    .describe("User presses a key - either digit, operator, or symbol"),
  Clear: ZodEmpty.describe("User clears the calculator"),
};

const State = z
  .object({
    left: z.string().optional(),
    right: z.string().optional(),
    operator: z.enum(OPERATORS).optional(),
    result: z.number(),
  })
  .describe("A calculator");

const round = (n: number): number => Math.round(n * 100) / 100;
const Operations = {
  ["+"]: (l: number, r: number): number => round(l + r),
  ["-"]: (l: number, r: number): number => round(l - r),
  ["*"]: (l: number, r: number): number => round(l * r),
  ["/"]: (l: number, r: number): number => round(l / r),
};

const append = (
  { operator, left, right }: Readonly<Patch<z.infer<typeof State>>>,
  key: Digits | "."
) =>
  operator
    ? { right: (right || "").concat(key) }
    : { left: (left || "").concat(key) };

const compute = (
  { operator, left, right }: Readonly<Patch<z.infer<typeof State>>>,
  new_op?: Operators
) => {
  if (operator && left && right) {
    const result = Operations[operator](
      Number.parseFloat(left),
      Number.parseFloat(right)
    );
    return {
      result,
      left: result.toString(),
      operator: new_op,
      right: undefined,
    };
  }
  return new_op === "-" && !left ? { left: "-" } : { operator: new_op };
};

const Calculator = state("Calculator", State)
  .init(() => ({ result: 0 }))
  .emits(Events)
  .patch({
    DigitPressed: ({ data }, state) => append(state, data.digit),
    OperatorPressed: ({ data }, state) => compute(state, data.operator),
    DotPressed: (_, state) => {
      const current = state.operator ? state.right || "" : state.left || "";
      if (current.includes(".")) return {};
      return append(state, ".");
    },
    EqualsPressed: (_, state) => compute(state),
    Cleared: () => ({
      result: 0,
      left: undefined,
      right: undefined,
      operator: undefined,
    }),
  })
  .on({ PressKey: Actions.PressKey })
  .emit(({ key }, { state }) => {
    if (key === ".") return ["DotPressed", {}];
    if (key === "=") {
      if (!state.operator) throw Error("no operator");
      return [["EqualsPressed", {}]]; // can return multiple events!
    }
    return DIGITS.includes(key as Digits)
      ? ["DigitPressed", { digit: key as Digits }]
      : ["OperatorPressed", { operator: key as Operators }];
  })
  .on({ Clear: Actions.Clear })
  .given([
    {
      description: "Must be dirty",
      valid: (state) =>
        !!state.left || !!state.right || !!state.result || !!state.operator,
    },
  ])
  .emit(() => ["Cleared", {}])
  .snap((s) => s.patches > 12)
  .build();

export { Calculator };
