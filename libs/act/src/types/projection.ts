/** Public contracts of `projection()`. */
import type { ZodType } from "zod";
import type {
  BatchHandler,
  CacheEntry,
  Committed,
  EventRegister,
  FoldOptions,
  ReactionResolver,
  Schema,
  Schemas,
  State,
} from "./index.js";

/**
 * A self-contained projection grouping read-model update handlers.
 * Projections are composed into an Act orchestrator via `act().withProjection(projection)`.
 *
 * @template TEvents - Event schemas handled by this projection
 */
export type Projection<TEvents extends Schemas> = {
  readonly _tag: "Projection";
  readonly events: EventRegister<TEvents>;
  readonly target?: string;
  readonly batchHandler?: BatchHandler<TEvents>;
  /**
   * State-fold spec from `.of()`. The builder only records intent — the
   * orchestrator resolves the REGISTRY-MERGED full state at
   * `act().build()` and synthesizes the batch handler there, so the
   * fold always covers every reducer of the state, including partials
   * merged by slices the projection never saw.
   * @internal
   */
  readonly fold?: {
    readonly name: string;
    readonly flush: (rows: ReadonlyArray<CacheEntry<any>>) => Promise<void>;
    readonly config: Required<FoldOptions>;
  };
};

/**
 * The `.of()` continuation: state projections flush the cache layer
 * outward — the rows ARE the streams' {@link CacheEntry} values, one
 * per dirty stream per flush round. Must be an idempotent upsert keyed
 * on `stream` (guard with `event_id` for order safety when a rebuild
 * races a live worker).
 */
type FoldFlush<TState extends Schema, TE extends Schemas> = {
  flush: (
    handler: (rows: ReadonlyArray<CacheEntry<TState>>) => Promise<void>
  ) => {
    build: () => Projection<TE>;
  };
};

/**
 * `.of()` accepts the partials of ONE state (same name, enforced at the
 * type level via `TName`) purely for typing and event registration —
 * the fold itself always runs on the registry-merged full state,
 * resolved at `act().build()`. Passing every partial is required: the
 * orchestrator validates completeness at build and throws on missing
 * events.
 */
type OfSignatures = {
  <
    TS1 extends Schema,
    TE1 extends Schemas,
    TA1 extends Schemas,
    TN extends string,
  >(
    s1: State<TS1, TE1, TA1, TN>,
    options?: FoldOptions
  ): FoldFlush<TS1, TE1>;
  <
    TS1 extends Schema,
    TE1 extends Schemas,
    TA1 extends Schemas,
    TS2 extends Schema,
    TE2 extends Schemas,
    TA2 extends Schemas,
    TN extends string,
  >(
    s1: State<TS1, TE1, TA1, TN>,
    s2: State<TS2, TE2, TA2, TN>,
    options?: FoldOptions
  ): FoldFlush<TS1 & TS2, TE1 & TE2>;
  <
    TS1 extends Schema,
    TE1 extends Schemas,
    TA1 extends Schemas,
    TS2 extends Schema,
    TE2 extends Schemas,
    TA2 extends Schemas,
    TS3 extends Schema,
    TE3 extends Schemas,
    TA3 extends Schemas,
    TN extends string,
  >(
    s1: State<TS1, TE1, TA1, TN>,
    s2: State<TS2, TE2, TA2, TN>,
    s3: State<TS3, TE3, TA3, TN>,
    options?: FoldOptions
  ): FoldFlush<TS1 & TS2 & TS3, TE1 & TE2 & TE3>;
  <
    TS1 extends Schema,
    TE1 extends Schemas,
    TA1 extends Schemas,
    TS2 extends Schema,
    TE2 extends Schemas,
    TA2 extends Schemas,
    TS3 extends Schema,
    TE3 extends Schemas,
    TA3 extends Schemas,
    TS4 extends Schema,
    TE4 extends Schemas,
    TA4 extends Schemas,
    TN extends string,
  >(
    s1: State<TS1, TE1, TA1, TN>,
    s2: State<TS2, TE2, TA2, TN>,
    s3: State<TS3, TE3, TA3, TN>,
    s4: State<TS4, TE4, TA4, TN>,
    options?: FoldOptions
  ): FoldFlush<TS1 & TS2 & TS3 & TS4, TE1 & TE2 & TE3 & TE4>;
};

/** Helper: a single-key record mapping an event name to its Zod schema. */
export type EventEntry<
  TKey extends string = string,
  TData extends Schema = Schema,
> = {
  [P in TKey]: ZodType<TData>;
};

/** Infer the handler-result type after registering one event. */
type DoResult<
  TEvents extends Schemas,
  TKey extends string,
  TData extends Schema,
  TTarget extends string | undefined = undefined,
> = ProjectionBuilder<TEvents & { [P in TKey]: TData }, TTarget, true> & {
  to: (
    resolver: ReactionResolver<TEvents & { [P in TKey]: TData }, TKey> | string
  ) => ProjectionBuilder<TEvents & { [P in TKey]: TData }, TTarget, true>;
};

/**
 * Fluent builder interface for composing projections.
 *
 * When a static target is provided via `projection("target")`, the builder
 * exposes a `.batch()` method for registering a batch handler that processes
 * all events in a single call.
 *
 * @template TEvents - Event schemas
 * @template TTarget - Static target string or undefined
 */
export type ProjectionBuilder<
  TEvents extends Schemas,
  TTarget extends string | undefined = undefined,
  THasHandlers extends boolean = false,
> = {
  /**
   * Begins defining a projection handler for a specific event.
   *
   * Pass a `{ EventName: schema }` record — use shorthand `{ EventName }`
   * when the variable name matches the event name. The key becomes the
   * event name, the value the Zod schema.
   */
  on: <TKey extends string, TData extends Schema>(
    entry: EventEntry<TKey, TData>
  ) => {
    do: (
      handler: (
        event: Committed<TEvents & { [P in TKey]: TData }, TKey>,
        stream: string
      ) => Promise<void>
    ) => DoResult<TEvents, TKey, TData, TTarget>;
  };
  /**
   * Builds and returns the Projection data structure.
   */
  build: () => Projection<TEvents>;
  /**
   * The registered event schemas and their reaction maps.
   */
  readonly events: EventRegister<TEvents>;
} & (TTarget extends string
  ? {
      /**
       * Registers a batch handler that processes all events in a single call.
       *
       * Only available on projections with a static target (`projection("target")`).
       * The handler receives a discriminated union of all declared events,
       * enabling bulk DB operations in a single transaction.
       *
       * When defined, the batch handler is always called — even for a single event.
       * Individual `.do()` handlers serve as fallback for projections without `.batch()`.
       */
      batch: (handler: BatchHandler<TEvents>) => {
        build: () => Projection<TEvents>;
      };
    } & (THasHandlers extends false
      ? {
          /**
           * Declares a state projection: fold every event of the given
           * state through its own reducers and flush one row per stream —
           * the queryable list of the aggregates themselves.
           *
           * The state is the filter: the projection consumes exactly the
           * state's event register, so in a multi-state app only that
           * state's streams are folded — and every event of a folded
           * stream reaches the reducer. Write amplification tracks the
           * distinct stream count, not the event count; `app.reset`
           * rebuilds in O(streams) upserts.
           *
           * The fluent chain enforces the shape: `.of()` is only offered
           * before any `.on()` handler, and narrows to `.flush()` +
           * `.build()` — a projection either folds a state or declares
           * handlers, never both.
           */
          of: OfSignatures;
        }
      : {})
  : {});
