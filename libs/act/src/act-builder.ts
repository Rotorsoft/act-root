import { Act } from "./act";
import type {
  EventRegister,
  Reaction,
  ReactionHandler,
  ReactionOptions,
  ReactionResolver,
  Registry,
  Schema,
  SchemaRegister,
  Schemas,
  State,
} from "./types";

// resolves to the event stream (default)
const _this_ = ({ stream }: { stream: string }) => stream;
// resolves to nothing
const _void_ = () => undefined;

export type ActBuilder<
  S extends SchemaRegister<A>,
  E extends Schemas,
  A extends Schemas,
> = {
  with: <SX extends Schema, EX extends Schemas, AX extends Schemas>(
    state: State<SX, EX, AX>
  ) => ActBuilder<S & { [K in keyof AX]: SX }, E & EX, A & AX>;
  on: <K extends keyof E>(
    event: K
  ) => {
    do: (
      handler: ReactionHandler<E, K>,
      options?: Partial<ReactionOptions>
    ) => ActBuilder<S, E, A> & {
      to: (resolver: ReactionResolver<E, K>) => ActBuilder<S, E, A>;
      void: () => ActBuilder<S, E, A>;
    };
  };
  build: (drainLimit?: number) => Act<S, E, A>;
  readonly events: EventRegister<E>;
};

/* eslint-disable @typescript-eslint/no-empty-object-type */
export function act<
  // @ts-expect-error empty schema
  S extends SchemaRegister<A> = {},
  E extends Schemas = {},
  A extends Schemas = {},
>(
  states: Set<string> = new Set(),
  registry: Registry<S, E, A> = {
    actions: {} as any,
    events: {} as any,
  }
): ActBuilder<S, E, A> {
  const builder: ActBuilder<S, E, A> = {
    with: <SX extends Schema, EX extends Schemas, AX extends Schemas>(
      state: State<SX, EX, AX>
    ) => {
      if (!states.has(state.name)) {
        states.add(state.name);
        for (const name of Object.keys(state.actions)) {
          if (registry.actions[name])
            throw new Error(`Duplicate action "${name}"`);
          // @ts-expect-error indexed access
          registry.actions[name] = state;
        }
        for (const name of Object.keys(state.events)) {
          if (registry.events[name])
            throw new Error(`Duplicate event "${name}"`);
          // @ts-expect-error indexed access
          registry.events[name] = {
            schema: state.events[name],
            reactions: new Map(),
          };
        }
      }
      return act<S & { [K in keyof AX]: SX }, E & EX, A & AX>(
        states,
        registry as unknown as Registry<
          S & { [K in keyof AX]: SX },
          E & EX,
          A & AX
        >
      );
    },
    on: <K extends keyof E>(event: K) => ({
      do: (
        handler: ReactionHandler<E, K>,
        options?: Partial<ReactionOptions>
      ) => {
        const reaction: Reaction<E, K> = {
          handler,
          resolver: _this_,
          options: {
            blockOnError: options?.blockOnError ?? true,
            maxRetries: options?.maxRetries ?? 3,
            retryDelayMs: options?.retryDelayMs ?? 1000,
          },
        };
        registry.events[event].reactions.set(handler.name, reaction);
        return {
          ...builder,
          to(resolver: ReactionResolver<E, K>) {
            registry.events[event].reactions.set(handler.name, {
              ...reaction,
              resolver,
            });
            return builder;
          },
          void() {
            registry.events[event].reactions.set(handler.name, {
              ...reaction,
              resolver: _void_,
            });
            return builder;
          },
        };
      },
    }),
    build: (drainLimit = 10) => new Act<S, E, A>(registry, drainLimit),
    events: registry.events,
  };
  return builder;
}
