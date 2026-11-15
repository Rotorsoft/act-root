/** The checks `.on(...)` and `.emit(...)` run on an action's chain. */
import type { ActionBuilder } from "./builders.js";
import type {
  Actor,
  Emitted,
  Precondition,
  Schema,
  Schemas,
  Snapshot,
  State,
  Target,
} from "./index.js";

// The `.emit` step, and what it checks on a handler's return value. TypeScript
// doesn't check extra properties on a callback's return, so these do.

/** What a handler may return: one event, a list of them, or nothing. */
export type EmitOut<TEvents extends Schemas> =
  | Emitted<TEvents>
  | readonly Emitted<TEvents>[]
  | undefined;

export type NoOwnEvent = "an action must append an event to its own stream";

/**
 * Data with any field its schema doesn't declare typed `never`, at any depth.
 * A field the schema leaves open (`z.unknown()`, `z.any()`) takes anything.
 */
export type Exact<TData, TSchema> = unknown extends TSchema
  ? TData
  : Same<TData, TSchema> extends true
    ? TData
    : Fields<TData, TSchema>;

/** Whether two types are identical, so a recursive type stops here. */
export type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

export type Fields<TData, TSchema> = TSchema extends unknown
  ? TData extends readonly unknown[]
    ? TSchema extends readonly unknown[]
      ? {
          [I in keyof TData]: Exact<
            TData[I],
            I extends keyof TSchema ? TSchema[I] : TSchema[number]
          >;
        }
      : never
    : TData extends object
      ? TSchema extends object
        ? {
            [K in keyof TData]: K extends keyof TSchema
              ? Exact<TData[K], TSchema[K]>
              : never;
          }
        : never
      : TData
  : never;

export type ExactEvent<TEvent, TAll> = TEvent extends readonly [
  infer TName extends keyof TAll,
  infer TData,
]
  ? readonly [TName, Exact<TData, TAll[TName]>]
  : TEvent;

/**
 * A handler's return, with extra fields and a missing own event made into
 * errors. Event names only known at runtime (`string`) can't be checked here.
 */
export type CheckEmitted<TOut, TOwn, TAll> = string extends keyof TAll
  ? TOut
  : TOut extends readonly [PropertyKey, unknown]
    ? TOut[0] extends keyof TOwn
      ? ExactEvent<TOut, TAll>
      : NoOwnEvent
    : TOut extends readonly [unknown, ...unknown[]]
      ? [Extract<TOut[number], readonly [keyof TOwn, unknown]>] extends [never]
        ? NoOwnEvent
        : { [I in keyof TOut]: ExactEvent<TOut[I], TAll> }
      : TOut extends readonly []
        ? TOut
        : TOut extends readonly (infer TEvent)[]
          ? [Extract<TEvent, readonly [keyof TOwn, unknown]>] extends [never]
            ? NoOwnEvent
            : readonly ExactEvent<TEvent, TAll>[]
          : TOut;

/**
 * The events `.emit("Event")` can name: the payload becomes the event's data,
 * so the fields they share have to satisfy the event's schema. A wider payload
 * is fine, since the schema strips what it doesn't declare. An event with no
 * named fields (`z.object({})`) can't be told apart from a record, so it's
 * left to the schema at runtime.
 */
export type PassThrough<TEvents extends Schemas, TAction, TRouted> = {
  [E in Exclude<
    keyof TEvents & string,
    keyof TRouted
  >]: string extends keyof TEvents[E]
    ? E
    : Readonly<TAction> extends Readonly<TEvents[E]>
      ? E
      : string extends keyof TAction
        ? never
        : Readonly<
              Pick<TAction, keyof TAction & keyof TEvents[E]>
            > extends Readonly<TEvents[E]>
          ? E
          : never;
}[Exclude<keyof TEvents & string, keyof TRouted>];

/** A handler whose returned events are checked. */
export type EmitHandler<
  TState extends Schema,
  TEvents extends Schemas,
  TAction extends Schema,
  TLoaded extends Record<string, Schema | undefined>,
  TRouted extends Schemas,
  TOut,
