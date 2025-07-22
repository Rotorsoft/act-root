import { randomUUID } from "crypto";
import EventEmitter from "events";
import * as es from "./event-sourcing.js";
import { logger, store } from "./ports.js";
import { ValidationError } from "./types/errors.js";
import type {
  Committed,
  Fetch,
  FetchOptions,
  Lease,
  Query,
  ReactionPayload,
  ReactionsRegister,
  Registry,
  Schema,
  SchemaRegister,
  Schemas,
  Snapshot,
  State,
  Target,
} from "./types/index.js";

function traceFetch<E extends Schemas>(fetch: Fetch<E>) {
  const data = Object.fromEntries(
    fetch.map(({ stream, source, events }) => {
      const key = source ? `${stream}<-${source}` : stream;
      const value = Object.fromEntries(
        events.map(({ id, stream, name }) => [id, { [stream]: name }])
      );
      return [key, value];
    })
  );
  logger.trace(data, "⚡️ fetch");
}

function traceLeased(leases: Lease[]) {
  const data = Object.fromEntries(
    leases.map(({ stream, at, retry }) => [stream, { at, retry }])
  );
  logger.trace(data, "⚡️ lease");
}

function traceAcked(leases: Lease[]) {
  const data = Object.fromEntries(
    leases.map(({ stream, at, retry }) => [stream, { at, retry }])
  );
  logger.trace(data, "⚡️ ack");
}

function traceBlocked(leases: Array<Lease & { error: string }>) {
  const data = Object.fromEntries(
    leases.map(({ stream, at, retry, error }) => [stream, { at, retry, error }])
  );
  logger.trace(data, "⚡️ block");
}

/**
 * @category Orchestrator
 * @see Store
 *
 * Main orchestrator for event-sourced state machines and workflows.
 *
 * It manages the lifecycle of actions, reactions, and event streams, providing APIs for loading state, executing actions, querying events, and draining reactions.
 *
 * ## Usage
 *
 * ```typescript
 * const app = new Act(registry, 100);
 * await app.do("increment", { stream: "counter1", actor }, { by: 1 });
 * const snapshot = await app.load(Counter, "counter1");
 * await app.drain();
 * ```
 *
 * - Register event listeners with `.on("committed", ...)` and `.on("acked", ...)` to react to lifecycle events.
 * - Use `.query()` to analyze event streams for analytics or debugging.
 *
 * @template S SchemaRegister for state
 * @template E Schemas for events
 * @template A Schemas for actions
 */
export class Act<
  S extends SchemaRegister<A>,
  E extends Schemas,
  A extends Schemas,
