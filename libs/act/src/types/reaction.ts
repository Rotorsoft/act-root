/**
 * @packageDocumentation
 * @module act/types
 * @category Types
 * Types for reactions, leases, and fetch results in the Act Framework.
 */
import type { Committed, Schema, Schemas, Snapshot } from "./action.js";

/**
 * Handles a committed event and optionally returns a new snapshot of state.
 * @template E - Event schemas.
 * @template K - Event name.
 * @param event - The committed event.
 * @param stream - The stream name.
 * @returns A promise resolving to a snapshot or void.
 */
export type ReactionHandler<E extends Schemas, K extends keyof E> = (
  event: Committed<E, K>,
  stream: string
) => Promise<Snapshot<E, Schema> | void>;

/**
 * Resolves the stream for a reaction, either by mapping the event or statically.
 * @template E - Event schemas.
 * @template K - Event name.
 * @param event - The committed event.
 * @returns The target stream name and optionally the source stream (for fetch optimization).
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
 */
export type Poll = {
  readonly stream: string;
  readonly source?: string;
  readonly at: number;
};

/**
 * Result of fetching events from the store for processing.
 * @template E - Event schemas.
 * @property stream - The stream name
 * @property source - The source stream(s) (name or RegExp), or undefined when sourcing from all streams.
 * @property at - The last event sequence number processed by the stream.
 * @property events - The list of next committed events to be processed by the stream.
 */
export type Fetch<E extends Schemas> = Array<{
  readonly stream: string;
  readonly source?: string;
  readonly at: number;
  readonly events: Committed<E, keyof E>[];
}>;

/**
 * Lease information for stream processing.
 * @property stream - The target stream name.
 * @property source - The source stream.
 * @property by - The lease holder.
 * @property at - The lease watermark.
 * @property retry - Retry count.
 */
export type Lease = {
  readonly stream: string;
  readonly source?: string;
  readonly at: number;
  readonly by: string;
  readonly retry: number;
};

/**
 * Options for draining events from the store.
 * @property streamLimit - Maximum number of streams to fetch.
 * @property eventLimit - Maximum number of events to fetch per stream.
 * @property leaseMillis - Maximum lease duration (in milliseconds).
 * @property descending - Whether to fetch streams in descending order (aka fetch the most advanced first).
 */
export type DrainOptions = {
  readonly streamLimit?: number;
  readonly eventLimit?: number;
  readonly leaseMillis?: number;
  readonly descending?: boolean;
};

/**
 * Drain results
 * @property fetched - The fetched events.
 * @property leased - The leased events.
 * @property acked - The acked events.
 * @property blocked - The blocked events.
 */
export type Drain<E extends Schemas> = {
  readonly fetched: Fetch<E>;
  readonly leased: Lease[];
  readonly acked: Lease[];
  readonly blocked: Array<Lease & { error: string }>;
};
