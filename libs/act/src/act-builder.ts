/**
 * @module act-builder
 * @category Builders
 *
 * Fluent builder for composing event-sourced applications.
 */
import { Act } from "./act.js";
import { _this_, _void_, mergeProjection, registerState } from "./merge.js";
import type { Projection } from "./projection-builder.js";
import type { Slice } from "./slice-builder.js";
import type {
  Actor,
  Committed,
  Dispatcher,
  EventRegister,
  Reaction,
  ReactionHandler,
  ReactionOptions,
  ReactionResolver,
  Registry,
  Schema,
  SchemaRegister,
  Schemas,
  Snapshot,
  State,
} from "./types/index.js";

/**
 * Fluent builder interface for composing event-sourced applications.
 *
 * Provides a chainable API for:
 * - Registering states via `.withState()`
 * - Registering slices via `.withSlice()`
 * - Registering projections via `.withProjection()`
 * - Locking a custom actor type via `.withActor<TActor>()`
 * - Defining event reactions via `.on()` → `.do()` → `.to()` or `.void()`
 * - Building the orchestrator via `.build()`
 *
 * @template TSchemaReg - Schema register for states (maps action names to state schemas)
 * @template TEvents - Event schemas (maps event names to event data schemas)
 * @template TActions - Action schemas (maps action names to action payload schemas)
 * @template TStateMap - Map of state names to state schemas
 * @template TActor - Actor type extending base Actor
 *
 * @see {@link act} for usage examples
 * @see {@link Act} for the built orchestrator API
 */
export type ActBuilder<
  TSchemaReg extends SchemaRegister<TActions>,
  TEvents extends Schemas,
  TActions extends Schemas,
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  TStateMap extends Record<string, Schema> = {},
  TActor extends Actor = Actor,
> = {
  /**
   * Registers a state definition with the builder.
   *
   * State names, action names, and event names must be unique across the
   * application (partial states with the same name are merged automatically).
   *
   * @throws {Error} If duplicate action or event names are detected
   */
  withState: <
    TNewState extends Schema,
    TNewEvents extends Schemas,
    TNewActions extends Schemas,
    TNewName extends string = string,
  >(
    state: State<TNewState, TNewEvents, TNewActions, TNewName>
  ) => ActBuilder<
    TSchemaReg & { [K in keyof TNewActions]: TNewState },
    TEvents & TNewEvents,
    TActions & TNewActions,
    TStateMap & { [K in TNewName]: TNewState },
    TActor
  >;
  /**
   * Registers a slice with the builder.
   *
   * Merges all the slice's states and reactions into the application.
   * State names, action names, and event names must be unique across the
   * application (partial states with the same name are merged automatically).
   *
   * @throws {Error} If duplicate action or event names are detected
   */
  withSlice: <
    TNewSchemaReg extends SchemaRegister<TNewActions>,
    TNewEvents extends Schemas,
    TNewActions extends Schemas,
    TNewMap extends Record<string, Schema>,
  >(
    slice: Slice<TNewSchemaReg, TNewEvents, TNewActions, TNewMap>
  ) => ActBuilder<
    TSchemaReg & TNewSchemaReg,
    TEvents & TNewEvents,
    TActions & TNewActions,
    TStateMap & TNewMap,
    TActor
  >;
  /**
   * Registers a standalone projection with the builder.
   *
   * The projection's events must be a subset of events already registered
   * via `.withState()` or `.withSlice()`.
   */
  withProjection: <TNewEvents extends Schemas>(
    projection: [Exclude<keyof TNewEvents, keyof TEvents>] extends [never]
      ? Projection<TNewEvents>
      : never
  ) => ActBuilder<TSchemaReg, TEvents, TActions, TStateMap, TActor>;
  /**
   * Locks a custom actor type for this application.
   *
   * This is a pure type-level method — it returns the same builder at
   * runtime but narrows the `TActor` generic so that `app.do()` and
   * reaction dispatchers require the richer actor shape.
   *
   * @template TNewActor - Custom actor type extending base Actor
   * @returns The same builder with `TActor` locked to `TNewActor`
   *
   * @example
   * ```typescript
   * type MyActor = { id: string; name: string; role: string; tenantId: string };
   *
   * const app = act()
   *   .withActor<MyActor>()
   *   .withState(Counter)
   *   .build();
   *
   * // Now app.do() requires MyActor in the target
   * await app.do("increment", {
   *   stream: "counter-1",
   *   actor: { id: "1", name: "Alice", role: "admin", tenantId: "t1" }
   * }, { by: 5 });
   * ```
   */
  withActor: <TNewActor extends Actor>() => ActBuilder<
    TSchemaReg,
    TEvents,
    TActions,
    TStateMap,
    TNewActor
  >;
  /**
   * Begins defining a reaction to a specific event.
   *
   * Reactions are event handlers that respond to state changes. They can trigger
   * additional actions, update external systems, or perform side effects. Reactions
   * are processed asynchronously during drain cycles.
   *
   * @template TKey - Event name (must be a registered event)
   * @param event - The event name to react to
   * @returns An object with `.do()` method to define the reaction handler
   */
  on: <TKey extends keyof TEvents>(
    event: TKey
  ) => {
    do: (
      handler: (
        event: Committed<TEvents, TKey>,
        stream: string,
        app: Dispatcher<TActions, TActor>
      ) => Promise<Snapshot<Schema, TEvents> | void>,
      options?: Partial<ReactionOptions>
    ) => ActBuilder<TSchemaReg, TEvents, TActions, TStateMap, TActor> & {
      to: (
        resolver: ReactionResolver<TEvents, TKey> | string
      ) => ActBuilder<TSchemaReg, TEvents, TActions, TStateMap, TActor>;
      void: () => ActBuilder<TSchemaReg, TEvents, TActions, TStateMap, TActor>;
    };
  };
  /**
   * Builds and returns the Act orchestrator instance.
   *
   * @param drainLimit - Deprecated parameter, no longer used
   * @returns The Act orchestrator instance
   *
   * @see {@link Act} for available orchestrator methods
   */
  build: (
    drainLimit?: number
  ) => Act<TSchemaReg, TEvents, TActions, TStateMap, TActor>;
  /**
   * The registered event schemas and their reaction maps.
   */
  readonly events: EventRegister<TEvents>;
};

