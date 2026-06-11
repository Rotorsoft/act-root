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
import type { Act, Actor, Schema, Schemas } from "@rotorsoft/act";
import type { IdempotencyStore } from "@rotorsoft/act-ops/idempotency";
import { initTRPC, TRPCError } from "@trpc/server";
import {
  type ActorExtractor,
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
// biome-ignore lint/suspicious/noExplicitAny: tRPC's internal middleware shape lives behind `unstable-core-do-not-import`; structural typing carries the host's `t` validation.
export function authenticated(extractor: ActorExtractor): any {
  return async function actor_middleware({
    ctx,
    next,
  }: {
    ctx: object;
    next: (opts: { ctx: object }) => Promise<unknown>;
  }) {
    const actor = await extractor(ctx);
    return next({ ctx: { ...ctx, actor } });
  };
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
export function trpc<Ctx extends object = object>(
  // biome-ignore lint/suspicious/noExplicitAny: erased — the generator walks the registry at runtime, not the typed surface
  app: Act<any, Schemas, Schemas, Record<string, Schema>>,
  options: TrpcOptions<Ctx>
) {
  const t = initTRPC.context<Ctx>().create();
  const authed = t.procedure.use(authenticated(options.actor));

  const handlers: Record<string, ReturnType<typeof authed.mutation>> = {};
  for (const [action_name, state] of Object.entries(app.registry.actions)) {
    handlers[action_name] = authed
      .input(state.actions[action_name] as never)
      .mutation(async ({ input, ctx }) => {
        // tRPC's internal `Simplify<Ctx>` transform produces a type
        // that's structurally identical to `Ctx & { actor }` but not
        // assignable to the generic parameter. The cast restores the
        // link; the runtime ctx IS the augmented context.
        const host_ctx = ctx as unknown as Ctx & { actor: Actor };
        try {
          const stream = await options.stream(action_name, input, host_ctx);
          const expected_version = options.expectedVersion
            ? await options.expectedVersion(action_name, input, host_ctx)
            : undefined;
          const target =
            expected_version === undefined
              ? { stream, actor: host_ctx.actor }
              : {
                  stream,
                  actor: host_ctx.actor,
                  expectedVersion: expected_version,
                };

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

  return t.router(handlers as never);
}
