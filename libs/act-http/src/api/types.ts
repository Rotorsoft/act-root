// The types the generated APIs are written in: what an app passes to
// `trpc`, `hono` and `openapi`, and what their routes take and return.
// Types only, so `/api` re-exports the whole file and the stability snapshot
// reads each one.
import type {
  Act,
  Registry,
  Schema,
  Schemas,
  Snapshot,
  Target,
} from "@rotorsoft/act";
import type { ZodType } from "zod";

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
  /**
   * The app's lifecycle events, which `sse.publish` (`committed`) and
   * `sse.settled` and `sse.live` (`acked`) listen to. A built Act has them; a surface
   * without them can't use those options.
   */
  on?(event: "committed" | "acked", listener: (arg: unknown) => void): unknown;
  off?(event: "committed" | "acked", listener: (arg: unknown) => void): unknown;
};

/**
 * The registry types of a built app, read back so a generated API keeps
 * them: each action's payload, the state it leaves, the events, and the
 * state names. A bare {@link ActSurface} has none, so its actions take and
 * return `unknown`.
 */
type AppRegistry<TApp> = TApp extends {
  readonly registry: Registry<infer S, infer E, infer A, infer N, infer O>;
}
  ? { states: S; events: E; actions: A; names: N; owners: O }
  : {
      states: Record<string, Schema>;
      events: Schemas;
      actions: Record<string, unknown>;
      names: string;
      owners: Record<string, string>;
    };

/** The payload each action of `TApp` takes, by action name. */
export type AppActions<TApp> = AppRegistry<TApp>["actions"];

/** The state names of `TApp`. */
export type AppStateNames<TApp> = AppRegistry<TApp>["names"];

/**
 * The states whose streams the caller names, each with the pattern a stream
 * must match: a `RegExp`, or a predicate. Every other state resolves its
 * stream through the generator's `stream` option.
 */
export type StreamPatterns<TApp> = {
  readonly [N in AppStateNames<TApp>]?: RegExp | ((stream: string) => boolean);
};

/** The actions of `TApp` whose state is listed in `P`: the caller sends their stream. */
export type AddressedActions<TApp, P> = {
  [K in keyof AppActions<TApp> & string]: AppRegistry<TApp>["owners"][K &
    keyof AppRegistry<TApp>["owners"]] extends keyof P
    ? K
    : never;
}[keyof AppActions<TApp> & string];

/**
 * What a generated call for action `K` takes: the payload, or, when its
 * state is caller-addressed, the stream and the payload apart, so the
 * payload stays exactly the action's schema.
 */
export type ActionInput<TApp, P, K> =
  K extends AddressedActions<TApp, P>
    ? { stream: string; payload: AppActions<TApp>[K & keyof AppActions<TApp>] }
    : AppActions<TApp>[K & keyof AppActions<TApp>];

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

/** A settled frame: the targets a drain advanced. */
export type SseSettledFrame = {
  readonly kind: "settled";
  readonly data: { readonly targets: string[] };
};
