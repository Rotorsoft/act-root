/**
 * @packageDocumentation
 * @module act/types
 * @category Types
 * Types for reactions, leases, and fetch results in the Act Framework.
 */
import type { Committed, Schema, Schemas, Snapshot } from "./action.js";

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
 * @template E - Event schemas
 * @template K - Event name
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
export type ReactionHandler<E extends Schemas, K extends keyof E> = (
  event: Committed<E, K>,
  stream: string,
  app: any
) => Promise<Snapshot<E, Schema> | void>;

/**
 * Resolver for determining which stream a reaction should target.
 *
 * Resolvers enable dynamic reaction routing based on event content. They can be:
 * - **Static**: Always route to the same target stream
 * - **Dynamic**: Determine target based on event data at runtime
 *
 * Resolvers can also specify source streams for optimization, allowing the drain
 * process to efficiently fetch only relevant events.
 *
 * @template E - Event schemas
 * @template K - Event name
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
 * @see {@link Reaction} for complete reaction configuration
 */
export type ReactionResolver<E extends Schemas, K extends keyof E> =
  | { target: string; source?: string } // static
  | ((
      event: Committed<E, K>
    ) => { target: string; source?: string } | undefined); // dynamic

/**
 * Options for reaction processing.
 * @property blockOnError - Whether to block on error.
 * @property maxRetries - Maximum number of retries.
 */
export type ReactionOptions = {
  readonly blockOnError: boolean;
  readonly maxRetries: number;
};

/**
 * Defines a reaction to an event.
 * @template E - Event schemas.
 * @template K - Event name.
 * @property handler - The reaction handler.
 * @property resolver - The reaction resolver.
 * @property options - The reaction options.
 */
export type Reaction<E extends Schemas, K extends keyof E = keyof E> = {
  readonly handler: ReactionHandler<E, K>;
  readonly resolver: ReactionResolver<E, K>;
  readonly options: ReactionOptions;
};

/**
 * Payload for a reaction.
 * @template E - Event schemas.
 * @property handler - The reaction handler.
 * @property resolver - The reaction resolver.
 * @property options - The reaction options.
 * @property event - The committed event triggering the reaction.
 * @property source - The source stream.
 */
export type ReactionPayload<E extends Schemas> = Reaction<E> & {
  readonly event: Committed<E, keyof E>;
  readonly source?: string;
};

/**
 * Poll details for stream processing.
 * @property stream - The target stream name.
 * @property source - The source stream.
 * @property at - The lease watermark.
 * @property lagging - Whether the stream is lagging behind.
 */
export type Poll = {
  readonly stream: string;
  readonly source?: string;
  readonly at: number;
  readonly lagging: boolean;
};

/**
 * Result of fetching events from the store for processing.
 * @template E - Event schemas.
 * @property stream - The stream name
 * @property source - The source stream(s) (name or RegExp), or undefined when sourcing from all streams.
 * @property at - The last event sequence number processed by the stream.
 * @property lagging - Whether the stream is lagging behind.
 * @property events - The list of next committed events to be processed by the stream.
 */
export type Fetch<E extends Schemas> = Array<{
  readonly stream: string;
  readonly source?: string;
  readonly at: number;
  readonly lagging: boolean;
  readonly events: Committed<E, keyof E>[];
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
};

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
export type Drain<E extends Schemas> = {
  readonly fetched: Fetch<E>;
  readonly leased: Lease[];
  readonly acked: Lease[];
  readonly blocked: Array<Lease & { readonly error: string }>;
};
