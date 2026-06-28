// Landing-page quickstart — type-checked against the live @rotorsoft/act API in CI.
import { act, state, ZodEmpty } from "@rotorsoft/act";
import { z } from "zod";

const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;
const OPERATORS = ["+", "-", "*", "/"] as const;
type Digit = (typeof DIGITS)[number];
type Operator = (typeof OPERATORS)[number];

const Calculator = z.object({ left: z.string().optional(), right: z.string().optional(), operator: z.enum(OPERATORS).optional(), result: z.number() });
const ops: Record<Operator, (l: number, r: number) => number> = { "+": (l, r) => l + r, "-": (l, r) => l - r, "*": (l, r) => l * r, "/": (l, r) => l / r };

const calc = state({ Calculator })
  .init(() => ({ result: 0 }))
  .emits({ DigitPressed: z.object({ digit: z.enum(DIGITS) }), OperatorPressed: z.object({ operator: z.enum(OPERATORS) }), EqualsPressed: ZodEmpty })
  .patch({
    DigitPressed: ({ data }, s) => (s.operator ? { right: (s.right ?? "") + data.digit } : { left: (s.left ?? "") + data.digit }),
    OperatorPressed: ({ data }) => ({ operator: data.operator }),
    EqualsPressed: (_e, s) => (s.operator && s.left && s.right ? { result: ops[s.operator](Number(s.left), Number(s.right)) } : {}),
  })
  .on({ PressKey: z.object({ key: z.enum([...DIGITS, ...OPERATORS, "="]) }) })
  .emit(({ key }) => {
    if (key === "=") return ["EqualsPressed", {}];
    return DIGITS.includes(key as Digit) ? ["DigitPressed", { digit: key as Digit }] : ["OperatorPressed", { operator: key as Operator }];
  })
  .build();

const app = act().withState(calc).build();
const actor = { id: "1", name: "User" };

async function run() {
  for (const key of ["4", "+", "2", "="] as const) await app.do("PressKey", { stream: "calc-1", actor }, { key });
  console.log((await app.load(calc, "calc-1")).state.result); // 6
}
run();
