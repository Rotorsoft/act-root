import { emit, type Infer, type Patch } from "@rotorsoft/act";
import { z } from "zod";
import { __schemas, DIGITS, Digits, Operators } from "./schemas";

const round = (n: number): number => Math.round(n * 100) / 100;
const Operations = {
  ["+"]: (l: number, r: number): number => round(l + r),
  ["-"]: (l: number, r: number): number => round(l - r),
  ["*"]: (l: number, r: number): number => round(l * r),
  ["/"]: (l: number, r: number): number => round(l / r)
};

const append = (
  { operator, left, right }: Patch<z.infer<typeof __schemas.__state>>,
  key: Digits | "."
) =>
  operator
    ? { right: (right || "").concat(key) }
    : { left: (left || "").concat(key) };

const compute = (
  { operator, left, right }: Patch<z.infer<typeof __schemas.__state>>,
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
      right: undefined
    };
  }
  return new_op === "-" && !left ? { left: "-" } : { operator: new_op };
};

export function Calculator(): Infer<typeof __schemas> {
  return {
    ...__schemas,
    description: "A calculator",
    init: () => ({ result: 0 }),
    reduce: {
      DigitPressed: (state, { data }) => append(state, data.digit),
      OperatorPressed: (state, { data }) => compute(state, data.operator),
      DotPressed: (state) => append(state, "."),
      EqualsPressed: (state) => compute(state),
      Cleared: () => ({
        result: 0,
        left: undefined,
        right: undefined,
        operator: undefined
      })
    },
    on: {
      PressKey: ({ key }, state) => {
        if (key === ".") return emit("DotPressed", {});
        if (key === "=") {
          if (!state.operator) throw Error("no operator");
          return emit("EqualsPressed", {});
        }
        return DIGITS.includes(key as Digits)
          ? emit("DigitPressed", { digit: key as Digits })
          : emit("OperatorPressed", { operator: key as Operators });
      },
      Clear: () => emit("Cleared", {})
    },
    given: {
      Clear: [
        {
          description: "Must be dirty",
          valid: (state) =>
            !!state.left || !!state.right || !!state.result || !!state.operator
        }
      ]
    },
    snapshot: (s) => s.applyCount > 12
  };
}
