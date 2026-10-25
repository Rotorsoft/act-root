/**
 * @module state-builder
 * @category Builders
 *
 * Fluent interface for defining a strongly-typed state machine using Zod schemas.
 */
import type { ZodType } from "zod";
import {
  compile_autoclose_policy,
  policy_keep_days,
  policy_min_after_days,
} from "../internal/autoclose-policy.js";
import { resolveActionConfig } from "../internal/config.js";
import type {
  ActionBuilder,
  ActionEntry,
  StateBuilder,
  StateEntry,
} from "../types/builders.js";
import type {
  ActionHandler,
  ActionOptions,
  Actor,
  AutocloseArchiver,
  AutoclosePolicy,
  AutoclosePredicate,
  Committed,
  Invariant,
  PassthroughPatchHandler,
  PatchHandlers,
  Precondition,
  Schema,
  Schemas,
  Snapshot,
  State,
  ZodTypes,
} from "../types/index.js";

/**
 * Creates a new state definition with event sourcing capabilities.
 *
 * States are the core building blocks of Act. Each state represents a consistency
 * boundary (aggregate) that processes actions, emits events, and maintains its own
 * state through event patches (reducers). States use event sourcing to maintain a
 * complete audit trail and enable time-travel capabilities.
 *
 * The state builder provides a fluent API for defining:
 * 1. Initial state via `.init()`
 * 2. Event types via `.emits()` — all events default to passthrough (`({ data }) => data`)
 * 3. Custom event reducers via `.patch()` (optional — only for events that need custom logic)
 * 4. Actions (commands) via `.on()` → `.emit()` — pass an event name string for passthrough
 * 5. Business rules: invariants via `.given()`, preconditions on the payload via `.requires()`
 * 6. Snapshotting strategy via `.snap()`
 *
 * @template TState - Zod schema type defining the shape of the state
 * @param entry - Single-key record mapping state name to Zod schema (e.g., `{ Counter: z.object({ count: z.number() }) }`)
 * @returns A StateBuilder instance for fluent API configuration
 *
 * @example Basic counter state (with custom patch)
 * ```typescript
 * import { state } from "@rotorsoft/act";
 * import { z } from "zod";
 *
 * const Counter = state({ Counter: z.object({ count: z.number() }) })
 *   .init(() => ({ count: 0 }))
 *   .emits({
 *     Incremented: z.object({ amount: z.number() })
 *   })
 *   .patch({  // optional — only for events needing custom reducers
 *     Incremented: ({ data }, state) => ({ count: state.count + data.amount })
 *   })
 *   .on({ increment: z.object({ by: z.number() }) })
 *     .emit((action) => ["Incremented", { amount: action.by }])
 *   .build();
 * ```
 *
 * @see {@link StateBuilder} for available builder methods
 * @see {@link ActionBuilder} for action configuration methods
 * @see {@link https://rotorsoft.github.io/act-root/docs/intro | Getting Started Guide}
 * @see {@link https://rotorsoft.github.io/act-root/docs/examples/calculator | Calculator Example}
 */
export function state<TName extends string, TState extends Schema>(
  entry: StateEntry<TName, TState>
): StateBuilder<TState, TName> {
  const keys = Object.keys(entry);
  if (keys.length !== 1) throw new Error("state() requires exactly one key");
  const name = keys[0] as TName;
  const state_schema = (entry as Record<string, ZodType<TState>>)[name];
  return {
    init(init) {
      return {
        emits<TEvents extends Schema>(events: ZodTypes<TEvents>) {
          // Default passthrough patches: event data merges into state
          const default_patch = Object.fromEntries(
            Object.keys(events).map((k) => {
              const fn = Object.assign(({ data }: { data: any }) => data, {
                _passthrough: true as const,
              }) satisfies PassthroughPatchHandler;
              return [k, fn];
            })
          ) as unknown as PatchHandlers<TState, TEvents>;

          // Build one mutable state object the action_builder threads
          // through every fluent call. patch() (if invoked) just mutates
          // the patch map in place — no re-builder wasted.
          const internal: State<TState, TEvents, Schemas, TName> = {
            events,
            actions: {},
            state: state_schema,
            name,
            init,
            patch: default_patch,
            on: {},
            // Step delegates initialized as identity, `pii_aware` false.
            // `act().build()` flips both on states with `sensitive(...)`
            // events to bake in the gate / split and gate the cache write.
            pii_aware: false,
            view: (event) => event,
            message: (validated) => validated,
          };

          // `{}` avoids the string index signature `Record<string, never>` would add
          const builder = action_builder<TState, TEvents, {}, TName>(internal);

          return Object.assign(builder, {
            patch(customPatch: Partial<PatchHandlers<TState, TEvents>>) {
              Object.assign(internal.patch, customPatch);
              return builder;
            },
          });
        },
      };
    },
  };
}

/**
 * Internal action-builder. The runtime object is a single mutable bag —
 * each fluent call (`on`, `snap`) mutates it and returns the same builder
 * cast to the widened generic type. Type-level fanout is preserved; the
 * O(N) `{...state}` spreads per call are not.
 *
 * Generics are erased to `Schemas` at runtime — the cast on return narrows
 * back to the call-site's widened types.
 */
function action_builder<
  TState extends Schema,
  TEvents extends Schemas,
  TActions extends Schemas,
  TName extends string = string,
