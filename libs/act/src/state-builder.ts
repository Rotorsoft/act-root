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
} from "./types";

/* eslint-disable @typescript-eslint/no-empty-object-type */
export type StateBuilder<S extends Schema> = {
  init: (init: () => Readonly<S>) => {
    emits: <E extends Schemas>(
      events: ZodTypes<E>
    ) => {
      patch: (patch: PatchHandlers<S, E>) => ActionBuilder<S, E, {}>;
    };
  };
};

export type ActionBuilder<
  S extends Schema,
  E extends Schemas,
  A extends Schemas,
> = {
  on: <K extends string, AX extends Schema>(
    action: K,
    schema: ZodType<AX>
  ) => {
    given: (rules: Invariant<S>[]) => {
      emit: (
        handler: ActionHandler<S, E, { [P in K]: AX }, K>
      ) => ActionBuilder<S, E, A & { [P in K]: AX }>;
    };
    emit: (
      handler: ActionHandler<S, E, { [P in K]: AX }, K>
    ) => ActionBuilder<S, E, A & { [P in K]: AX }>;
  };
  snap: (snap: (snapshot: Snapshot<S, E>) => boolean) => ActionBuilder<S, E, A>;
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
 * Example usage:
 * ```ts
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
 * ```
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
