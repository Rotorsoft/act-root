/**
 * @packageDocumentation
 * @module act-http/trpc
 *
 * tRPC subpath of the auto-generated API. Walks the
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
 * type Ctx = { user: { id: string; name: string }; tenant: string };
 *
 * const router = trpc<Ctx, typeof app>(app, {
 *   actor: (ctx) => {
 *     const { user } = ctx as Ctx; // the extractor receives `unknown`
 *     return { id: user.id, name: user.name };
 *   },
 *   stream: (action, input, ctx) => `tenant-${ctx.tenant}`,
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
 * See `libs/act-http/README.md` for the full surface walkthrough.
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
import { type Actor, validate } from "@rotorsoft/act";
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
import { type ActSurface, make_dispatch } from "../api/dispatch.js";
import {
  type ActorExtractor,
  resolveSseConfig,
  runSseSubscription,
  SseConnectionCounter,
  type SseOptions,
  toApiError,
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
 *   client's last-known snapshot. Returning `undefined` leaves the
 *   call to the version the action loads; a number pins it, and a
 *   pinned conflict is never retried.
 * - `idempotency` (optional) — when set, the procedure honors
 *   `Idempotency-Key` via the shared
 *   {@link withIdempotency} helper. The host supplies the
 *   `IdempotencyStore` and a `keyFrom` extractor that reads the key
 *   out of the tRPC context (typically a header). A duplicate of a key
 *   that already succeeded throws a `CONFLICT` `TRPCError` — the
 *   receiver-side convention of "ack the duplicate" doesn't carry
 *   over because the contract intentionally does not cache the
 *   original handler's result. A duplicate that arrives while the
 *   original is still running throws a retryable
 *   `SERVICE_UNAVAILABLE` (503) instead: the original may yet fail and
 *   release the key, and a client told "already used" would never retry.
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
 * their conventional tRPC code (`ConcurrencyError` → `PRECONDITION_FAILED`,
 * `StreamClosedError` → `NOT_FOUND`, `ValidationError` →
 * `UNPROCESSABLE_CONTENT`, etc.); unknown throws
 * surface as `INTERNAL_SERVER_ERROR`. Every act-http transport
 * passes through the same {@link toApiError} table,
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
      // StreamClosedError is HTTP 410 Gone. tRPC has no 410 code, so map to
      // NOT_FOUND (404) — its closest "resource is gone" semantics. This is
      // the one unavoidable cross-transport status difference (Hono/OpenAPI
      // keep 410); see auto-generated-api.md.
      return "NOT_FOUND";
    case 412:
      // ConcurrencyError is HTTP 412 Precondition Failed. Map by error
      // identity, not by round-tripping the status: PRECONDITION_FAILED
      // serializes back to 412, matching Hono/OpenAPI.
      return "PRECONDITION_FAILED";
    case 422:
      return "UNPROCESSABLE_CONTENT";
    default:
      return "INTERNAL_SERVER_ERROR";
  }
}

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
 *    {@link withIdempotency} — throws `CONFLICT` on a duplicate of a
 *    committed key, `SERVICE_UNAVAILABLE` on one still in flight.
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
export function trpc<
  Ctx extends object = object,
  TApp extends ActSurface = ActSurface,
>(app: TApp, options: TrpcOptions<Ctx>): GeneratedRouter<TApp> {
  const t = initTRPC.context<Ctx>().create();
  const dispatch = make_dispatch<Ctx>(app, options, options.idempotency?.store);

  // Resolve the actor inline per mutation instead of via
  // `t.procedure.use(authenticated(...))`. The middleware path threads
  // tRPC's internal `Unwrap` type into each procedure's inferred shape,
  // which the d.ts emitter can't name portably (`unstable-core-do-not-
  // import` has a hashed file name that varies per build). Inlining
  // sidesteps the issue entirely — the standalone `authenticated`
  // export still works for hosts who want middleware composition.
  /**
   * Run the actor extractor for a generated procedure, mapping a
   * "throw to deny" onto `UNAUTHORIZED` rather than a framework 500.
   *
   * Shared by mutations and subscriptions, so a denied caller gets
   * neither a mutation nor a live subscription.
   */
  const resolve_actor = async (host_ctx: Ctx): Promise<Actor> => {
    try {
      return await options.actor(host_ctx);
    } catch (err) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: err instanceof Error ? err.message : undefined,
        cause: err instanceof Error ? err : undefined,
      });
    }
  };

  const handlers: Record<
    string,
    ReturnType<ReturnType<typeof t.procedure.input>["mutation"]>
  > = {};
  for (const [action_name, state] of Object.entries(app.registry.actions)) {
    const action_schema = state.actions[action_name];
    handlers[action_name] = t.procedure
      // Passthrough parser: tRPC's own `.input()` validation is deliberately
      // bypassed because a Zod failure there surfaces as a hardcoded
      // BAD_REQUEST (400) that never reaches `to_trpc_error`. Validation runs
      // in the resolver (below) instead, so a malformed body maps to the SAME
      // 422 / ApiError a `ValidationError` thrown inside `app.do` produces,
      // as Hono and OpenAPI do.
      .input((raw: unknown) => raw)
      .mutation(async ({ input, ctx }) => {
        const host_ctx = ctx as unknown as Ctx;
        // Resolve the actor first, mirroring Hono's `authenticated` middleware:
        // a "throw to deny" from the extractor is 401 UNAUTHORIZED, not a 500.
        // The actor step is auth — distinct from a framework error inside
        // `app.do`, which the main try below maps via `to_trpc_error`.
        const actor: Actor = await resolve_actor(host_ctx);
        try {
          // Validate the payload before the stream / expectedVersion resolvers
          // see it, mirroring Hono's zValidator-then-handler order. `validate`
          // throws the framework `ValidationError`, which `to_trpc_error` maps
          // to 422 / UNPROCESSABLE_CONTENT with the shared ApiError envelope.
          // The resolvers get the parsed value, but `app.do` gets the
          // raw `input`: it parses again itself, and a second parse of the
          // output would run every `.transform()` twice.
          const validated = validate(
            action_name,
            input as never,
            action_schema as never
          );
          const outcome = await dispatch(
            action_name,
            validated,
            input,
            host_ctx,
            actor,
            () => options.idempotency?.keyFrom(host_ctx)
          );
          if (outcome.kind === "done") return outcome.result;
          throw new TRPCError(
            outcome.kind === "missing-key"
              ? { code: "BAD_REQUEST", message: "Idempotency-Key required" }
              : outcome.kind === "in-flight"
                ? {
                    code: "SERVICE_UNAVAILABLE",
                    message:
                      "Idempotency-Key in flight; the original request has not finished, retry later",
                  }
                : {
                    code: "CONFLICT",
                    message:
                      "Idempotency-Key already used; original result not cached",
                  }
          );
        } catch (err) {
          if (err instanceof TRPCError) throw err;
          throw to_trpc_error(err);
        }
      });
  }

  if (options.sse) {
    // SSE subscriptions mount under the `subscribe` key of the same router
    // as the action mutations, so an action named `subscribe` would be
    // silently replaced. Refuse it at generation instead.
    if ("subscribe" in app.registry.actions)
      throw new Error(
        'trpc: an action named "subscribe" collides with the SSE subscription router (router.subscribe.<stateName>); rename the action or generate the router without `sse`.'
      );
    const sse_config = resolveSseConfig(options.sse);
    const sse_counter = new SseConnectionCounter(sse_config.maxConnections);
    const state_names = new Set(
      Object.values(app.registry.actions).map((a) => a.name)
    );
    const sse_handlers: Record<string, unknown> = {};
    for (const state_name of state_names) {
      sse_handlers[state_name] = t.procedure
        .input(z.object({ stream: z.string().min(1) }))
        .subscription(async function* ({ input, ctx, signal }) {
          // Step 1 of the documented subscription contract: the actor
          // extractor runs before a slot is taken or a frame is yielded,
          // so a denying extractor denies the open. Hono gets this from
          // the `authenticated` middleware it mounts across `/api/*`;
          // this generator is where the same rule lives for tRPC, which
          // resolves the actor inline rather than through middleware.
          await resolve_actor(ctx as unknown as Ctx);
          yield* runSseSubscription(
            sse_config.channel,
            input.stream,
            sse_counter,
            signal,
            {
              maxPending: sse_config.maxPendingPerConnection,
              on_cap_exceeded: () => {
                throw new TRPCError({
                  code: "TOO_MANY_REQUESTS",
                  message: "max concurrent SSE subscriptions reached",
                });
              },
            }
          );
        });
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
