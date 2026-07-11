/**
 * @packageDocumentation
 * @module act-http/hono
 *
 * Hono subpath for the auto-generated API epic (#835). Walks the
 * registry of a built `Act` once at function call and emits a Hono
 * app with one `POST /actions/<name>` route per registered action,
 * Zod-validated bodies, and the shared error envelope.
 *
 * Usage:
 *
 * ```ts
 * import { hono } from "@rotorsoft/act-http/hono";
 *
 * const api = hono(app, {
 *   actor: (c) => ({ id: c.req.header("x-user-id")!, name: "..." }),
 *   stream: (action, input, c) => `tenant-${c.req.header("x-tenant")}`,
 * });
 *
 * // Mounts at /api by default — pass `basePath` to override.
 * // POST /api/actions/OpenTicket  body: { title }  → 200 Snapshot[] | 4xx ApiError
 * ```
 *
 * The route shape matches the flat tRPC sibling at
 * `@rotorsoft/act-http/trpc`: one endpoint per action, no
 * state-name tier. Action names are unique across the registry —
 * the framework enforces no duplicates — so an extra namespace
 * level would be overhead. Queries live in a follow-up; this
 * slice is mutations only.
 *
 * **Actor lives on the context.** The generator wires an internal
 * middleware that runs the host's
 * {@link HonoOptions.actor | actor extractor} once per call and
 * stashes the resolved {@link Actor} under `c.get("actor")`. Every
 * generated route reads from there — auth resolves at one seam,
 * downstream middleware (logging, tracing) sees the same actor.
 * The middleware factory is also exported as {@link authenticated}
 * for hosts that want to compose it into their own Hono chain
 * alongside hand-written routes.
 *
 * Composes the shared utilities at `@rotorsoft/act-http/api`:
 * {@link ActorExtractor} for the auth seam, {@link toApiError} for
 * the uniform error → status / code mapping, {@link withIdempotency}
 * for `Idempotency-Key` dedup. Three transports (tRPC, this one,
 * OpenAPI) ride the same utilities so a client speaking two of
 * them never sees two shapes for the same framework error.
 */
import { zValidator } from "@hono/zod-validator";
import type { Actor, Target } from "@rotorsoft/act";
import type { IdempotencyStore } from "@rotorsoft/act-ops/idempotency";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  type ActorExtractor,
  type ApiError,
  fireAndForget,
  resolveSseConfig,
  runSseSubscription,
  SseConnectionCounter,
  type SseOptions,
  toApiError,
  withIdempotency,
} from "../api/index.js";

/**
 * Hono context variables this subpath contributes. The generic on
 * the returned middleware threads it through so routes downstream
 * of {@link authenticated} see `c.get("actor")` typed without a
 * manual cast.
 */
export type ActMiddlewareVariables = {
  actor: Actor;
};

/**
 * Per-call options for {@link hono}. The host supplies the four
 * seams the package can't make decisions on:
 *
 * - `actor` — auth resolver. Receives the Hono context, returns the
 *   `Actor` that flows onto `c.get("actor")` for every generated
 *   route (via an internal {@link authenticated}).
 * - `stream` — stream-id resolver. Receives the action name, the
 *   validated body, and the Hono context; returns the target
 *   stream. Singleton aggregates return a constant; per-tenant
 *   aggregates pull from headers, path, or body.
 * - `expectedVersion` (optional) — optimistic-concurrency resolver.
 *   Hosts typically read it from an `If-Match` header on the
 *   request, or from the client's last-known snapshot. Returning
 *   `undefined` skips the check for that call — handy when only
 *   some actions are concurrency-sensitive.
 * - `idempotency` (optional) — when set, the route honors
 *   `Idempotency-Key` via {@link withIdempotency}. The host
 *   supplies the `IdempotencyStore`; `keyFrom` defaults to reading
 *   the `Idempotency-Key` header. On a duplicate claim, the route
 *   responds `409 Conflict` — the contract intentionally doesn't
 *   cache the original handler's result, matching the
 *   receiver-side "ack the duplicate" semantics.
 * - `basePath` (optional, default `"/api"`) — Hono basePath the
 *   routes mount under.
 */
