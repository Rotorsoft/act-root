import type { ZodType, z } from "zod";
import type {
  Actor,
  Committed,
  CommittedMeta,
  Schema,
  Schemas,
  State,
} from "./action.js";
import type { Reaction } from "./reaction.js";

/**
 * @packageDocumentation
 * @module act/types
 * @category Types
 * Types for event and action registries in the Act Framework.
 */

/**
 * Per-event registration: the event's schema plus every reaction
 * registered against it. Keyed by reaction name within the inner map so
 * a single event can fan out to multiple handlers (one per slice or
 * top-level `act().on(...)` call).
 *
 * @template TEvents - Event schemas in the domain
 * @template TKey    - Specific event name within `TEvents`
 */
export type ReactionsRegister<
  TEvents extends Schemas,
  TKey extends keyof TEvents,
> = {
  schema: ZodType<TEvents[TKey]>;
  reactions: Map<string, Reaction<TEvents, TKey>>;
};

/**
 * Maps event names to their schema and registered reactions.
 * @template TEvents - Event schemas.
 */
export type EventRegister<TEvents extends Schemas> = {
  [TKey in keyof TEvents]: ReactionsRegister<TEvents, TKey>;
};

/**
 * Type-level constraint: every key in the action map must point at a
 * Zod schema. Used as a constraint on the registry's action half so
 * downstream types can `infer` payloads safely.
 *
 * @template TSchemaReg - Schema register for actions
 */
export type SchemaRegister<TSchemaReg> = {
  [TKey in keyof TSchemaReg]: Schema;
};

/**
 * Registry of all actions and events for a domain.
 * @template TSchemaReg - State schemas.
 * @template TEvents - Event schemas.
 * @template TActions - Action schemas.
 * @template TStateNames - Union of registered state name literals. Threaded
 *   by `Act` from the builder's `TStateMap` so the per-state lookup
 *   methods narrow `state_name` to the actual set of registered states
 *   instead of accepting any `string`. Defaults to `string` so loose
 *   references like `Registry<any, any, any>` keep working.
 * @property actions - Map of action names to state definitions.
 * @property events - Map of event names to event registration info.
 * @property sensitive_fields - Lookup of `sensitive(...)`-marked fields per
 *   event name. Derived once at build time. Returns the empty array for
 *   unknown events.
 * @property query_gate - Prebuilt per-event read gate for the actor-less read
 *   surfaces (`query` / `query_array`). Every event resolves to a gate: a
 *   non-sensitive event returns the shared identity gate (the event is handed
 *   back untouched, zero allocation); a sensitive event returns a redactor
 *   built once at build time that closes over the field list and applies
 *   default-deny (`[REDACTED]`, or `[SHREDDED]` once the pii column is
 *   forgotten) while dropping the isolated `pii` sidecar. The gate is prebuilt
 *   so the read path never recomputes the sensitive-field lookup per event —
 *   only the sensitive events pay any cost.
 * @property disclosure_predicate - Lookup of the `.discloses(predicate)`
 *   declaration per state name. Returns `null` when no predicate was set
 *   (framework default-deny).
 * @property deprecated_events - Lookup of deprecated event names per state
 *   name. Derived from the `_v<digits>` versioning convention at build
 *   time: for each state, every event whose base name has a
 *   higher-numbered sibling is "deprecated." Returns an empty set for
 *   states with no deprecation in scope. The framework surfaces
 *   deprecations once at build time (static `.emit("X")` targeting a
 *   deprecated name throws; a single startup advisory enumerates every
 *   legacy event in scope) — there is intentionally no runtime warn on
 *   dynamic emits, so the build-time advisory is the only channel.
 *   Exposed here for callers that want to layer their own warning
 *   policy on top.
 */
export type Registry<
  TSchemaReg extends SchemaRegister<TActions>,
  TEvents extends Schemas,
  TActions extends Schemas,
  TStateNames extends string = string,
> = {
  readonly actions: {
    [TKey in keyof TActions]: State<TSchemaReg[TKey], TEvents, TActions>;
  };
  readonly events: EventRegister<TEvents>;
  readonly sensitive_fields: (event_name: string) => readonly string[];
  readonly query_gate: (
    event_name: string
  ) => (
    event: Committed<TEvents, keyof TEvents>
  ) => Committed<TEvents, keyof TEvents>;
  readonly disclosure_predicate: (
    state_name: TStateNames
  ) =>
    | ((
        event: Committed<TEvents, keyof TEvents & string>,
        actor: Actor
      ) => boolean)
    | null;
  readonly deprecated_events: (state_name: TStateNames) => ReadonlySet<string>;
  /**
   * Lookup of the `.autocloses(predicate)` declaration per state name.
   * Returns `null` when the state opted out of online close — the
   * orchestrator's autoclose cycle skips states with a `null` policy
   * so the per-cycle cost is paid only by opt-in states.
   */
  readonly autoclose_policy: (
    state_name: TStateNames
  ) =>
    | ((
        stream: string,
        head: Committed<TEvents, keyof TEvents & string>,
        count: number
      ) => boolean)
    | null;
  /**
   * Lookup of the `.archives(fn)` declaration per state name. Returns
   * `null` when the state didn't declare an archiver — the cycle
   * truncates without an archive step, matching the default behavior
   * of explicit `app.close({ stream })` calls. Threaded into
   * `CloseTarget.archive` only when present.
   */
  readonly autoclose_archiver: (
    state_name: TStateNames
  ) =>
    | ((
        stream: string,
        head: Committed<TEvents, keyof TEvents & string>
      ) => Promise<void>)
    | null;
};

/**
 * Utility type to convert a registry entry to a committed event type.
 * @template R - Registry map.
 * @template K - Event name.
 */
export type AsCommitted<R, K extends keyof R> = R[K] extends { schema: infer S }
  ? {
      readonly name: K;
      readonly data: z.infer<S>;
    } & CommittedMeta
  : never;

/**
 * Utility type to map commited events from zod schema maps.
 * @template E - Event map.
 * @template K - Event name.
 */
export type CommittedOf<E, K extends keyof E> = E[K] extends z.ZodType
  ? {
      readonly name: K;
      readonly data: z.infer<E[K]>;
    } & CommittedMeta
  : never;
