/**
 * @packageDocumentation
 * @module act-http/trpc
 *
 * tRPC subpath for the auto-generated API epic (#835). Walks the
 * registry of a built `Act` once at function call and emits a typed
 * router that exposes every registered action as a flat `mutation`,
 * matching the shape hand-written tRPC routers in the Act ecosystem
 * already use.
 *
 * Usage:
 *
 * ```ts
 * import { trpc } from "@rotorsoft/act-http/trpc";
 *
 * const router = trpc(app, {
 *   actor: (ctx) => ({ id: ctx.user.id, name: ctx.user.name }),
 *   stream: (action, input, ctx) => input.stream ?? ctx.tenant,
 * });
 *
 * // Client sees:
 * //   appRouter.PressKey.mutate({ key: "5" })
 * //   appRouter.OpenTicket.mutate({ title: "..." })
 * ```
 *
 * The route shape is flat: one procedure per registered action at
 * the top level. Action names are the unique identifiers across
 * the registry (the framework already enforces no duplicates), so
 * an extra namespace tier would be overhead in the common case.
 * Pure mutations for this slice; query/projection wiring lives in
 * a follow-up. See `libs/act-http/README.md` for the full surface
 * walkthrough.
 *
 * **Actor lives on the context.** The generator wires an internal
 * tRPC middleware that runs the host's
 * {@link TrpcOptions.actor | actor extractor} once per call and
 * injects the resolved {@link Actor} onto the downstream context as
 * `ctx.actor`. Every generated mutation reads from there — auth
 * resolves at the procedure boundary, not inside each action body,
 * and any composed middleware (logging, tracing) sees the same
 * `ctx.actor`. The middleware factory is also exported as
 * {@link authenticated} for hosts that need to compose it into
 * their own procedure chain.
 *
 * Composes the shared utilities at `@rotorsoft/act-http/api`:
 * {@link ActorExtractor} for the auth seam, {@link toApiError} for
 * the uniform error→status/code mapping, {@link withIdempotency}
 * for `Idempotency-Key` dedup. Three transports (this one, Hono,
 * OpenAPI) ride the same utilities so a client talking to two
 * transports never sees two error shapes for the same framework
 * error.
 */
import type { Actor, Target } from "@rotorsoft/act";
import type { IdempotencyStore } from "@rotorsoft/act-ops/idempotency";
import {
  type AnyTRPCMiddlewareFunction,
  type AnyTRPCMutationProcedure,
  type AnyTRPCRootTypes,
  initTRPC,
  type TRPCBuiltRouter,
  TRPCError,
} from "@trpc/server";
import { z } from "zod";
import {
  type ActorExtractor,
  resolveSseConfig,
  runSseSubscription,
  SseConnectionCounter,
  type SseOptions,
  toApiError,
  withIdempotency,
} from "../api/index.js";

/**
 * Per-call options for {@link trpc}. The host supplies the three
 * seams the package can't make decisions on:
 *
 * - `actor` — auth resolver. Receives the tRPC context, returns the
 *   `Actor` that flows onto `ctx.actor` for every generated
 *   procedure (via an internal {@link authenticated}).
 * - `stream` — stream-id resolver. Receives the action name, the
 *   validated action input, and the original tRPC context; returns
 *   the target stream. Singleton aggregates return a constant;
 *   per-tenant aggregates pull from input or context.
 * - `expectedVersion` (optional) — optimistic-concurrency resolver.
 *   When set, the procedure threads the resolved value through
 *   `target.expectedVersion` so `app.do` refuses to commit if the
 *   stream has moved. Hosts typically read it from an `If-Match`
 *   header on the underlying HTTP request, or pull it from the
 *   client's last-known snapshot. Returning `undefined` skips the
 *   check for that call — handy when only some actions are
 *   concurrency-sensitive.
 * - `idempotency` (optional) — when set, the procedure honors
 *   `Idempotency-Key` via the shared
 *   {@link withIdempotency} helper. The host supplies the
 *   `IdempotencyStore` and a `keyFrom` extractor that reads the key
 *   out of the tRPC context (typically a header). On a duplicate
 *   claim, the procedure throws a `CONFLICT` `TRPCError` — the
 *   receiver-side convention of "ack the duplicate" doesn't carry
 *   over because the contract intentionally does not cache the
 *   original handler's result.
 *
 * @template Ctx The host's tRPC context shape. Flows end-to-end —
 *   procedures see this exact context type (plus `actor`) at
 *   runtime.
 */
