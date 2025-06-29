/**
 * @module state-builder
 * @category Builders
 *
 * Fluent interface for defining a strongly-typed state machine using Zod schemas.
 */
import { ZodType } from "zod/v4";
import {
  ActionHandler,
  ActionHandlers,
  GivenHandlers,
  Invariant,
  PatchHandlers,
  Schema,
  Schemas,
  Snapshot,
  State,
  ZodTypes,
} from "./types/index.js";

/* eslint-disable @typescript-eslint/no-empty-object-type */
export type StateBuilder<S extends Schema> = {
  /**
   * Define the initial state for the state machine.
   * @param init Function returning the initial state
   * @returns An object with .emits() to declare event types
   */
  init: (init: () => Readonly<S>) => {
    /**
     * Declare the event types the state machine can emit.
     * @param events Zod schemas for each event
     * @returns An object with .patch() to define event handlers
     */
    emits: <E extends Schemas>(
      events: ZodTypes<E>
    ) => {
      /**
       * Define how each event updates state.
       * @param patch Event handler functions
       * @returns An ActionBuilder for defining actions
       */
      patch: (patch: PatchHandlers<S, E>) => ActionBuilder<S, E, {}>;
    };
  };
};

export type ActionBuilder<
  S extends Schema,
  E extends Schemas,
  A extends Schemas,
> = {
  /**
   * Define an action for the state machine.
   * @param action The action name
   * @param schema The Zod schema for the action payload
   * @returns An object with .given() and .emit() for further configuration
   */
  on: <K extends string, AX extends Schema>(
    action: K,
    schema: ZodType<AX>
  ) => {
    /**
     * Constrain the action with invariants (business rules).
     * @param rules Array of invariants
     * @returns An object with .emit() to finalize the action
     */
    given: (rules: Invariant<S>[]) => {
      /**
       * Finalize the action by providing the event emission handler.
       * @param handler The action handler function
       * @returns The ActionBuilder for chaining
       */
      emit: (
        handler: ActionHandler<S, E, { [P in K]: AX }, K>
      ) => ActionBuilder<S, E, A & { [P in K]: AX }>;
    };
    /**
     * Finalize the action by providing the event emission handler.
     * @param handler The action handler function
     * @returns The ActionBuilder for chaining
     */
    emit: (
      handler: ActionHandler<S, E, { [P in K]: AX }, K>
    ) => ActionBuilder<S, E, A & { [P in K]: AX }>;
  };
  /**
   * Define a snapshotting strategy to reduce recomputations.
   * @param snap Function that determines when to snapshot
   * @returns The ActionBuilder for chaining
   */
  snap: (snap: (snapshot: Snapshot<S, E>) => boolean) => ActionBuilder<S, E, A>;
  /**
   * Finalize and build the state machine definition.
   * @returns The strongly-typed State definition
   */
  build: () => State<S, E, A>;
};

/**
 * Fluent interface for defining a strongly-typed state machine using Zod schemas.
 *
 * This builder helps you model a system where:
 * - You start by defining the state schema with `state(name, zodSchema)`
 * - Then, provide the initial state using `.init(() => defaultState)`
 * - Declare the event types your system can emit using `.emits({ ... })`
 * - Define how emitted events update state with `.patch({ ... })`
 * - Define actions using `.on("actionName", actionSchema)`
 *     - Optionally constrain the action with `.given([...invariants])`
 *     - Then finalize the action behavior with `.emit(handler)`
 * - (Optional) Define a `.snap(snapshot => boolean)` function to reduce recomputations
 * - Finalize the state machine definition using `.build()`
 *
 * @template S The type of state
 *
 * @example
 * const machine = state("machine", myStateSchema)
 *   .init(() => ({ count: 0 }))
 *   .emits({ Incremented: z.object({ amount: z.number() }) })
 *   .patch({
 *     Incremented: (event, state) => ({ count: state.count + event.amount })
 *   })
 *   .on("increment", z.object({ by: z.number() }))
 *   .given([{ description: "must be positive", valid: (s, a) => a?.by > 0 }])
 *   .emit((action, state) => ({ type: "Incremented", amount: action.by }))
 *   .build();
 */
export function state<S extends Schema>(
  name: string,
  state: ZodType<S>
): StateBuilder<S> {
  return {
    init(init: () => Readonly<S>) {
      return {
        emits<E extends Schema>(events: ZodTypes<E>) {
          return {
            patch(patch: PatchHandlers<S, E>) {
              return action_builder<S, E, {}>({
                events,
                actions: {},
                state,
                name,
                init,
                patch,
                on: {},
              });
            },
          };
        },
      };
    },
  };
}

function action_builder<S extends Schema, E extends Schemas, A extends Schemas>(
  state: State<S, E, A>
): ActionBuilder<S, E, A> {
  return {
    on<K extends string, AX extends Schema>(action: K, schema: ZodType<AX>) {
      if (action in state.actions)
        throw new Error(`Duplicate action "${action}"`);

      type NewA = A & { [P in K]: AX };
      const actions = { ...state.actions, [action]: schema } as ZodTypes<NewA>;
      const on = { ...state.on } as ActionHandlers<S, E, NewA>;
      const _given = { ...state.given } as GivenHandlers<S, NewA>;

      function given(rules: Invariant<S>[]) {
        _given[action] = rules;
        return { emit };
      }

      function emit(handler: ActionHandler<S, E, NewA, K>) {
        on[action] = handler;
        return action_builder<S, E, NewA>({
          ...state,
          actions,
          on,
          given: _given,
        });
      }

      return { given, emit };
    },

    snap(snap: (snapshot: Snapshot<S, E>) => boolean) {
      return action_builder<S, E, A>({ ...state, snap });
    },

    build(): State<S, E, A> {
      return state;
    },
  };
}