export type HonoOptions = {
  readonly actor: ActorExtractor;
  readonly stream: (
    action_name: string,
    input: unknown,
    c: Context
  ) => string | Promise<string>;
  readonly expectedVersion?: (
    action_name: string,
    input: unknown,
    c: Context
  ) => number | undefined | Promise<number | undefined>;
  readonly idempotency?: {
    readonly store: IdempotencyStore;
    readonly keyFrom?: (c: Context) => string | undefined;
  };
  /**
   * Optional SSE wiring. When set, the generator emits one
   * `GET <basePath>/sse/<stateName>?stream=<streamId>` per unique
   * state name in the registry. The endpoint runs the host
   * {@link actor} extractor, looks up the streamId from
   * `?stream=...`, opens a `text/event-stream`, yields the cached
   * state (if any), and forwards every patch published to the
   * shared {@link SseOptions.channel}. A heartbeat keeps proxies
   * from idling the connection out; the per-process connection cap
   * returns `503 Service Unavailable` (with `Retry-After: 1`) when
   * full so operators never see silent stalls.
   *
   * Off by default — most APIs don't expose live state to every
   * client, and opening one is widening both the auth and cost
   * surface.
   */
  readonly sse?: SseOptions;
  readonly basePath?: string;
};

/**
 * Build a Hono middleware that runs an {@link ActorExtractor} once
 * per call and stashes the resolved {@link Actor} under
 * `c.set("actor", ...)` so downstream routes can read it via
 * `c.get("actor")`. The generator at {@link hono} uses this
 * internally; it's also exported so hosts that want to compose
 * their own route chain (logging, tracing, custom auth flavors)
 * can wire it directly:
 *
 * ```ts
 * import { Hono } from "hono";
 * import { authenticated, type ActMiddlewareVariables } from "@rotorsoft/act-http/hono";
 *
 * const api = new Hono<{ Variables: ActMiddlewareVariables }>();
 * api.use("*", authenticated((c) => resolveUserFromJwt(c)));
 * api.get("/me", (c) => c.json(c.get("actor"))); // typed
 * ```
 *
 * Errors thrown by the extractor surface as `401 Unauthorized` with
 * the shared {@link ApiError} envelope.
 */
export function authenticated(
  extractor: ActorExtractor
): MiddlewareHandler<{ Variables: ActMiddlewareVariables }> {
  return async (c, next) => {
    try {
      const actor = await extractor(c);
      c.set("actor", actor);
      await next();
    } catch (err) {
      const body: ApiError = {
        error: "Unauthorized",
        detail: err instanceof Error ? err.message : undefined,
        code: "UNAUTHORIZED",
      };
      return c.json(body, 401);
    }
  };
}

const default_key_from = (c: Context): string | undefined =>
  c.req.header("idempotency-key");

/**
 * Build a typed Hono REST surface from a built `Act` instance.
 *
 * Walks `app.registry.actions` once and emits one
 * `POST /actions/<actionName>` per action under the configured
 * `basePath` (default `/api`). Each route:
 *
 * 1. Runs the internal {@link authenticated} middleware —
 *    `options.actor` resolves the {@link Actor} once and stashes
 *    it under `c.get("actor")`.
 * 2. Validates the JSON body against the action's Zod schema via
 *    `@hono/zod-validator`. Failures short-circuit with `422`.
 * 3. Resolves the target stream via
 *    `options.stream(name, input, c)`.
 * 4. (Optionally) resolves `expectedVersion` for optimistic
 *    concurrency.
 * 5. (Optionally) claims the `Idempotency-Key` via
 *    {@link withIdempotency} — responds `409` on duplicate.
 * 6. Calls
 *    `app.do(name, { stream, actor, expectedVersion? }, input)`.
 * 7. Maps any thrown framework error onto the shared
 *    {@link ApiError} envelope via {@link toApiError}, returning
 *    the conventional HTTP status (`409` / `412` for concurrency,
 *    `422` for validation, `400` for non-retryable, etc.).
 *
 * @param app A built `Act` orchestrator.
 * @param options Auth, stream, expected-version, idempotency, and
 *   base-path seams.
 * @returns A Hono app covering every registered action under
 *   `<basePath>/actions/<name>`.
 */