export type TrpcOptions<Ctx> = {
  readonly actor: ActorExtractor;
  readonly stream: (
    action_name: string,
    input: unknown,
    ctx: Ctx
  ) => string | Promise<string>;
  readonly expectedVersion?: (
    action_name: string,
    input: unknown,
    ctx: Ctx
  ) => number | undefined | Promise<number | undefined>;
  readonly idempotency?: {
    readonly store: IdempotencyStore;
    readonly keyFrom: (ctx: Ctx) => string | undefined;
  };
  /**
   * Optional SSE wiring. When set, the generator emits one
   * subscription per unique state name in the registry, grouped on
   * the returned router as
   * `router.subscribe.<stateName>.useSubscription({ stream })`.
   * Each subscription yields `{ kind: "state", data }` once with
   * the cached state (when present) and then `{ kind: "patch",
   * data }` for every patch the shared
   * {@link SseOptions.channel} publishes. The per-process
   * connection cap surfaces as a `TOO_MANY_REQUESTS` `TRPCError`.
   *
   * Off by default — most APIs don't expose live state to every
   * client, and opening one is widening both the auth and cost
   * surface.
   */
  readonly sse?: SseOptions;
};

/**
 * Build a tRPC middleware that runs an {@link ActorExtractor} once
 * per call and forwards the resolved {@link Actor} on the
 * downstream context as `ctx.actor`. The generator at
 * {@link trpc} uses this internally; it's also exported so hosts
 * that want to compose their own procedure chain (logging,
 * tracing, custom auth flavors) can wire it directly:
 *
 * ```ts
 * import { initTRPC } from "@trpc/server";
 * import { authenticated } from "@rotorsoft/act-http/trpc";
 *
 * type Ctx = { user?: { id: string; name: string } };
 * const t = initTRPC.context<Ctx>().create();
 *
 * const authed = t.procedure.use(
 *   authenticated((ctx) => {
 *     if (!ctx.user) throw new Error("not authenticated");
 *     return { id: ctx.user.id, name: ctx.user.name };
 *   })
 * );
 *
 * // Inside any procedure built off `authed`, `ctx.actor: Actor`.
 * ```
 *
 * The middleware is unaware of the host's `t` instance — it returns
 * a structurally-typed function that any tRPC `procedure.use(...)`
 * accepts. Errors thrown by the extractor surface unchanged
 * (typically wrap them as `TRPCError({ code: "UNAUTHORIZED" })`
 * in the extractor body).
 */
export function authenticated(
  extractor: ActorExtractor
): AnyTRPCMiddlewareFunction {
  // tRPC's middleware function type lives behind
  // `unstable-core-do-not-import`; we satisfy it structurally with the
  // shape `procedure.use(...)` actually requires (an `{ ctx, next }`
  // bag whose `next` callback is invoked once with the augmented ctx)
  // and cast the structurally-typed result up to the named export. The
  // type cast carries no `any`; both sides are structurally compatible
  // at the call site.
  const middleware = async function actor_middleware({
    ctx,
    next,
  }: {
    ctx: object;
    next: (opts: { ctx: object }) => Promise<unknown>;
  }) {
    const actor = await extractor(ctx);
    return next({ ctx: { ...ctx, actor } });
  };
  return middleware as unknown as AnyTRPCMiddlewareFunction;
}

