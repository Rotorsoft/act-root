/**
 * @packageDocumentation
 * @module act/types
 * @category Types
 * Types for reactions, leases, and fetch results in the Act Framework.
 */
import type {
  Actor,
  BackoffOptions,
  Committed,
  IAct,
  Query,
  Schema,
  Schemas,
  Snapshot,
} from "./action.js";

/**
 * Reaction handler function that processes committed events.
 *
 * Reaction handlers respond to events asynchronously. They can:
 * - Perform side effects (send emails, call APIs, log, etc.)
 * - Return an action tuple to trigger another action
 * - Return `void` or `undefined` for side-effect-only reactions
 *
 * Handlers are called during drain cycles and support automatic retries
 * with configurable error handling.
 *
 * @template TEvents - Event schemas
 * @template TKey - Event name
 * @template TActions - Action schemas (defaults to Schemas for stored reactions)
 * @template TActor - Actor type extending base Actor
 * @param event - The committed event that triggered this reaction
 * @param stream - The target stream name for this reaction
 * @returns Promise resolving to an action tuple or void
 *
 * @example Side effect only
 * ```typescript
 * const sendEmail: ReactionHandler<Events, "UserCreated"> = async (event) => {
 *   await emailService.send(event.data.email, "Welcome!");
 * };
 * ```
 *
 * @example Triggering another action
 * ```typescript
 * const reduceInventory: ReactionHandler<Events, "OrderPlaced"> = async (event) => {
 *   return ["reduceStock", { amount: event.data.items.length }];
 * };
 * ```
 *
 * @see {@link Reaction} for complete reaction configuration
 */
export type ReactionHandler<
  TEvents extends Schemas,
  TKey extends keyof TEvents,
  TActions extends Schemas = Schemas,
  TActor extends Actor = Actor,
> = (
  event: Committed<TEvents, TKey>,
  stream: string,
  app: IAct<TEvents, TActions, TActor>
) => Promise<Snapshot<Schema, TEvents> | void>;

/**
 * Resolver for determining which stream a reaction should target.
 *
 * Resolvers enable dynamic reaction routing based on event content. They can be:
 * - **Static**: Always route to the same target stream
 * - **Dynamic**: Determine target based on event data at runtime
 *
 * Resolvers can also specify source streams for optimization, allowing the drain
 * process to efficiently fetch only relevant events. An optional `priority`
 * biases the lagging-frontier `claim()` ordering — see {@link Resolved.priority}.
 *
 * @template TEvents - Event schemas
 * @template TKey - Event name
 * @param event - The committed event (for dynamic resolvers)
 * @returns Target stream configuration or undefined to skip
 *
 * @example Static target
 * ```typescript
 * .on("UserCreated")
 *   .do(sendWelcomeEmail)
 *   .to("email-queue") // Static target
 * ```
 *
 * @example Dynamic target per user
 * ```typescript
 * .on("UserLoggedIn")
 *   .do(incrementLoginCount)
 *   .to((event) => ({
 *     target: `stats-${event.stream}` // Dynamic per user
 *   }))
 * ```
 *
 * @example With source optimization
 * ```typescript
 * .on("UserUpdated")
 *   .do(updateReadModel)
 *   .to(({ stream }) => ({
 *     source: stream,           // Only fetch from this user's stream
 *     target: `cache-${stream}` // Update corresponding cache
 *   }))
 * ```
 *
 * @example With priority (saturated worker scheduling)
 * ```typescript
 * .on("OrderConfirmed")
 *   .do(sendCriticalNotification)
 *   .to({ target: "notifications-out", priority: 10 })
 * ```
 *
 * @see {@link Reaction} for complete reaction configuration
 * @see {@link Resolved} for the resolved-target shape
 */
export type ReactionResolver<
  TEvents extends Schemas,
  TKey extends keyof TEvents,
  TLane extends string = string,
> =
  | Resolved<TLane> // static
  | ((event: Committed<TEvents, TKey>) => Resolved<TLane> | undefined); // dynamic

/**
 * Resolver output shape — what `.to(...)` returns for a static or dynamic
 * resolver.
 *
 * @property target - Stream name that processes this reaction
 * @property source - Optional source-stream filter for fetch optimization
 * @property priority - Optional scheduling hint. The lagging-frontier
 *   `claim()` orders streams by `priority DESC, at ASC`, so a higher value
 *   makes the stream win lease slots ahead of equal-watermark peers under
 *   saturation. Default `0` — behavior identical to current dual-frontier.
 *   Only meaningful when `streamLimit` is binding (more candidate streams
 *   than the worker can claim per cycle); idle systems are unaffected.
 *   See `libs/act-pg/PERFORMANCE.md` for the benchmark that motivated this
 *   knob.
 * @property lane - Optional drain lane (ACT-1103). Defaults to `"default"`.
 */
export type Resolved<TLane extends string = string> = {
  readonly target: string;
  readonly source?: string;
  readonly priority?: number;
  readonly lane?: TLane;
};