/**
 * Structural shape of the Act surface this generator walks at
 * runtime — the registry's action-name → owning-state map plus the
 * `do(...)` dispatch. Letting TApp infer to the caller's concrete
 * `Act<...>` against this structural bound keeps nested variance
 * out of the signature and avoids `any` in either direction.
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

export function hono<TApp extends ActSurface = ActSurface>(
  app: TApp,
  options: HonoOptions
): Hono<{ Variables: ActMiddlewareVariables }> {
  const base_path = options.basePath ?? "/api";
  const api = new Hono<{ Variables: ActMiddlewareVariables }>().basePath(
    base_path
  );
  api.use("*", authenticated(options.actor));

  const key_from = options.idempotency?.keyFrom ?? default_key_from;

  // Wire SSE subscriptions before the mutation routes so the
  // `/sse/*` paths sit alongside `/actions/*`. The cap counter is
  // shared by every state-name's GET route on this generator
  // instance so a noisy room on one state doesn't get a free pass
  // on another.
  if (options.sse) {
    const sse_config = resolveSseConfig(options.sse);
    const sse_counter = new SseConnectionCounter(sse_config.maxConnections);
    const state_names = new Set<string>();
    for (const action of Object.values(app.registry.actions)) {
      state_names.add(action.name);
    }
    for (const state_name of state_names) {
      api.get(`/sse/${state_name}`, async (c) => {
        const stream_id = c.req.query("stream");
        if (!stream_id) {
          const body: ApiError = {
            error: "BadRequest",
            detail: "stream query parameter is required",
            code: "BAD_REQUEST",
          };
          return c.json(body, 400);
        }
        if (!sse_counter.acquire()) {
          c.header("Retry-After", "1");
          const body: ApiError = {
            error: "ServiceUnavailable",
            detail: "max concurrent SSE connections reached",
            code: "SSE_BUSY",
          };
          return c.json(body, 503);
        }
        // The route already acquired the slot above so streamSSE
        // could return `503` before writing headers if the cap was
        // full. The shared loop runs without accounting; the route
        // releases the slot in `finally`.
        const controller = new AbortController();
        return streamSSE(c, async (sse_stream) => {
          sse_stream.onAbort(() => controller.abort());
          const heartbeat = setInterval(() => {
            fireAndForget(() =>
              sse_stream.writeSSE({ event: "ping", data: "" })
            );
          }, sse_config.heartbeatMs);
          try {
            for await (const frame of runSseSubscription(
              sse_config.channel,
              stream_id,
              undefined,
              controller.signal
            )) {
              await sse_stream.writeSSE({
                event: frame.kind,
                data: JSON.stringify(frame.data),
              });
            }
          } finally {
            clearInterval(heartbeat);
            sse_counter.release();
          }
        });
      });
    }
  }

  for (const [action_name, state] of Object.entries(app.registry.actions)) {
    const schema = state.actions[action_name];
    api.post(
      `/actions/${action_name}`,
      // Custom hook funnels body-schema failures through the same
      // ApiError envelope + 422 status an in-`do` ValidationError maps
      // to (ERROR_MAP.ValidationError). Without it, @hono/zod-validator
      // short-circuits with its own 400 + raw body — two statuses and
      // two shapes for the same "malformed input" failure class on one
      // endpoint. The OpenAPI doc only documents the 422/ApiError path.
      zValidator("json", schema as never, (result, c) => {
        if (!result.success) {
          // `result.error` is a ZodError; the schema's `never` typing
          // erases its shape, so read `.message` through a narrow cast.
          const message = (result.error as { message?: string }).message;
          const body: ApiError = {
            error: "ValidationError",
            detail: message,
            code: "VALIDATION",
          };
          return c.json(body, 422);
        }
      }),
      async (c) => {
        try {
          const input = c.req.valid("json" as never) as unknown;
          const actor = c.get("actor");
          const stream = await options.stream(action_name, input, c);
          const expected_version = options.expectedVersion
            ? await options.expectedVersion(action_name, input, c)
            : undefined;
          const target =
            expected_version === undefined
              ? { stream, actor }
              : { stream, actor, expectedVersion: expected_version };

          if (options.idempotency) {
            const key = key_from(c);
            if (!key) {
              const body: ApiError = {
                error: "BadRequest",
                detail: "Idempotency-Key required",
                code: "BAD_REQUEST",
              };
              return c.json(body, 400);
            }
            const outcome = await withIdempotency(
              options.idempotency.store,
              key,
              () =>
                app.do(action_name as never, target as never, input as never)
            );
            if (outcome.deduped) {
              const body: ApiError = {
                error: "Conflict",
                detail:
                  "Idempotency-Key already used; original result not cached",
                code: "CONFLICT",
              };
              return c.json(body, 409);
            }
            return c.json(outcome.result);
          }

          const snapshots = await app.do(
            action_name as never,
            target as never,
            input as never
          );
          return c.json(snapshots);
        } catch (err) {
          const { status, body } = toApiError(err);
          // Hono types narrow `status` to its known status-number union;
          // `toApiError` returns a numeric status from a closed set that
          // matches but TypeScript can't prove it through the union.
          return c.json(body, status as 400 | 409 | 410 | 412 | 422 | 500);
        }
      }
    );
  }

  return api;
}