> = (
  action: Readonly<TAction>,
  snapshot: Readonly<Snapshot<TState, TEvents>>,
  target: Target,
  loaded: Readonly<TLoaded>
) => CheckEmitted<
  TOut,
  // A listed event goes to the loaded stream, even when this state declares it.
  Omit<TEvents, keyof TRouted>,
  TEvents & TRouted
>;

/**
 * `.emit`, finishing an action and returning `TDone`.
 *
 * The order of these four is load-bearing, so don't merge the duplicates. The
 * first handler gives a function with no parameters its types: TypeScript fixes
 * its return type on the first signature it meets. The name in between keeps
 * `.emit("Event")`. When more than three signatures fail, TypeScript reports
 * only the last one's error, at its exact place, so a mistake in a handler's
 * list is marked on the entry. `emit-types.spec.ts` guards that, but CI runs it
 * on TS 7 only, where three of the four also pass: dropping one still fails on
 * TS 6 and older.
 */
export type Emit<
  TState extends Schema,
  TEvents extends Schemas,
  TAction extends Schema,
  TLoaded extends Record<string, Schema | undefined>,
  TRouted extends Schemas,
  TDone,
> = {
  /**
   * Finishes the action with a handler, which receives `(action, snapshot,
   * target, loaded)` and returns one or more `[EventName, data]` tuples (or
   * `undefined`): the state's own events, and the events listed on its loads.
   */
  <const TOut extends EmitOut<TEvents & TRouted>>(
    handler: EmitHandler<TState, TEvents, TAction, TLoaded, TRouted, TOut>
  ): TDone;
  /**
   * Finishes the action by passing the payload through as the data of an event
   * declared in `.emits()` that no load lists and the payload can satisfy.
   */
  (event_name: PassThrough<TEvents, TAction, TRouted>): TDone;
  (event_name: PassThrough<TEvents, TAction, TRouted>): TDone;
  <const TOut extends EmitOut<TEvents & TRouted>>(
    handler: EmitHandler<TState, TEvents, TAction, TLoaded, TRouted, TOut>
  ): TDone;
};

/** The `.emit(...)` step that finishes an action declaration. */
export type ActionEmit<
  TState extends Schema,
  TEvents extends Schemas,
  TActions extends Schemas,
  TName extends string,
  TSnap extends boolean,
  TKey extends string,
  TNewActions extends Schema,
  TLoaded extends Record<string, Schema | undefined> = {},
  TRouted extends Schemas = {},
> = Emit<
  TState,
  TEvents,
  TNewActions,
  TLoaded,
  TRouted,
  ActionBuilder<
    TState,
    TEvents,
    TActions & { [P in TKey]: TNewActions },
    TName,
    TSnap
  >
>;

/**
 * What `.loads(...)` returns when its load name is already taken by an
 * earlier load of the action: no further step, so the chain fails to
 * compile. Name the loads (the fourth argument) to load a state twice.
 */
export type DuplicateLoad<TAs extends string> = {
  readonly error: `the action already loads "${TAs}"; name each load of the same state`;
};

/** A name only known at runtime can't be compared, so it's never a duplicate. */
export type IsDuplicate<TAs extends string, TLoaded> = string extends TAs
  ? false
  : string extends keyof TLoaded
    ? false
    : TAs extends keyof TLoaded
      ? true
      : false;

/**
 * What follows `.on(...)`: the loads, the preconditions, then the
 * `.emit(...)` that finishes the action.
 */
export type ActionRules<
  TState extends Schema,
  TEvents extends Schemas,
  TActions extends Schemas,
  TName extends string,
  TSnap extends boolean,
  TKey extends string,
  TNewActions extends Schema,
  TLoaded extends Record<string, Schema | undefined> = {},
  TRouted extends Schemas = {},
