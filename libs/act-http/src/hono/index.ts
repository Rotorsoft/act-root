/**
 * @packageDocumentation
 * @module act-http/hono
 *
 * Hono subpath of the auto-generated API. Walks the
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
 *   // the extractor receives `unknown`; it is the Hono Context
 *   actor: (c) => ({ id: (c as Context).req.header("x-user-id")!, name: "..." }),
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
import type { Actor } from "@rotorsoft/act";
import type { IdempotencyStore } from "@rotorsoft/act-ops/idempotency";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { MergePath, TypedResponse } from "hono/types";
import type { JSONParsed } from "hono/utils/types";
import {
  type ActionResult,
  type ActionSelection,
  type ActSurface,
  type AddressedActions,
  type AppActions,
  type AppStateNames,
  invalid_stream,
  make_dispatch,
  matches_stream,
  type ResolverArgs,
  type SelectedActions,
  type StreamPatterns,
  selected_actions,
  stream_patterns,
} from "../api/dispatch.js";
import {
  type ActorExtractor,
  type ApiError,
  runSseSubscription,
  type SseOptions,
  toApiError,
} from "../api/index.js";
import { fire_and_forget, SseConnectionCounter } from "../api/sse-counter.js";
import { live_sources, run_live_subscription } from "../api/sse-live.js";
import { SseOptionsSchema } from "../api/sse-options.js";
import { sse_sources } from "../api/sse-settled.js";
import { sse_state_names } from "../api/sse-states.js";

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
 *   aggregates pull from headers, path, or body. Optional when every
 *   state is listed in the generator's `streams`.
 * - `expectedVersion` (optional) — optimistic-concurrency resolver.
 *   Hosts typically read it from an `If-Match` header on the
 *   request, or from the client's last-known snapshot. Returning
 *   `undefined` leaves the call to the version the action loads; a
 *   number pins it, and a pinned conflict is never retried.
 * - `idempotency` (optional) — when set, the route honors
 *   `Idempotency-Key` via {@link withIdempotency}. The host
 *   supplies the `IdempotencyStore`; `keyFrom` defaults to reading
 *   the `Idempotency-Key` header. A duplicate of a key that already
 *   succeeded gets `409 Conflict` — the contract intentionally doesn't
 *   cache the original handler's result. A duplicate that arrives
 *   while the original is still running gets a retryable
 *   `503` + `Retry-After` instead, because the original may yet fail
 *   and release the key, and a client told "already used" would never
 *   retry.
 * - `basePath` (optional, default `"/api"`) — Hono basePath the
 *   routes mount under.
 */
