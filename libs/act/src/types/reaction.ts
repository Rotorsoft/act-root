/**
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
 * Resolves the stream for a reaction, either by function or static string.
 * @template E - Event schemas.
 * @template K - Event name.
 * @param event - The committed event.
 * @returns The stream name or undefined.
 */
export type ReactionResolver<E extends Schemas, K extends keyof E> =
  | ((event: Committed<E, K>) => string | undefined)
  | string;

/**
 * Options for reaction processing.
 * @property blockOnError - Whether to block on error.
 * @property maxRetries - Maximum number of retries.
 * @property retryDelayMs - Delay between retries in ms.
 */
export type ReactionOptions = {
  readonly blockOnError: boolean;
  readonly maxRetries: number;
  readonly retryDelayMs: number;
};

/**
 * Defines a reaction to an event, including handler, resolver, and options.
 * @template E - Event schemas.
 * @template K - Event name.
 */
export type Reaction<E extends Schemas, K extends keyof E = keyof E> = {
  readonly handler: ReactionHandler<E, K>;
  readonly resolver: ReactionResolver<E, K>;
  readonly options: ReactionOptions;
};

/**
 * Payload for a reaction, including the event and reaction definition.
 * @template E - Event schemas.
 */
export type ReactionPayload<E extends Schemas> = Reaction<E> & {
  readonly event: Committed<E, keyof E>;
};

/**
 * Result of fetching events from the store for processing.
 * @template E - Event schemas.
 * @property streams - The list of stream names.
 * @property events - The list of committed events.
 */
export type Fetch<E extends Schemas> = {
  streams: string[];
  events: Committed<E, keyof E>[];
};

/**
 * Lease information for stream processing.
 * @property stream - The stream name.
 * @property by - The lease holder.
 * @property at - The lease timestamp.
 * @property retry - Retry count.
 * @property block - Whether the stream is blocked.
 * @property error - Optional error info.
 */
export type Lease = {
  stream: string;
  by: string;
  at: number;
  retry: number;
  block: boolean;
  error?: unknown;
};
