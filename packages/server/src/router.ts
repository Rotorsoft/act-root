import { act, Target } from "@rotorsoft/act";
import { Calculator, Digits, Operators } from "@rotorsoft/act-examples";
import { initTRPC } from "@trpc/server";

const app = act().with(Calculator).build();
const t = initTRPC.create();
const target: Target = {
  stream: "calculator",
  actor: { id: "1", name: "Calculator" },
};

export const router = t.router({
  PressKey: t.procedure
    .input(Calculator().actions.PressKey)
    .mutation(({ input }) => app.do("PressKey", target, input)),
  Clear: t.procedure.mutation(() => app.do("Clear", target, {})),
});

export type Router = typeof router;
export type { Digits, Operators };