export type HonoOptions<TApp = ActSurface> = {
  readonly actor: ActorExtractor<Context>;
  readonly stream?: (
    ...args: ResolverArgs<TApp, Context>
  ) => string | Promise<string>;
  readonly expectedVersion?: (
    ...args: ResolverArgs<TApp, Context>
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
 * the shared {@link ApiError} envelope. Mounted on a route
 * (`api.get("/me", authenticated(extract), handler)`), the `401` is in
 * the route's type, so `hc` and `testClient` see it.
 */
export function authenticated(
  extractor: ActorExtractor<Context>
): MiddlewareHandler<
  { Variables: ActMiddlewareVariables },
  string,
  {},
  Response & TypedResponse<JSONParsed<ApiError>, 401, "json">
> {
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
 *    {@link withIdempotency} — responds `409` on a duplicate of a
 *    committed key, `503` on a duplicate of one still in flight.
 * 6. Calls
 *    `app.do(name, { stream, actor, expectedVersion? }, input)`.
 * 7. Maps any thrown framework error onto the shared
 *    {@link ApiError} envelope via {@link toApiError}, returning
 *    the conventional HTTP status (`409` / `412` for concurrency,
 *    `422` for validation, `400` for non-retryable, etc.).
 *
 * Pass `actions: { include: [...] }` or `{ exclude: [...] }`, typed against
 * the app's action names, to generate routes for some actions only. An
 * action left out has no route and no key in the route types, so `hc`
 * can't call it: leave out the ones a hand-written route owns, so each
 * action has one entry point. A name the app doesn't register fails at
 * generation.
 *
 * @param app A built `Act` orchestrator.
 * @param options Auth, stream, expected-version, idempotency, base-path
 *   and (optional) actions-to-generate seams.
 * @returns A Hono app covering every generated action under
 *   `<basePath>/actions/<name>`.
 */
export function hono<
  TApp extends ActSurface = ActSurface,
  TBase extends string = "/api",
  const TSelection extends ActionSelection<TApp> | undefined =
    | ActionSelection<TApp>
    | undefined,
  TStreams extends StreamPatterns<TApp> = {},
  const TSse extends SseOptions = SseOptions,
>(
  app: TApp,
  options: HonoOptions<TApp> & {
    readonly basePath?: TBase;
    readonly actions?: TSelection;
    readonly streams?: StreamPatterns<TApp> & TStreams;
    readonly sse: TSse;
  }
): Hono<
  { Variables: ActMiddlewareVariables },
  ActionRoutes<TApp, TBase, SelectedActions<TApp, TSelection>, TStreams> &
    SseRoutes<TApp, TBase, TSse>,
  TBase
>;
export function hono<
  TApp extends ActSurface = ActSurface,
  TBase extends string = "/api",
  const TSelection extends ActionSelection<TApp> | undefined =
    | ActionSelection<TApp>
    | undefined,
  TStreams extends StreamPatterns<TApp> = {},
>(
  app: TApp,
  options: HonoOptions<TApp> & {
    readonly basePath?: TBase;
    readonly actions?: TSelection;
    readonly streams?: StreamPatterns<TApp> & TStreams;
  }
): Hono<
  { Variables: ActMiddlewareVariables },
  ActionRoutes<TApp, TBase, SelectedActions<TApp, TSelection>, TStreams>,
  TBase
>;
export function hono<TApp extends ActSurface>(
  app: TApp,
  options: HonoOptions & {
    readonly actions?: ActionSelection<unknown>;
    readonly streams?: StreamPatterns<unknown>;
  }
): unknown {
  const base_path = options.basePath ?? "/api";
  const api = new Hono<{ Variables: ActMiddlewareVariables }>().basePath(
    base_path
  );
  api.use("*", authenticated(options.actor));

  const key_from = options.idempotency?.keyFrom ?? default_key_from;
  const dispatch = make_dispatch<Context>(
    app,
    options,
    options.idempotency?.store
  );
  const patterns = stream_patterns(
    app,
    options.streams,
    !!options.stream,
    "hono"
  );

  // Wire SSE subscriptions before the mutation routes so the
  // `/sse/*` paths sit alongside `/actions/*`. The cap counter is
  // shared by every state-name's GET route on this generator
  // instance so a noisy room on one state doesn't get a free pass
  // on another.
  if (options.sse) {
    const sse_config = {
      channel: options.sse.channel,
      ...SseOptionsSchema.parse(options.sse),
    };
    const sse_counter = new SseConnectionCounter(
      sse_config.maxConnections,
      options.sse.onConnections
    );
    const state_names = sse_state_names(app, "hono");
    const settled_source = sse_sources(app, sse_config, "hono");
    // One event stream: take a slot (503 when the cap is full, before any
    // header is written), keep the connection alive with a heartbeat, write
    // each frame, and free the slot when the client goes away.
    const serve = (
      c: Context,
      frames: (signal: AbortSignal) => AsyncIterable<{
        readonly kind: string;
        readonly data: unknown;
      }>
    ) => {
      if (!sse_counter.acquire()) {
        c.header("Retry-After", "1");
        const body: ApiError = {
          error: "ServiceUnavailable",
          detail: "max concurrent SSE connections reached",
          code: "SSE_BUSY",
        };
        return c.json(body, 503);
      }
      const controller = new AbortController();
      return streamSSE(c, async (sse_stream) => {
        sse_stream.onAbort(() => controller.abort());
        const heartbeat = setInterval(() => {
          fire_and_forget(() =>
            sse_stream.writeSSE({ event: "ping", data: "" })
          );
        }, sse_config.heartbeatMs);
        try {
          for await (const frame of frames(controller.signal))
            await sse_stream.writeSSE({
              event: frame.kind,
              data: JSON.stringify(frame.data),
            });
        } finally {
          clearInterval(heartbeat);
          sse_counter.release();
        }
      });
    };
    if (sse_config.settled)
      api.get("/sse/$settled", (c) =>
        serve(c, (signal) =>
          // A `$live` that follows no stream yields only the settled frames.
          run_live_subscription(
            sse_config.channel,
            [],
            settled_source,
            undefined,
            signal,
            { maxPending: sse_config.maxPendingPerConnection }
          )
        )
      );
    if (sse_config.live) {
      const served = new Set(state_names);
      const live_patterns = options.streams ?? {};
      // `?<State>=<stream>` once per stream, and `settled=1` for the targets.
      // Other query keys are ignored, as REST APIs do: a cache-buster or a
      // tracking parameter must not refuse the open.
      api.get("/sse/$live", (c) => {
        const { settled, ...query } = c.req.queries();
        const streams = Object.fromEntries(
          Object.entries(query).filter(([key]) => served.has(key))
        );
        const want_settled = settled?.[0] === "1" || settled?.[0] === "true";
        const checked = live_sources(
          { streams, settled: want_settled },
          served,
          live_patterns,
          sse_config.maxStreamsPerSubscription
        );
        if ("refused" in checked)
          return c.json(invalid_stream(checked.refused).body, 422);
        return serve(c, async function* (signal) {
          for await (const frame of run_live_subscription(
            sse_config.channel,
            checked.sources,
            want_settled ? settled_source : undefined,
            undefined,
            signal,
            { maxPending: sse_config.maxPendingPerConnection }
          ))
            yield frame.kind === "settled"
              ? frame
              : {
                  kind: frame.kind,
                  data: {
                    state: frame.state,
                    stream: frame.stream,
                    data: frame.data,
                  },
                };
        });
      });
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
        // A caller-addressed state's stream must match its pattern here too.
        if (!matches_stream(options.streams?.[state_name], stream_id))
          return c.json(
            invalid_stream(`"${stream_id}" is not a stream of ${state_name}`)
              .body,
            422
          );
        // `serve` holds the slot, so the shared loop runs without accounting.
        return serve(c, (signal) =>
          runSseSubscription(sse_config.channel, stream_id, undefined, signal, {
            maxPending: sse_config.maxPendingPerConnection,
          })
        );
      });
    }
  }

  for (const [action_name, state] of selected_actions(
    app,
    options.actions,
    "hono"
  )) {
    const schema = state.actions[action_name];
    // A caller-addressed action names its stream in the path.
    const matches = patterns.get(action_name);
    api.post(
      matches ? `/actions/${action_name}/:stream` : `/actions/${action_name}`,
      // Custom hook funnels body-schema failures through the same
      // ApiError envelope + 422 status an in-`do` ValidationError maps
      // to (ERROR_MAP.ValidationError). Without it, @hono/zod-validator
      // short-circuits with its own 400 + raw body — two statuses and
      // two shapes for the same "malformed input" failure class on one
      // endpoint. The OpenAPI doc only documents the 422/ApiError path.
      // A JSON body that doesn't parse gets the same envelope: the
      // validator would throw its own plain-text 400 before the hook runs.
      async (c, next) => {
        if (is_json(c.req.header("content-type")))
          try {
            await c.req.json();
          } catch {
            return c.json(
              validation_error("Malformed JSON in request body"),
              422
            );
          }
        await next();
      },
      zValidator("json", schema as never, (result, c) => {
        if (!result.success)
          // `result.error` is a ZodError; the schema's `never` typing
          // erases its shape, so read `.message` through a narrow cast.
          return c.json(
            validation_error((result.error as { message?: string }).message),
            422
          );
      }),
      async (c) => {
        try {
          // The resolvers get the validated value; `app.do` gets the raw
          // body, because it parses again itself and a second parse of the
          // validator's output would run every `.transform()` twice. The
          // json validator only reads a JSON body (no or non-JSON
          // Content-Type validates `{}`), so take the raw value from the same
          // place it did: re-reading the body regardless would throw on an
          // empty request and hand `app.do` a body the resolvers never saw.
          // Hono caches the body, so reading it again is free.
          const input = c.req.valid("json" as never) as unknown;
          const raw: unknown = is_json(c.req.header("content-type"))
            ? await c.req.json()
            : {};
          const outcome = await dispatch(
            action_name,
            input,
            raw,
            c,
            c.get("actor"),
            () => key_from(c),
            matches && { stream: c.req.param("stream"), matches }
          );
          if (outcome.kind === "done") return c.json(outcome.result);
          if (outcome.status === 503) c.header("Retry-After", "1");
          return c.json(outcome.body, outcome.status);
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

  // Built in a loop over the registry, so its type is the overloads'.
  return api;
}

/**
 * One `GET <basePath>/sse/<state>?stream=<id>` per state of `TApp`, with
 * `sse`: an event stream on `200`, {@link ApiError} on an error status.
 */
export type SseRoutes<TApp, TBase extends string, TSse = unknown> = {
  [N in AppStateNames<TApp> as MergePath<TBase, `/sse/${N}`>]: {
    $get:
      | {
          input: { query: { stream: string } };
          output: {};
          outputFormat: "body";
          status: 200;
        }
      | {
          input: { query: { stream: string } };
          output: ApiError;
          outputFormat: "json";
          status: 400 | 401 | 503;
        };
  };
} & (TSse extends { readonly settled: true }
  ? {
      [P in MergePath<TBase, "/sse/$settled">]: {
        $get:
          | { input: {}; output: {}; outputFormat: "body"; status: 200 }
          | {
              input: {};
              output: ApiError;
              outputFormat: "json";
              status: 401 | 503;
            };
      };
    }
  : {}) &
  (TSse extends { readonly live: true }
    ? {
        [P in MergePath<TBase, "/sse/$live">]: {
          $get:
            | {
                input: { query: LiveQuery<TApp> };
                output: {};
                outputFormat: "body";
                status: 200;
              }
            | {
                input: { query: LiveQuery<TApp> };
                output: ApiError;
                outputFormat: "json";
                status: 401 | 422 | 503;
              };
        };
      }
    : {});

/** A `$live` request's query: streams by state name, and `settled: "1"` for the targets. */
export type LiveQuery<TApp> = {
  [N in AppStateNames<TApp>]?: string | string[];
} & { settled?: "1" | "true" };

/** Every status a generated action route answers with the error envelope. */
type ErrorStatus = 400 | 401 | 409 | 410 | 412 | 422 | 500 | 503;

/**
 * The routes {@link hono} builds, one `POST <basePath>/actions/<name>` per
 * action of `TApp`: the action's payload as the JSON body, the snapshots
 * `app.do` returns (as JSON) on `200`, and {@link ApiError} on an error
 * status. `hc<typeof api>` and `testClient(api)` read it.
 */
export type ActionRoutes<
  TApp,
  TBase extends string,
  TNames extends string = keyof AppActions<TApp> & string,
  TStreams = {},
> = {
  [K in TNames as MergePath<
    TBase,
    K extends AddressedActions<TApp, TStreams>
      ? `/actions/${K}/:stream`
      : `/actions/${K}`
  >]: {
    $post:
      | {
          input: ActionRequest<TApp, TStreams, K>;
          output: JSONParsed<ActionResult<TApp, K>>;
          outputFormat: "json";
          status: 200;
        }
      | {
          input: ActionRequest<TApp, TStreams, K>;
          output: ApiError;
          outputFormat: "json";
          status: ErrorStatus;
        };
  };
};

/** A route's request: the body, and the stream in the path when the caller names it. */
type ActionRequest<TApp, TStreams, K> =
  K extends AddressedActions<TApp, TStreams>
    ? { json: AppActions<TApp>[K]; param: { stream: string } }
    : { json: AppActions<TApp>[K & keyof AppActions<TApp>] };

/**
 * Hono's json validator reads the body only for a JSON Content-Type
 * (`application/json`, or a `+json` suffix, optionally with parameters);
 * anything else validates `{}`. Same test, so the route reads the raw body
 * exactly when the validator did.
 */
const JSON_CONTENT_TYPE =
  /^application\/([a-z-.]+\+)?json(;\s*[a-zA-Z0-9-]+=([^;]+))*$/i;
function validation_error(detail: string | undefined): ApiError {
  return { error: "ValidationError", detail, code: "VALIDATION" };
}

function is_json(content_type: string | undefined): boolean {
  return !!content_type && JSON_CONTENT_TYPE.test(content_type);
}