/**
 * Build-time configuration for a drain lane (ACT-1103).
 *
 * @property name - Lane name (`"default"` is reserved for the implicit lane)
 * @property leaseMillis - Lease window for `claim()` calls in this lane
 * @property streamLimit - Max streams claimed per cycle in this lane
 * @property cycleMs - Cycle frequency for this lane's controller
 */
export type LaneConfig<TName extends string = string> = {
  readonly name: TName;
  readonly leaseMillis?: number;
  readonly streamLimit?: number;
  readonly cycleMs?: number;
};

/**
 * Options for reaction processing.
 *
 * For the shared retry-pacing shape see {@link BackoffOptions} and
 * {@link BackoffStrategy} in `./action.js`.
 *
 * Reaction-side note on `backoff`: backoff state lives in process memory
 * on the {@link DrainController}. With N competing workers (each running
 * its own controller), retries escalate at most N× faster than configured
 * — the shared `retry` counter on the stream watermark climbs across
 * workers, reaching the `blockOnError` threshold sooner. This is
 * intentional: per-worker pacing speeds up recovery on transient
 * per-worker faults, and poison messages still get quarantined.
 *
 * @property blockOnError - Whether to block on error.
 * @property maxRetries - Maximum number of retries.
 * @property backoff - Optional retry pacing. When omitted, retries run as
 *   soon as the lease expires (current behavior — implicit backoff bounded
 *   by `leaseMillis`). When set, the drain controller waits at least the
 *   computed delay before re-attempting on this worker.
 */
export type ReactionOptions = {
  readonly blockOnError: boolean;
  readonly maxRetries: number;
  readonly backoff?: BackoffOptions;
};

/**
 * Distributive mapped type that produces a proper discriminated union of
 * committed events. Unlike `Committed<TEvents, keyof TEvents>` (where
 * `name` and `data` are independent unions), each variant correlates
 * `name` with its corresponding `data` — enabling `switch (event.name)`
 * to narrow both fields correctly.
 *
 * @template TEvents - Event schemas
 *
 * @example Exhaustive switch
 * ```typescript
 * for (const event of events) {
 *   switch (event.name) {
 *     case "TicketOpened":
 *       event.data; // typed as TicketOpened's schema
 *       break;
 *     case "TicketClosed":
 *       event.data; // typed as TicketClosed's schema
 *       break;
 *     default:
 *       const _: never = event; // compile error if a case is missing
 *   }
 * }
 * ```
 */
export type BatchEvent<TEvents extends Schemas> = {
  [K in keyof TEvents]: Committed<TEvents, K>;
}[keyof TEvents];

/**
 * Batch handler for projections that processes multiple events in a single call.
 *
 * Receives the full ordered array of all event types declared on the projection,
 * enabling bulk DB operations (batch INSERT/UPDATE) in a single transaction.
 * The handler is always called when defined — even for a single event.
 *
 * @template TEvents - Event schemas (all events declared on the projection)
 * @param events - Ordered array of committed events (discriminated union)
 * @param stream - The target stream name
 *
 * @see {@link BatchEvent} for the discriminated union type
 */
export type BatchHandler<TEvents extends Schemas> = (
  events: ReadonlyArray<BatchEvent<TEvents>>,
  stream: string
) => Promise<void>;

/**
 * A stream's folded state at the flush frontier, produced by
 * `projection(name).of(state)` — one per dirty stream per flush round.
 *
 * `id` is the max event id folded in. Flush handlers should
 * upsert keyed on `stream` and may guard with `id`
 * (ignore-if-older) to stay order-safe when a rebuild races a live
 * worker.
 *
 * @template TState - The projected state shape
 */
export type ProjectedState<TState extends Schema = Schema> = Readonly<{
  stream: string;
  state: TState;
  version: number;
  id: number;
}>;

/**
 * Options for `projection(name).of(state, options)` — both deterministic:
 * behavior is a pure function of the event sequence and these two bounds.
 *
 * @property flushEvery - Events folded between flush rounds (default 1000)
 * @property maxCachedStates - LRU bound on in-memory folded states; the
 * evictee is flushed before it is dropped (default 10000)
 */
export type FoldOptions = Readonly<{
  flushEvery?: number;
  maxCachedStates?: number;
}>;

/**
 * Defines a reaction to an event.
 * @template TEvents - Event schemas.
 * @template TKey - Event name.
 * @template TActions - Action schemas.
 * @template TActor - Actor type extending base Actor.
 * @property handler - The reaction handler.
 * @property resolver - The reaction resolver.
 * @property options - The reaction options.
 */
export type Reaction<
  TEvents extends Schemas,
  TKey extends keyof TEvents = keyof TEvents,
  TActions extends Schemas = Schemas,
  TActor extends Actor = Actor,
> = {
  readonly handler: ReactionHandler<TEvents, TKey, TActions, TActor>;
  /**
   * Mutable so the builder's `.do()` → `.to()` chain can patch the resolver
   * in place (registered once with the default `_this_` resolver in `.do()`,
   * overwritten in `.to()` if present). After build-time the field is
   * effectively immutable; runtime consumers only read it.
   */
  resolver: ReactionResolver<TEvents, TKey>;
  readonly options: ReactionOptions;
};

