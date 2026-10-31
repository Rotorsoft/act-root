import { act } from "@rotorsoft/act";
import { type HonoOptions, hono } from "@rotorsoft/act-http/hono";
import { trpc } from "@rotorsoft/act-http/trpc";
import { Calculator } from "./calculator.js";

/**
 * The built `Act` instance backing every transport in the
 * multi-transport demo: one Act, generated tRPC and REST APIs, and the
 * OpenAPI document `packages/server` serves beside them.
 */
export const calculatorApp = act().withState(Calculator).build();

const stream = () => "calculator";

/**
 * The tRPC router, generated from the app: one mutation per action,
 * typed with the action's payload and the snapshots it returns, so the
 * client's `createTRPCReact<CalculatorRouter>()` needs no codegen.
 */
export const calculatorRouter = trpc(calculatorApp, {
  actor: () => ({ id: "1", name: "Calculator" }),
  stream,
});

export type CalculatorRouter = typeof calculatorRouter;

/**
 * The REST routes (`POST /api/actions/<name>`, `GET /api/sse/Calculator`),
 * generated from the app. The host supplies the actor and the SSE channel;
 * the client types its `hc<CalculatorRest>()` from the result.
 */
export const calculatorRest = (
  options: Pick<HonoOptions, "actor"> & {
    readonly sse: NonNullable<HonoOptions["sse"]>;
  }
) => hono(calculatorApp, { stream, ...options });

export type CalculatorRest = ReturnType<typeof calculatorRest>;
