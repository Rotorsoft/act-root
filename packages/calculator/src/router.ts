import { act } from "@rotorsoft/act";
import { initTRPC } from "@trpc/server";
import { Calculator } from "./calculator.js";

/**
 * The built `Act` instance backing every transport in the
 * multi-transport demo. Exported so `packages/server` can mount the
 * generated Hono REST routes and the OpenAPI document against the
 * same registry — one Act, three transports.
 */
/** Builds the calculator orchestrator. The caller owns it — see `makeRouter`. */
export const buildCalculatorApp = () => act().withState(Calculator).build();

export type CalculatorApp = ReturnType<typeof buildCalculatorApp>;

const t = initTRPC.create();
const target = {
  stream: "calculator",
  actor: { id: "1", name: "Calculator" },
};

/**
 * Hand-written tRPC router. The tRPC sibling at
 * `@rotorsoft/act-http/trpc` is **not** used here: tRPC v11's
 * `BuiltRouter` type transitively references the internal `Unwrap`
 * symbol from `@trpc/server/dist/unstable-core-do-not-import`, which
 * the d.ts emitter can't name portably for the generator's
 * `<TApp>` return type. The same issue breaks
 * `createTRPCReact<typeof router>()`'s collision check downstream.
 *
 * For the singleton calculator (two static actions, one stream,
 * fixed actor) the hand-written router is trivially short — the
 * generator's real value sits with Hono REST (which the server
 * mounts) and OpenAPI (also generated). The tRPC generator stays
 * available for server-only use through `createHTTPHandler` where
 * the d.ts limitation doesn't surface.
 *
 * Tracking the typing follow-up as part of the act-http-api epic;
 * once tRPC v11 exposes a portable `BuiltRouter` substitute (or
 * isolated-declarations support lands), this file becomes a single
 * `trpc(app, options)` call.
 */
export const makeRouter = (app: CalculatorApp) =>
  t.router({
    PressKey: t.procedure
      .input(Calculator.actions.PressKey)
      .mutation(({ input }) => app.do("PressKey", target, input)),
    Clear: t.procedure.mutation(() => app.do("Clear", target, {})),
  });

export type CalculatorRouter = ReturnType<typeof makeRouter>;
