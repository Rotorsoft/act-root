import { ActBuilder, Target } from "@rotorsoft/act";
import { Calculator, Digits, Operators } from "@rotorsoft/act-examples";
import { initTRPC } from "@trpc/server";

const act = new ActBuilder().with(Calculator).build();
const t = initTRPC.create();
const target: Target = {
  stream: "calculator",
  actor: { id: "1", name: "Calculator" },
};

export const router = t.router({
  PressKey: t.procedure
    .input(Calculator().actions.PressKey)
    .mutation(({ input }) => act.do("PressKey", target, input)),
  Clear: t.procedure.mutation(() => act.do("Clear", target, {})),
});

export type Router = typeof router;
export type { Digits, Operators };