/* eslint-disable @typescript-eslint/no-empty-object-type -- {} used as generic defaults */

/**
 * Creates a new Act orchestrator builder for composing event-sourced applications.
 *
 * @example Basic application with single state
 * ```typescript
 * const app = act()
 *   .withState(Counter)
 *   .build();
 * ```
 *
 * @example Application with custom actor type
 * ```typescript
 * type MyActor = { id: string; name: string; role: string };
 *
 * const app = act()
 *   .withActor<MyActor>()
 *   .withState(Counter)
 *   .build();
 * ```
 *
 * @example Application with slices (vertical slice architecture)
 * ```typescript
 * const CounterSlice = slice()
 *   .withState(Counter)
 *   .on("Incremented")
 *     .do(async (event) => { console.log("incremented!"); })
 *     .void()
 *   .build();
 *
 * const app = act()
 *   .withSlice(CounterSlice)
 *   .build();
 * ```
 *
 * @see {@link ActBuilder} for available builder methods
 * @see {@link Act} for orchestrator API methods
 * @see {@link state} for defining states
 * @see {@link slice} for defining slices
 */
export function act<
  // @ts-expect-error empty schema
  TSchemaReg extends SchemaRegister<TActions> = {},
  TEvents extends Schemas = {},
  TActions extends Schemas = {},
  TStateMap extends Record<string, Schema> = {},
  TActor extends Actor = Actor,
