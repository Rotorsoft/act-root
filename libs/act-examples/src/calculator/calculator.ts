import { type Infer, type Patch } from "@rotorsoft/act";
import { z } from "zod/v4";
import { CalculatorSchemas, DIGITS, Digits, Operators } from "./schemas";

const round = (n: number): number => Math.round(n * 100) / 100;
const Operations = {
  ["+"]: (l: number, r: number): number => round(l + r),
  ["-"]: (l: number, r: number): number => round(l - r),
  ["*"]: (l: number, r: number): number => round(l * r),
  ["/"]: (l: number, r: number): number => round(l / r),
};

const append = (
  {
    operator,
    left,
    right,
  }: Readonly<Patch<z.infer<typeof CalculatorSchemas.state>>>,
  key: Digits | "."
) =>
  operator
    ? { right: (right || "").concat(key) }
    : { left: (left || "").concat(key) };

const compute = (
  {
    operator,
    left,
    right,
  }: Readonly<Patch<z.infer<typeof CalculatorSchemas.state>>>,
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

export function Calculator(): Infer<typeof CalculatorSchemas> {
  return {
    ...CalculatorSchemas,
    init: () => ({ result: 0 }),
    patch: {
      DigitPressed: ({ data }, state) => append(state, data.digit),
      OperatorPressed: ({ data }, state) => compute(state, data.operator),
      DotPressed: (_, state) => append(state, "."),
      EqualsPressed: (_, state) => compute(state),
      Cleared: () => ({
        result: 0,
        left: undefined,
        right: undefined,
        operator: undefined,
      }),
    },
    on: {
      PressKey: async ({ key }, state) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (key === ".") return ["DotPressed", {}];
        if (key === "=") {
          if (!state.operator) throw Error("no operator");
          return [["EqualsPressed", {}]]; // can return multiple events!
        }
        return DIGITS.includes(key as Digits)
          ? ["DigitPressed", { digit: key as Digits }]
          : ["OperatorPressed", { operator: key as Operators }];
      },
      Clear: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return ["Cleared", {}];
      },
    },
    given: {
      Clear: [
        {
          description: "Must be dirty",
          valid: (state) =>
            !!state.left || !!state.right || !!state.result || !!state.operator,
        },
      ],
    },
    snap: (s) => s.patches > 12,
  };
}
