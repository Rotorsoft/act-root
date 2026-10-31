import type {
  Act,
  Actor,
  Registry,
  Schema,
  Schemas,
  Snapshot,
  Target,
} from "@rotorsoft/act";
import type { IdempotencyStore } from "@rotorsoft/act-ops/idempotency";
import { withIdempotency } from "./idempotency.js";
import { track_in_flight } from "./in-flight.js";

/**
 * The Act surface the generated transports walk: the registry's action
 * name → owning-state map and `do(...)`. A structural bound lets `TApp`
 * infer to the caller's concrete `Act<...>` without leaking the variance of
 * its nested types, and without `any`.
 */
export type ActSurface = {
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
 * The registry types of a built app, read back so a generated API keeps
 * them: each action's payload, the state it leaves, the events, and the
 * state names. A bare {@link ActSurface} has none, so its actions take and
 * return `unknown`.
 */
type AppRegistry<TApp> = TApp extends {
  readonly registry: Registry<infer S, infer E, infer A, infer N>;
}
  ? { states: S; events: E; actions: A; names: N }
  : {
      states: Record<string, Schema>;
      events: Schemas;
      actions: Record<string, unknown>;
      names: string;
    };

/** The payload each action of `TApp` takes, by action name. */
export type AppActions<TApp> = AppRegistry<TApp>["actions"];

/** The state names of `TApp`. */
export type AppStateNames<TApp> = AppRegistry<TApp>["names"];

/** The state named `N` in `TApp`, as the SSE channel carries it. */
export type AppState<TApp, N> = (TApp extends Act<any, any, any, infer M, any>
  ? N extends keyof M
    ? M[N]
    : Schema
  : Schema) & { _v: number };

/** What `app.do` returns for action `K` of `TApp`. */
export type ActionResult<TApp, K> = Snapshot<
  K extends keyof AppRegistry<TApp>["states"]
    ? AppRegistry<TApp>["states"][K]
    : Schema,
  AppRegistry<TApp>["events"]
>[];

/** The target resolvers a generated transport takes, over its own context. */
type TargetResolvers<C> = {
  readonly stream: (
    action_name: string,
    input: unknown,
    ctx: C
  ) => string | Promise<string>;
  readonly expectedVersion?: (
    action_name: string,
    input: unknown,
    ctx: C
  ) => number | undefined | Promise<number | undefined>;
};

/** What one generated action call came to; each transport maps the refusals. */
export type Dispatched =
  | { kind: "done"; result: unknown }
  | { kind: "missing-key" }
  | { kind: "in-flight" }
  | { kind: "conflict" };

/**
 * One generated action call: resolve the target from the validated input,
 * then run `app.do` on the raw payload (it parses again itself, and a second
 * parse of the parsed value would run every `.transform()` twice), under
 * `Idempotency-Key` dedup when a store is set. A duplicate of a key still
 * running is `in-flight`, since the original may yet fail and release it;
 * one already committed is `conflict`.
 */
export function make_dispatch<C>(
  app: ActSurface,
  resolvers: TargetResolvers<C>,
  store: IdempotencyStore | undefined
) {
  // Counts claims per key, to tell the two kinds of duplicate apart.
  const tracker = store && track_in_flight(store);
  return async (
    action_name: string,
    input: unknown,
    payload: unknown,
    ctx: C,
    actor: Actor,
    key: () => string | undefined
  ): Promise<Dispatched> => {
    const stream = await resolvers.stream(action_name, input, ctx);
    const expected = await resolvers.expectedVersion?.(action_name, input, ctx);
    const target =
      expected === undefined
        ? { stream, actor }
        : { stream, actor, expectedVersion: expected };
    const run = () => app.do(action_name, target, payload);
    if (!tracker) return { kind: "done", result: await run() };
    const k = key();
    if (!k) return { kind: "missing-key" };
    const outcome = await withIdempotency(tracker.store, k, run);
    if (!outcome.deduped) return { kind: "done", result: outcome.result };
    return { kind: tracker.in_flight(k) ? "in-flight" : "conflict" };
  };
}