> {
  private _emitter = new EventEmitter();

  /**
   * Emit a lifecycle event (internal use, but can be used for custom listeners).
   *
   * @param event The event name ("committed", "acked",  or "blocked")
   * @param args The event payload
   * @returns true if the event had listeners, false otherwise
   */
  emit(event: "committed", args: Snapshot<S, E>[]): boolean;
  emit(event: "acked", args: Lease[]): boolean;
  emit(event: "blocked", args: Array<Lease & { error: string }>): boolean;
  emit(event: string, args: any): boolean {
    return this._emitter.emit(event, args);
  }

  /**
   * Register a listener for a lifecycle event ("committed", "acked", or "blocked").
   *
   * @param event The event name
   * @param listener The callback function
   * @returns this (for chaining)
   */
  on(event: "committed", listener: (args: Snapshot<S, E>[]) => void): this;
  on(event: "acked", listener: (args: Lease[]) => void): this;
  on(
    event: "blocked",
    listener: (args: Array<Lease & { error: string }>) => void
  ): this;
  on(event: string, listener: (args: any) => void): this {
    this._emitter.on(event, listener);
    return this;
  }

  /**
   * Remove a listener for a lifecycle event.
   *
   * @param event The event name
   * @param listener The callback function
   * @returns this (for chaining)
   */
  off(event: "committed", listener: (args: Snapshot<S, E>[]) => void): this;
  off(event: "acked", listener: (args: Lease[]) => void): this;
  off(
    event: "blocked",
    listener: (args: Array<Lease & { error: string }>) => void
  ): this;
  off(event: string, listener: (args: any) => void): this {
    this._emitter.off(event, listener);
    return this;
  }

  /**
   * Create a new Act orchestrator.
   *
   * @param registry The registry of state, event, and action schemas
   */
  constructor(public readonly registry: Registry<S, E, A>) {}

  /**
   * Executes an action (command) against a state machine, emitting and committing the resulting event(s).
   *
   * @template K The type of action to execute
   * @param action The action name (key of the action schema)
   * @param target The target (stream and actor) for the action
   * @param payload The action payload (validated against the schema)
   * @param reactingTo (Optional) The event this action is reacting to
   * @param skipValidation (Optional) If true, skips schema validation (not recommended)
   * @returns The snapshot of the committed event
   *
   * @example
   * await app.do("increment", { stream: "counter1", actor }, { by: 1 });
   */
  async do<K extends keyof A>(
    action: K,
    target: Target,
    payload: Readonly<A[K]>,
    reactingTo?: Committed<E, keyof E>,
    skipValidation = false
  ) {
    const snapshots = await es.action(
      this.registry.actions[action],
      action,
      target,
      payload,
      // @ts-expect-error type lost
      reactingTo,
      skipValidation
    );
    this.emit("committed", snapshots as Snapshot<S, E>[]);
    // fire and forget correlations - TODO: review this approach, maybe we can do this in the builder
    void this.correlate(snapshots.filter((s) => s.event).map((s) => s.event!));
    return snapshots;
  }

  /**
   * Loads the current state snapshot for a given state machine and stream.
   *
   * @template SX The type of state
   * @template EX The type of events
   * @template AX The type of actions
   * @param state The state machine definition
   * @param stream The stream (instance) to load
   * @param callback (Optional) Callback to receive the loaded snapshot
   * @returns The snapshot of the loaded state
   *
   * @example
   * const snapshot = await app.load(Counter, "counter1");
   */
  async load<SX extends Schema, EX extends Schemas, AX extends Schemas>(
    state: State<SX, EX, AX>,
    stream: string,
    callback?: (snapshot: Snapshot<SX, EX>) => void
  ): Promise<Snapshot<SX, EX>> {
    return await es.load(state, stream, callback);
  }

  /**
   * Query the event store for events matching a filter.
   *
   * @param query The query filter (e.g., by stream, event name, or time range)
   * @param callback (Optional) Callback for each event found
   * @returns An object with the first and last event found, and the total count
   *
   * @example
   * const { count } = await app.query({ stream: "counter1" }, (event) => console.log(event));
   */
  async query(
    query: Query,
    callback?: (event: Committed<E, keyof E>) => void
  ): Promise<{
    first?: Committed<E, keyof E>;
    last?: Committed<E, keyof E>;
    count: number;
  }> {
    let first: Committed<E, keyof E> | undefined = undefined,
      last: Committed<E, keyof E> | undefined = undefined;
    const count = await store().query<E>((e) => {
      !first && (first = e);
      last = e;
      callback && callback(e);
    }, query);
    return { first, last, count };
  }

  /**
   * Query the event store for events matching a filter.
   * Use this version with caution, as it return events in memory.
   *
   * @param query The query filter (e.g., by stream, event name, or time range)
   * @returns The matching events
   *
   * @example
   * const { count } = await app.query({ stream: "counter1" }, (event) => console.log(event));
   */
  async query_array(query: Query): Promise<Committed<E, keyof E>[]> {
    const events: Committed<E, keyof E>[] = [];
    await store().query<E>((e) => events.push(e), query);
    return events;
  }

  /**
   * Identifies and registers new streams triggered by committed events using reaction resolvers.
   *
   * Enables "dynamic reactions", allowing streams to be auto-discovered based on event content.
   * Once registered, these streams will be picked up by the main `drain` loop.
   * @param events - Committed events to correlate
   * @returns - A list of leases for each stream
   */
  async correlate<E extends Schemas>(
    events: Committed<E, keyof E>[]
  ): Promise<Array<Lease & { payloads: ReactionPayload<E>[] }>> {
    if (!events.length) return [];
    const correlated = new Map<string, ReactionPayload<E>[]>();
    for (const event of events) {
      // @ts-expect-error indexed by key
      const register = this.registry.events[event.name] as ReactionsRegister<
        E,
        keyof E
      >;
      if (!register) continue; // skip events with no registered reactions
      for (const reaction of register.reactions.values()) {
        const resolved =
          typeof reaction.resolver === "function"
            ? reaction.resolver(event)
            : reaction.resolver;
        resolved &&
          (
            correlated.get(resolved.target) ||
            correlated.set(resolved.target, []).get(resolved.target)!
          ).push({ ...reaction, source: resolved.source, event });
      }
    }
    // found new correlations from fetched events!
    const leases = [...correlated.entries()].map(([stream, payloads]) => ({
      stream,
      // TODO: by convention, the first defined source wins (this can be tricky)
      source: payloads.find((p) => p.source)?.source || undefined,
      by: randomUUID(),
      at: 0,
      retry: 0,
      payloads,
    }));
    if (leases.length) {
      const leased = await store().lease(leases, 0);
      traceLeased(leased);
    }
    return leases;
  }

  /**
   * Handles leased reactions.
   *
   * This is called by the main `drain` loop after fetching new events.
   * It handles reactions, supporting retries, blocking, and error handling.
   *
   * @internal
   * @param lease The lease to handle
   * @param payloads The reactions to handle
   * @returns The lease with results
   */
  private async handle<E extends Schemas>(
    lease: Lease,
    payloads: ReactionPayload<E>[]
  ): Promise<{ lease: Lease; at: number; error?: string; block?: boolean }> {
    const stream = lease.stream;
    let at = lease.at;

    lease.retry > 0 &&
      logger.warn(`Retrying ${stream}@${at} (${lease.retry}).`);

    for (const payload of payloads) {
      const { event, handler, options } = payload;
      try {
        await handler(event, stream); // the actual reaction
        at = event.id;
      } catch (error) {
        if (error instanceof ValidationError)
          logger.error({ stream, error }, error.message);
        else logger.error(error);

        const block = lease.retry >= options.maxRetries && options.blockOnError;
        block &&
          logger.error(`Blocking ${stream} after ${lease.retry} retries.`);
        return {
          lease,
          at,
          error: error instanceof Error ? error.message : "Unknown error",
          block,
        };
      }
    }
    return { lease, at };
  }

  /**
   * Fetches new events from store according to the fetch options.
   * @param options - Fetch options.
   * @returns Fetched streams with next events to process.
   */
  async fetch({ streamLimit = 10, eventLimit = 10 }: FetchOptions) {
    const polled = await store().poll(streamLimit);
    return Promise.all(
      polled.map(async ({ stream, source, at }) => {
        const events = await this.query_array({
          stream: source,
          after: at,
          limit: eventLimit,
        });
        return { stream, source, events };
      })
    );
  }

  private drainLocked = false;

  /**
   * Drains and processes events from the store, triggering reactions and updating state.
   *
   * This is typically called in a background loop or after committing new events.
   *
   * @returns The number of events drained and processed
   *
   * @example
   * await app.drain();
   */
  async drain<E extends Schemas>({
    streamLimit = 10,
    eventLimit = 10,
    leaseMillis = 10_000,
  }: FetchOptions = {}): Promise<{
    leased: Lease[];
    acked: Lease[];
    blocked: Array<Lease & { error: string }>;
  }> {
    if (!this.drainLocked) {
      try {
        this.drainLocked = true;

        const fetch = await this.fetch({ streamLimit, eventLimit });
        traceFetch(fetch);

        const last_at = fetch.reduce(
          (last_at, { events }) => Math.max(last_at, events.at(-1)?.id || -1),
          -1
        );
        if (last_at > -1) {
          const leases = new Map<
            string,
            { lease: Lease; payloads: ReactionPayload<E>[] }
          >();
          fetch.forEach(({ stream, events }) => {
            const payloads = events.flatMap((event) => {
              // @ts-expect-error indexed by key
              const register = this.registry.events[
                event.name
              ] as ReactionsRegister<E, keyof E>;
              if (!register) return [];
              return [...register.reactions.values()]
                .filter((reaction) => {
                  const resolved =
                    typeof reaction.resolver === "function"
                      ? // @ts-expect-error index by key
                        reaction.resolver(event)
                      : reaction.resolver;
                  return resolved && resolved.target === stream;
                })
                .map((reaction) => ({ ...reaction, event }));
            });
            leases.set(stream, {
              lease: {
                stream,
                by: randomUUID(),
                at: events.at(-1)?.id || last_at, // move the lease watermark forward when no events found in window
                retry: 0,
              },
              // @ts-expect-error indexed by key
              payloads,
            });
          });

          if (leases.size) {
            const leased = await store().lease(
              [...leases.values()].map((l) => l.lease),
              leaseMillis
            );
            if (leased.length) {
              traceLeased(leased);

              const handled = await Promise.all(
                leased.map((lease) =>
                  this.handle(lease, leases.get(lease.stream)!.payloads)
                )
              );

              const acked = await store().ack(
                handled.filter(({ error }) => !error).map(({ lease }) => lease)
              );
              if (acked.length) {
                traceAcked(acked);
                this.emit("acked", acked);
              }

              const blocked = await store().block(
                handled
                  .filter(({ block }) => block)
                  .map(({ lease, error }) => ({ ...lease, error: error! }))
              );
              if (blocked.length) {
                traceBlocked(blocked);
                this.emit("blocked", blocked);
              }

              return { leased, acked, blocked };
            }
          }
        }
      } catch (error) {
        logger.error(error);
      } finally {
        this.drainLocked = false;
      }
    }

    return { leased: [], acked: [], blocked: [] };
  }
}
