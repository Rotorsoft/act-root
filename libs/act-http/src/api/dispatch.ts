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
import type { ZodType } from "zod";
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
        /** The state's schema and its events', which the OpenAPI doc describes responses with. */
        readonly state?: ZodType;
        readonly events?: Readonly<Record<string, ZodType>>;
        /** The states its actions load, which appear in no action of their own. */
        readonly loads?: Readonly<
          Record<
            string,
            | readonly {
                readonly state: {
                  readonly name: string;
                  readonly events: Readonly<Record<string, ZodType>>;
                };
              }[]
            | undefined
          >
        >;
      }
    >;
    /** The sensitive fields of an action or event, as a built Act's registry answers. */
    sensitive_fields(name: string): readonly string[];
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

/**
 * Which of `TApp`'s actions a generator emits: exactly the `include`d ones,
 * or every one but the `exclude`d. An action left out gets no route, no
 * OpenAPI operation and no key in the generated type, so the hand-written
 * procedure that owns it is its one entry point.
 */
export type ActionSelection<TApp> =
  | { readonly include: readonly (keyof AppActions<TApp> & string)[] }
  | { readonly exclude: readonly (keyof AppActions<TApp> & string)[] };

/** The action names a selection keeps; every action without one. */
export type SelectedActions<TApp, S> = S extends {
  readonly include: readonly (infer I)[];
}
  ? I & keyof AppActions<TApp> & string
  : S extends { readonly exclude: readonly (infer X)[] }
    ? Exclude<keyof AppActions<TApp> & string, X>
    : keyof AppActions<TApp> & string;

/**
 * The registry's actions a generator emits under `selection`, as
 * `[name, state]` entries. Refuses a selection that names both lists, or an
 * action the registry doesn't have, so a typo can't leave a route mounted.
 */
export function selected_actions(
  app: Pick<ActSurface, "registry">,
  selection: ActionSelection<unknown> | undefined,
  transport: string
): [string, ActSurface["registry"]["actions"][string]][] {
  const entries = Object.entries(app.registry.actions);
  if (!selection) return entries;
  const { include, exclude } = selection as {
    include?: readonly string[];
    exclude?: readonly string[];
  };
  if (include && exclude)
    throw new Error(
      `${transport}: pass \`actions.include\` or \`actions.exclude\`, not both.`
    );
  const names = include ?? exclude ?? [];
  const unknown = names.filter((name) => !(name in app.registry.actions));
  if (unknown.length)
    throw new Error(
      `${transport}: \`actions\` names ${unknown.map((n) => `"${n}"`).join(", ")}, which the app doesn't register.`
    );
  const listed = new Set(names);
  return entries.filter(([name]) => listed.has(name) === !!include);
}

/**
 * What a `stream` or `expectedVersion` resolver receives: the action's
 * name, its parsed payload and the transport's context, as one tuple per
 * action, so checking the name narrows the payload.
 */
export type ResolverArgs<TApp, C> = {
  [K in keyof AppActions<TApp> & string]: [
    action_name: K,
    input: AppActions<TApp>[K],
    ctx: C,
  ];
}[keyof AppActions<TApp> & string];

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
