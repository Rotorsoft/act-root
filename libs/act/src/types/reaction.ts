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
 * @returns The output stream name and optionally the source stream name (for fetch optimization).
 */
export type ReactionResolver<E extends Schemas, K extends keyof E> =
  | ((event: Committed<E, K>) => { output: string; input?: string } | undefined)
  | { output: string; input?: string };

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
 * @property handler - The reaction handler.
 * @property resolver - The reaction resolver.
 * @property options - The reaction options.
 * @property event - The committed event triggering the reaction.
 * @property input - The source stream name (for fetch optimization).
 */
export type ReactionPayload<E extends Schemas> = Reaction<E> & {
  readonly event: Committed<E, keyof E>;
  readonly input?: string;
};

/**
 * Options for fetching events from the store.
 * When `startAt` is provided, fetches from that position in the store, returning empty `stream` to signal new correlations.
 * When no streams with pending events are found, defaults to fetching from the start of the store - like `startAt: 0`.
 * @property streamLimit - Maximum number of streams to fetch.
 * @property eventLimit - Maximum number of events to fetch per stream.
 * @property startAt - Optional starting point to force fetching from a specific point in the store (to start new streams)
 */
export type FetchOptions = {
  readonly streamLimit: number;
  readonly eventLimit: number;
  readonly startAt?: number;
};

/**
 * Result of fetching events from the store for processing.
 * When no streams with pending events are found, returns events starting from the startAt option.
 * @template E - Event schemas.
 * @property stream - The stream name, or "" if no streams are found (see startAt option).
 * @property events - The list of next committed events to be processed by the stream or from the start of the store.
 */
export type Fetch<E extends Schemas> = Array<{
  readonly stream: string;
  readonly events: Committed<E, keyof E>[];
}>;

/**
 * Filter used to fetch events from a stream in order to optimize future fetches.
 * @property stream - The source stream to fetch events from.
 * @property names - The list of event names to fetch.
 */
export type StreamFilter = {
  readonly stream?: string;
  readonly names?: string[];
};

/**
 * Lease information for stream processing.
 * @property stream - The stream name.
 * @property by - The lease holder.
 * @property filter - The filter to be applied to the source `all-stream` for future fetches.
 * @property at - The lease watermark.
 * @property retry - Retry count.
 * @property block - Whether the stream is blocked.
 * @property error - Optional error info.
 */
export type Lease = {
  readonly stream: string;
  readonly by: string;
  readonly filter?: StreamFilter;
  at: number;
  retry: number;
  block: boolean;
  error?: unknown;
};