/**
 * Map a thrown framework error onto a `TRPCError`. Known errors get
 * their conventional tRPC code (`ConcurrencyError` → `CONFLICT`,
 * `ValidationError` → `UNPROCESSABLE_CONTENT`, etc.); unknown throws
 * surface as `INTERNAL_SERVER_ERROR`. Every transport in the
 * act-http epic passes through the same {@link toApiError} table,
 * so a client talking to both this subpath and the REST sibling
 * sees one envelope per framework error.
 *
 * @internal
 */
function to_trpc_error(err: unknown): TRPCError {
  const { status, body } = toApiError(err);
  const code = status_to_trpc_code(status);
  return new TRPCError({
    code,
    message: body.detail ?? body.error,
    cause: err instanceof Error ? err : undefined,
  });
}

/**
 * Minimal status → tRPC code map. Only the statuses
 * {@link ERROR_MAP} produces (plus 500) appear here; anything else
 * collapses to `INTERNAL_SERVER_ERROR`.
 *
 * @internal
 */
function status_to_trpc_code(status: number): TRPCError["code"] {
  switch (status) {
    case 400:
      return "BAD_REQUEST";
    case 409:
      return "CONFLICT";
    case 410:
      return "PRECONDITION_FAILED";
    case 412:
      return "CONFLICT";
    case 422:
      return "UNPROCESSABLE_CONTENT";
    default:
      return "INTERNAL_SERVER_ERROR";
  }
}

/**
 * Build a typed tRPC router from a built `Act` instance.
 *
 * Walks `app.registry.actions` once and emits one flat mutation per
 * action under `router.<actionName>`. The framework already enforces
 * no duplicate action names across states, so a flat tier reads
 * cleanly at the client and matches the hand-written router shape
 * adopters already have. Each mutation:
 *
 * 1. Runs the internal {@link authenticated} — `options.actor`
 *    resolves the {@link Actor} once and injects it onto
 *    `ctx.actor`.
 * 2. Resolves the target stream via `options.stream(name, input, ctx)`.
 * 3. (Optionally) claims the `Idempotency-Key` via
 *    {@link withIdempotency} — throws `CONFLICT` on duplicate.
 * 4. Calls `app.do(name, { stream, actor: ctx.actor }, input)`.
 * 5. Maps any thrown framework error onto a `TRPCError` via
 *    {@link toApiError}.
 *
 * The returned router's procedure inputs come straight from each
 * action's Zod schema; outputs are the framework's
 * `Snapshot<TState, TEvents>[]` shape. Strong typing flows
 * end-to-end via tRPC's normal inference path — the client sees
 * `appRouter.Calculator.PressKey.mutate({ key: "5" })` as a typed
 * call without any codegen.
 *
 * @template Ctx The tRPC context shape the host's runtime feeds in.
 *   Flows through `actor`, `stream`, and `idempotency.keyFrom` so
 *   the operator's existing context types just work. The internal
 *   middleware augments `Ctx` with `{ actor: Actor }` on the
 *   downstream procedure context.
 *
 * @param app A built `Act` orchestrator.
 * @param options Auth, stream, and (optional) idempotency seams.
 * @returns A tRPC router covering every registered action, grouped
 *   by owning state.
 */
/**
 * Structural shape of the Act surface this generator walks at
 * runtime — the registry's action-name → owning-state map plus the
 * `do(...)` dispatch. Letting TApp infer to the caller's concrete
 * `Act<...>` against this structural bound (instead of forcing it
 * to fit a narrow framework-typed upper bound) keeps the variance
 * of nested types like `PatchHandler` from leaking — and avoids
 * `any` in the signature.
 *
 * @internal
 */
type ActSurface = {
  readonly registry: {
    actions: Record<
      string,
      {
        readonly name: string;
        readonly actions: Record<string, unknown>;
      }
    >;
  };
  do(action: string, target: Target, payload: unknown): Promise<unknown>;
};

/**
 * Generated router type — one mutation procedure per action name in
 * `TApp`'s registry. Mapped over the concrete action keys so
 * `createTRPCReact<typeof router>()` sees specific procedure names
 * (`PressKey`, `Clear`, …) instead of a wide `Record<string, ...>`
 * index signature — which is what trips tRPC React's
 * "useContext / Provider / useUtils collides" check on widely-typed
 * routers.
 *
 * @internal
 */