>(
  states: Map<string, State<any, any, any>> = new Map(),
  registry: Registry<TSchemaReg, TEvents, TActions> = {
    actions: {} as Registry<TSchemaReg, TEvents, TActions>["actions"],
    events: {} as Registry<TSchemaReg, TEvents, TActions>["events"],
  },
  pendingProjections: Projection<any>[] = []
): ActBuilder<TSchemaReg, TEvents, TActions, TStateMap, TActor> {
  const builder: ActBuilder<TSchemaReg, TEvents, TActions, TStateMap, TActor> =
    {
      withState: <
        TNewState extends Schema,
        TNewEvents extends Schemas,
        TNewActions extends Schemas,
        TNewName extends string = string,
      >(
        state: State<TNewState, TNewEvents, TNewActions, TNewName>
      ) => {
        registerState(state, states, registry.actions, registry.events);
        return act<
          TSchemaReg & { [K in keyof TNewActions]: TNewState },
          TEvents & TNewEvents,
          TActions & TNewActions,
          TStateMap & { [K in TNewName]: TNewState },
          TActor
        >(
          states,
          registry as unknown as Registry<
            TSchemaReg & { [K in keyof TNewActions]: TNewState },
            TEvents & TNewEvents,
            TActions & TNewActions
          >,
          pendingProjections
        );
      },
      withSlice: <
        TNewSchemaReg extends SchemaRegister<TNewActions>,
        TNewEvents extends Schemas,
        TNewActions extends Schemas,
        TNewMap extends Record<string, Schema>,
      >(
        input: Slice<TNewSchemaReg, TNewEvents, TNewActions, TNewMap>
      ) => {
        for (const s of input.states.values()) {
          registerState(s, states, registry.actions, registry.events);
        }
        for (const eventName of Object.keys(input.events)) {
          const sliceRegister = input.events[eventName];
          for (const [name, reaction] of sliceRegister.reactions) {
            (
              registry.events as Record<
                string,
                { reactions: Map<string, unknown> }
              >
            )[eventName].reactions.set(name, reaction);
          }
        }
        pendingProjections.push(...input.projections);
        return act<
          TSchemaReg & TNewSchemaReg,
          TEvents & TNewEvents,
          TActions & TNewActions,
          TStateMap & TNewMap,
          TActor
        >(
          states,
          registry as unknown as Registry<
            TSchemaReg & TNewSchemaReg,
            TEvents & TNewEvents,
            TActions & TNewActions
          >,
          pendingProjections
        );
      },
      withProjection: <TNewEvents extends Schemas>(
        proj: Projection<TNewEvents>
      ) => {
        mergeProjection(proj, registry.events);
        return act<TSchemaReg, TEvents, TActions, TStateMap, TActor>(
          states,
          registry,
          pendingProjections
        );
      },
      withActor: <TNewActor extends Actor>() => {
        return act<TSchemaReg, TEvents, TActions, TStateMap, TNewActor>(
          states,
          registry,
          pendingProjections
        );
      },
      on: <TKey extends keyof TEvents>(event: TKey) => ({
        do: (
          handler: (
            event: Committed<TEvents, TKey>,
            stream: string,
            app: Dispatcher<TActions, TActor>
          ) => Promise<Snapshot<Schema, TEvents> | void>,
          options?: Partial<ReactionOptions>
        ) => {
          const reaction: Reaction<TEvents, TKey, TActions, TActor> = {
            handler: handler as ReactionHandler<
              TEvents,
              TKey,
              TActions,
              TActor
            >,
            resolver: _this_,
            options: {
              blockOnError: options?.blockOnError ?? true,
              maxRetries: options?.maxRetries ?? 3,
            },
          };
          const name =
            handler.name ||
            `${String(event)}_${registry.events[event].reactions.size}`;
          registry.events[event].reactions.set(name, reaction);
          return {
            ...builder,
            to(resolver: ReactionResolver<TEvents, TKey> | string) {
              registry.events[event].reactions.set(name, {
                ...reaction,
                resolver:
                  typeof resolver === "string"
                    ? { target: resolver }
                    : resolver,
              });
              return builder;
            },
            void() {
              registry.events[event].reactions.set(name, {
                ...reaction,
                resolver: _void_,
              });
              return builder;
            },
          };
        },
      }),
      build: () => {
        for (const proj of pendingProjections) {
          mergeProjection(proj, registry.events as Record<string, any>);
        }
        return new Act<TSchemaReg, TEvents, TActions, TStateMap, TActor>(
          registry,
          states
        );
      },
      events: registry.events,
    };
  return builder;
}