>(
  state: State<TState, TEvents, TActions, TName>
): ActionBuilder<TState, TEvents, TActions, TName> {
  // The mutable bag — typed loosely since callers narrow on return.
  const internal = state as unknown as State<TState, TEvents, Schemas, TName>;

  const builder: ActionBuilder<TState, TEvents, TActions, TName> = {
    on<TKey extends string, TNewActions extends Schema>(
      entry: ActionEntry<TKey, TNewActions>,
      options?: ActionOptions
    ) {
      const keys = Object.keys(entry);
      if (keys.length !== 1) throw new Error(".on() requires exactly one key");
      const action = keys[0] as TKey;
      const schema = entry[action];

      if (action in internal.actions)
        throw new Error(`Duplicate action "${action}"`);

      type MergedActions = TActions & { [P in TKey]: TNewActions };
      (internal.actions as Record<string, ZodType<Schema>>)[action] = schema;
      if (options) {
        // Validate the whole action bag at declaration so a bad
        // `maxRetries`/`backoff` throws ZodError at build, not a NaN gate.
        resolveActionConfig(options);
        internal.options ??= {};
        (internal.options as Record<string, ActionOptions>)[action] = options;
      }

      function given(rules: Invariant<TState>[]) {
        ((internal.given ??= {}) as Record<string, unknown>)[action] = rules;
        return { requires, emit };
      }

      function requires(rules: Precondition<TState, TNewActions>[]) {
        ((internal.requires ??= {}) as Record<string, unknown>)[action] = rules;
        return { emit };
      }

      function emit(
        handler:
          | ActionHandler<TState, TEvents, MergedActions, TKey>
          | (keyof TEvents & string)
      ) {
        if (typeof handler === "string") {
          const event_name = handler;
          // Tag the synthetic function with the static event name so
          // the act-builder can detect emissions of deprecated events
          // at build time. Dynamic forms — where the
          // returned event name is computed inside the user's
          // function — can't be inspected statically; they're caught
          // by the runtime warning in event-sourcing.ts.
          const emit_fn = Object.assign(
            (payload: any) => [event_name, payload],
            {
              _static_emit: event_name,
            }
          );
          (internal.on as Record<string, unknown>)[action] = emit_fn;
        } else {
          (internal.on as Record<string, unknown>)[action] = handler;
        }
        return builder as unknown as ActionBuilder<
          TState,
          TEvents,
          MergedActions,
          TName
        >;
      }

      return { given, requires, emit };
    },

    snap(snap: (snapshot: Snapshot<TState, TEvents>) => boolean) {
      internal.snap = snap;
      // Flip the type-level TSnap flag — same runtime object, the cast
      // unlocks `.autocloses({ keep })` for the rest of the chain.
      return builder as unknown as ActionBuilder<
        TState,
        TEvents,
        TActions,
        TName,
        true
      >;
    },

    discloses(
      disclose: (
        event: Committed<TEvents, keyof TEvents & string>,
        actor: Actor
      ) => boolean
    ) {
      // Replace on every call — matches snap's state-level semantics. Operators
      // who need per-event differences branch inside the predicate.
      internal.disclose = disclose;
      return builder;
    },

    autocloses(policy: AutoclosePolicy) {
      // Declarative policy only. The online path is a synthesized
      // reaction that defers to a derivable due-time and closes — an opaque
      // function predicate has no terminal event to react to nor a window to
      // derive, so it's no longer accepted online. Operators who need custom
      // logic call `app.close(...)` from their own reaction.
      if (typeof policy === "function") {
        throw new Error(
          ".autocloses(fn) is no longer supported — pass a declarative policy " +
            "({ after, is, reaches, or }) or call app.close(...) from your own " +
            "reaction for custom logic."
        );
      }
      if (policy === null || typeof policy !== "object") {
        throw new Error(
          ".autocloses(...) requires a policy object; got " + typeof policy
        );
      }
      // The type gate (`TSnap`) already rejects `keep` before `.snap` at
      // compile time; this is the equivalent guard for untyped callers.
      if ((policy as AutoclosePolicy).keep && !internal.snap) {
        throw new Error(
          ".autocloses({ keep }) requires .snap(...) earlier in the chain — a rolling window prunes behind a real snapshot, so a state that never snapshots has nothing to prune behind."
        );
      }
      // Replace on every call — matches snap / discloses state-level
      // semantics. Compile to the predicate the reaction evaluates, and
      // cache the policy's min `after` window so the reaction knows whether
      // to park on a due-time or wait for the next event; `keep` resolves
      // to the rolling-window width the reaction prunes against.
      internal.autoclose = compile_autoclose_policy(
        policy
      ) as AutoclosePredicate<TEvents>;
      internal.autoclose_after_days = policy_min_after_days(policy);
      internal.autoclose_keep_days = policy_keep_days(policy);
      return builder;
    },

    archives(archive: AutocloseArchiver<TEvents>) {
      if (typeof archive !== "function") {
        throw new Error(
          ".archives(archive) requires a function; got " + typeof archive
        );
      }
      internal.archive = archive;
      return builder;
    },

    build(): State<TState, TEvents, TActions, TName> {
      return internal as unknown as State<TState, TEvents, TActions, TName>;
    },
  };
  return builder;
}
