import { ActBuilder } from "@rotorsoft/act";
import { Calculator, Digits, Operators } from "@rotorsoft/act-examples";
import { initTRPC } from "@trpc/server";

const act = new ActBuilder().with(Calculator).build();
const t = initTRPC.create();
const stream = "calculator";

export const router = t.router({
  PressKey: t.procedure
    .input(Calculator().actions.PressKey)
    .mutation(({ input }) => act.do("PressKey", { stream }, input)),
  Clear: t.procedure.mutation(() => act.do("Clear", { stream }, {})),
});

export type Router = typeof router;
export type { Digits, Operators };