/**
 * Payload for a reaction.
 * @template TEvents - Event schemas.
 * @property handler - The reaction handler.
 * @property resolver - The reaction resolver.
 * @property options - The reaction options.
 * @property event - The committed event triggering the reaction.
 * @property source - The source stream.
 */
export type ReactionPayload<TEvents extends Schemas> = Reaction<TEvents> & {
  readonly event: Committed<TEvents, keyof TEvents>;
  readonly source?: string;
};

/**
 * Result of fetching events from the store for processing.
 * @template TEvents - Event schemas.
 * @property stream - The stream name
 * @property source - The source stream(s) (name or RegExp), or undefined when sourcing from all streams.
 * @property at - The last event sequence number processed by the stream.
 * @property lagging - Whether the stream is lagging behind.
 * @property events - The list of next committed events to be processed by the stream.
 */
export type Fetch<TEvents extends Schemas> = Array<{
  readonly stream: string;
  readonly source?: string;
  readonly at: number;
  readonly lagging: boolean;
  readonly events: Committed<TEvents, keyof TEvents>[];
}>;

/**
 * Lease information for distributed stream processing.
 *
 * Leases prevent concurrent processing of the same stream by multiple workers.
 * When a worker acquires a lease, it has exclusive rights to process events
 * for that stream until the lease expires or is acknowledged.
 *
 * The drain process uses leases to:
 * - Prevent race conditions in distributed setups
 * - Track processing progress (watermark)
 * - Manage retries on failures
 * - Balance load between lagging and leading streams
 *
 * @property stream - The target stream name being processed
 * @property source - Optional source stream for filtering
 * @property at - Watermark: last successfully processed event ID
 * @property by - Unique identifier of the lease holder (UUID)
 * @property retry - Number of retry attempts (0 = first attempt)
 * @property lagging - Whether this stream is behind (lagging frontier)
 * @property lane - Drain lane the stream is bound to (ACT-1103)
 *
 * @example
 * ```typescript
 * app.on("acked", (leases) => {
 *   leases.forEach(lease => {
 *     console.log(`Processed ${lease.stream} up to event ${lease.at}`);
 *   });
 * });
 *
 * app.on("blocked", (blocked) => {
 *   blocked.forEach(({ stream, retry, error }) => {
 *     console.error(`Stream ${stream} blocked after ${retry} retries: ${error}`);
 *   });
 * });
 * ```
 *
 * @see {@link Drain} for drain cycle results
 */
export type Lease = {
  readonly stream: string;
  readonly source?: string;
  readonly at: number;
  readonly by: string;
  readonly retry: number;
  readonly lagging: boolean;
  readonly lane?: string;
  /**
   * Defer marker on the finalize path. When set on a lease passed
   * to {@link Store.ack}, the stream is being *deferred*, not acked: the
   * adapter must persist `due` (ms since epoch) as the stream's
   * `deferred_at` and reset `retry` — without advancing the watermark —
   * atomically with the other entries' acks. Deferred entries are not part
   * of ack's return value. Never set on leases returned by `claim` or
   * carried by lifecycle events.
   */
  readonly due?: number;
};

/**
 * A {@link Lease} augmented with the failure reason that pushed it past
 * its retry budget. Yielded by {@link Drain.blocked}, emitted on the
 * `"blocked"` lifecycle event, and accepted by {@link Store.block}.
 */
export type BlockedLease = Lease & { readonly error: string };

/**
 * Options for draining events from the store.
 * @property streamLimit - Maximum number of streams to fetch.
 * @property eventLimit - Maximum number of events to fetch per stream.
 * @property leaseMillis - Maximum lease duration (in milliseconds).
 */
export type DrainOptions = {
  readonly streamLimit?: number;
  readonly eventLimit?: number;
  readonly leaseMillis?: number;
};

/**
 * Drain results
 * @property fetched - The fetched events.
 * @property leased - The leased events.
 * @property acked - The acked events.
 * @property blocked - The blocked events (with error).
 */
export type Drain<TEvents extends Schemas> = {
  readonly fetched: Fetch<TEvents>;
  readonly leased: Lease[];
  readonly acked: Lease[];
  readonly blocked: BlockedLease[];
};

/**
 * Options for the debounced settle cycle.
 *
 * Extends {@link DrainOptions} with parameters that control the debounce
 * window, the correlation query, and the maximum number of correlate→drain
 * passes.
 *
 * @property debounceMs - Debounce window in milliseconds (default: 10)
 * @property correlate - Query filter for correlation scans (default: `{ after: -1, limit: 100 }`)
 * @property maxPasses - Cap on correlate→drain loops (default: `Infinity`).
 *   Settle exits early as soon as a pass makes no progress (no new
 *   subscriptions, no acks, no blocks), so the cap only matters in
 *   pathological cases.
 */
export type SettleOptions = DrainOptions & {
  readonly debounceMs?: number;
  readonly correlate?: Query;
  readonly maxPasses?: number;
};
