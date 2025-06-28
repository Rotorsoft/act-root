import { act, Target } from "@rotorsoft/act";
import { initTRPC } from "@trpc/server";
import { Calculator } from "./calculator.js";

const app = act().with(Calculator).build();
const t = initTRPC.create();
const target: Target = {
  stream: "calculator",
  actor: { id: "1", name: "Calculator" },
};

export const calculatorRouter = t.router({
  PressKey: t.procedure
    .input(Calculator.actions.PressKey)
    .mutation(({ input }) => app.do("PressKey", target, input)),
  Clear: t.procedure.mutation(() => app.do("Clear", target, {})),
});

export type CalculatorRouter = typeof calculatorRouter;
