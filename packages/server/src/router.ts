import { ActBuilder } from "@rotorsoft/act";
import {
  Calculator,
  CalculatorSchemas,
  Digits,
  Operators,
} from "@rotorsoft/act-examples";
import { initTRPC } from "@trpc/server";
import type { CreateFastifyContextOptions } from "@trpc/server/adapters/fastify";
import { OpenApiMeta } from "trpc-to-openapi";
import { z } from "zod";

export const act = new ActBuilder().with(Calculator).build();

export function createContext(ctx: CreateFastifyContextOptions) {
  const stream = ctx.req.headers["x-stream"] as string;
  return { ...ctx, stream };
}

type Context = Awaited<ReturnType<typeof createContext>>;
const t = initTRPC.meta<OpenApiMeta>().context<Context>().create();

// const CalculatorSnapshot = buildSnapshotSchema(CalculatorSchemas);

export const router = t.router({
  PressKey: t.procedure
    .meta({
      openapi: { method: "POST", path: "/PressKey", tags: ["Calculator"] },
    })
    .input(CalculatorSchemas.actions.PressKey)
    //.output(CalculatorSnapshot)
    .output(z.any())
    .mutation(async ({ ctx, input }) => {
      return await act.do("PressKey", { stream: ctx.stream }, input);
    }),
  Clear: t.procedure
    .meta({
      openapi: { method: "POST", path: "/Clear", tags: ["Calculator"] },
    })
    .input(z.object({}))
    //.output(CalculatorSnapshot)
    .output(z.any())
    .mutation(async ({ ctx }) => {
      return await act.do("Clear", { stream: ctx.stream }, {});
    }),
});

export type Router = typeof router;
export type { Digits, Operators };
