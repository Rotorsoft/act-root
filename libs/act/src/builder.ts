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
  StateFactory,
} from "./types";

// resolves to the event stream (default)
const _this_ = ({ stream }: { stream: string }) => stream;
// resolves to nothing
const _void_ = () => undefined;

export type Builder<
  E extends Schemas,
  A extends Schemas,
  S extends SchemaRegister<A>,
> = {
  with: <EX extends Schemas, AX extends Schemas, SX extends Schema>(
    factory: StateFactory<EX, AX, SX>
  ) => Builder<E & EX, A & AX, S & { [K in keyof AX]: SX }>;
  on: <K extends keyof E>(
    event: K
  ) => {
    do: (
      handler: ReactionHandler<E, K>,
      options?: Partial<ReactionOptions>
    ) => Builder<E, A, S> & {
      to: (resolver: ReactionResolver<E, K>) => Builder<E, A, S>;
      void: () => Builder<E, A, S>;
    };
  };
  build: (drainLimit?: number) => Act<E, A, S>;
  readonly events: EventRegister<E>;
};

/* eslint-disable @typescript-eslint/no-empty-object-type */
export function act<
  E extends Schemas = {},
  A extends Schemas = {},
  // @ts-expect-error empty schema
  S extends SchemaRegister<A> = {},
>(
  factories: Set<string> = new Set(),
  registry: Registry<E, A, S> = {
    actions: {} as any,
    events: {} as any,
  }
): Builder<E, A, S> {
  const builder: Builder<E, A, S> = {
    with: <EX extends Schemas, AX extends Schemas, SX extends Schema>(
      factory: StateFactory<EX, AX, SX>
    ) => {
      if (!factories.has(factory.name)) {
        factories.add(factory.name);
        const state = factory();
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
      return act<E & EX, A & AX, S & { [K in keyof AX]: SX }>(
        factories,
        registry as unknown as Registry<
          E & EX,
          A & AX,
          S & { [K in keyof AX]: SX }
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
    build: (drainLimit = 10) => new Act<E, A, S>(registry, drainLimit),
    events: registry.events,
  };
  return builder;
}