type GeneratedRouter<TApp> = TRPCBuiltRouter<
  AnyTRPCRootTypes,
  TApp extends { registry: { actions: infer TActions } }
    ? { [K in keyof TActions]: AnyTRPCMutationProcedure }
    : Record<string, AnyTRPCMutationProcedure>
>;

export function trpc<
  Ctx extends object = object,
  TApp extends ActSurface = ActSurface,
>(app: TApp, options: TrpcOptions<Ctx>): GeneratedRouter<TApp> {
  const t = initTRPC.context<Ctx>().create();

  // Resolve the actor inline per mutation instead of via
  // `t.procedure.use(authenticated(...))`. The middleware path threads
  // tRPC's internal `Unwrap` type into each procedure's inferred shape,
  // which the d.ts emitter can't name portably (`unstable-core-do-not-
  // import` has a hashed file name that varies per build). Inlining
  // sidesteps the issue entirely — the standalone `authenticated`
  // export still works for hosts who want middleware composition.
  const handlers: Record<
    string,
    ReturnType<ReturnType<typeof t.procedure.input>["mutation"]>
  > = {};
  for (const [action_name, state] of Object.entries(app.registry.actions)) {
    handlers[action_name] = t.procedure
      .input(state.actions[action_name] as never)
      .mutation(async ({ input, ctx }) => {
        const host_ctx = ctx as unknown as Ctx;
        try {
          const actor = await options.actor(host_ctx);
          const stream = await options.stream(action_name, input, host_ctx);
          const expected_version = options.expectedVersion
            ? await options.expectedVersion(action_name, input, host_ctx)
            : undefined;
          const target =
            expected_version === undefined
              ? { stream, actor }
              : { stream, actor, expectedVersion: expected_version };

          if (options.idempotency) {
            const key = options.idempotency.keyFrom(host_ctx);
            if (!key) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: "Idempotency-Key required",
              });
            }
            const outcome = await withIdempotency(
              options.idempotency.store,
              key,
              () =>
                app.do(action_name as never, target as never, input as never)
            );
            if (outcome.deduped) {
              throw new TRPCError({
                code: "CONFLICT",
                message:
                  "Idempotency-Key already used; original result not cached",
              });
            }
            return outcome.result;
          }

          return await app.do(
            action_name as never,
            target as never,
            input as never
          );
        } catch (err) {
          if (err instanceof TRPCError) throw err;
          throw to_trpc_error(err);
        }
      });
  }

  if (options.sse) {
    const sse_config = resolveSseConfig(options.sse);
    const sse_counter = new SseConnectionCounter(sse_config.maxConnections);
    const state_names = new Set<string>();
    for (const action of Object.values(app.registry.actions)) {
      state_names.add(action.name);
    }
    const sse_handlers: Record<string, unknown> = {};
    for (const state_name of state_names) {
      sse_handlers[state_name] = t.procedure
        .input(z.object({ stream: z.string().min(1) }))
        .subscription(({ input, signal }) =>
          runSseSubscription(
            sse_config.channel,
            input.stream,
            sse_counter,
            signal,
            () => {
              throw new TRPCError({
                code: "TOO_MANY_REQUESTS",
                message: "max concurrent SSE subscriptions reached",
              });
            }
          )
        );
    }
    handlers.subscribe = t.router(sse_handlers as never) as never;
  }

  // The runtime router IS structurally compatible with
  // `GeneratedRouter<TApp>` (one mutation per action key), but tRPC's
  // `BuiltRouter` carries an internal `Unwrap<Ctx>` that the d.ts
  // emitter can't name portably. Bridging through `unknown` keeps the
  // caller-visible type clean (specific procedure names, no
  // index-signature widening that trips React tRPC's collision check).
  return t.router(handlers) as unknown as GeneratedRouter<TApp>;
}