> = {
  /**
   * Loads another state the decision needs, exactly as `app.load` would,
   * and lists the events of that state the action may emit to its stream.
   * It can repeat, once per stream.
   *
   * The preconditions and `.emit` get every loaded state in a fourth
   * argument, `loaded`, keyed by the state's name or by the load's `name`.
   * An event listed on a load goes to that load's stream, and the action
   * appends to every stream it emits to in one atomic commit, each guarded
   * by the version it had when loaded. A load without events is a read:
   * nothing is appended to its stream, and it isn't guarded.
   *
   * A target that can return `undefined` makes the load optional: when it does,
   * nothing is loaded, `loaded` holds `undefined` for it (and is typed so), and
   * `.emit`'s events listed on it are dropped.
   *
   * @param state - The state to load; it must be registered in the same Act.
   * @param target - The stream to load, from the payload and the action's state; `undefined` skips the load.
   * @param events - The loaded state's events the action may emit to that stream.
   * @param name - The key of this load in `loaded`; needed to load one state twice.
   *
   * @example
   * ```typescript
   * .on({ Enroll })
   * .loads(Seats, (data) => `course-${data.course}`, ["SeatTaken"])
   * .requires([{ description: "a free seat", holds: (_, __, ___, { Seats }) => Seats.taken < Seats.capacity }])
   * .emit((data) => [["Enrolled", data], ["SeatTaken", { student: data.student }]])
   * ```
   */
  loads: <
    TLState extends Schema,
    TLEvents extends Schemas,
    TLName extends string,
    const TList extends Exclude<keyof TLEvents & string, keyof TRouted> = never,
    const TAs extends string = TLName,
    TStream extends string | undefined = string,
  >(
    state: State<TLState, TLEvents, any, TLName> &
      (IsDuplicate<TAs, TLoaded> extends true ? DuplicateLoad<TAs> : unknown),
    target: (
      payload: Readonly<TNewActions>,
      state: Readonly<TState>
    ) => TStream,
    events?: readonly TList[],
    name?: TAs
  ) => IsDuplicate<TAs, TLoaded> extends true
    ? DuplicateLoad<TAs>
    : ActionRules<
        TState,
        TEvents,
        TActions,
        TName,
        TSnap,
        TKey,
        TNewActions,
        TLoaded & {
          [P in TAs]: undefined extends TStream ? TLState | undefined : TLState;
        },
        TRouted & { [E in TList]: TLEvents[E] }
      >;
  /**
   * Adds named preconditions the action requires: what the state, the
   * actor, the payload and the loaded states must meet for the action to
   * run now.
   *
   * They're checked in declaration order, before the handler runs. Each
   * pairs a `description` with a `holds(payload, state, actor, loaded)`
   * predicate; the first that returns `false` refuses the action with
   * `PreconditionError` carrying its description. A rule that ignores the
   * payload (typed `Precondition<S, unknown>`) fits every action, so
   * declare it once and reuse it.
   *
   * @param rules - Array of {@link Precondition} objects (`{ description, holds }`)
   * @returns An object with `.emit()` to finalize the action
   *
   * @example
   * ```typescript
   * .requires([
   *   { description: "Must be active", holds: (_, s) => s.status === "active" },
   *   { description: "Must own the territory", holds: (p, s, actor) => s.owners[p.from] === actor?.id },
   * ])
   * ```
   */
  requires: <TRuleActor extends Actor = Actor>(
    rules: readonly Precondition<TState, TNewActions, TRuleActor, TLoaded>[]
  ) => {
    /**
     * Defines the action handler that emits events, as `.emit()` after
     * `.on()` does: a handler returning the events to emit (none is fine),
     * or an event name to pass the payload through as the event data.
     */
    emit: ActionEmit<
      TState,
      TEvents,
      TActions,
      TName,
      TSnap,
      TKey,
      TNewActions,
      TLoaded,
      TRouted
    >;
  };
  /**
   * Defines the action handler that emits events.
   *
   * The handler receives the action payload, the current state snapshot,
   * the target and the loaded states, and returns the events to emit, or
   * nothing (`undefined` or `[]`) to commit nothing. Events are applied to
   * state via the patch handlers defined earlier.
   *
   * Pass a string event name for passthrough: the action payload becomes
   * the event data directly.
   *
   * @param handler - Function that returns events to emit, or event name string for passthrough
   * @returns The ActionBuilder for chaining more actions
   *
   * @example Custom handler
   * ```typescript
   * .emit((action, snapshot) => {
   *   const newBalance = snapshot.state.balance + action.amount;
   *   return ["Deposited", { amount: action.amount, newBalance }];
   * })
   * ```
   */
  emit: ActionEmit<
    TState,
    TEvents,
    TActions,
    TName,
    TSnap,
    TKey,
    TNewActions,
    TLoaded,
    TRouted
  >;
};
