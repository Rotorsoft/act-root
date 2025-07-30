import { randomUUID } from "crypto";
import EventEmitter from "events";
import { config } from "./config.js";
import * as es from "./event-sourcing.js";
import { build_tracer, dispose, logger, store } from "./ports.js";
import type {
  Committed,
  Drain,
  DrainOptions,
  Lease,
  Query,
  ReactionPayload,
  Registry,
  Schema,
  SchemaRegister,
  Schemas,
  Snapshot,
  State,
  Target,
} from "./types/index.js";

const tracer = build_tracer(config().logLevel);

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
  private _drain_locked = false;
  private _correlation_interval: NodeJS.Timeout | undefined = undefined;

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
  constructor(public readonly registry: Registry<S, E, A>) {
    dispose(() => {
      this._emitter.removeAllListeners();
      this.stop_correlations();
      return Promise.resolve();
    });
  }

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
    // no payloads, just advance the lease
    if (payloads.length === 0) return { lease, at: lease.at };

    const stream = lease.stream;
    let at = payloads.at(0)!.event.id,
      handled = 0;

    lease.retry > 0 &&
      logger.warn(`Retrying ${stream}@${at} (${lease.retry}).`);

    for (const payload of payloads) {
      const { event, handler, options } = payload;
      try {
        await handler(event, stream); // the actual reaction
        at = event.id;
        handled++;
      } catch (error) {
        logger.error(error);
        const block = lease.retry >= options.maxRetries && options.blockOnError;
        block &&
          logger.error(`Blocking ${stream} after ${lease.retry} retries.`);
        return {
          lease,
          at,
          // only report error when nothing was handled
          error: handled === 0 ? (error as Error).message : undefined,
          block,
        };
      }
    }
    return { lease, at };
  }

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
  }: DrainOptions = {}): Promise<Drain<E>> {
    if (!this._drain_locked) {
      try {
        this._drain_locked = true;

        // TODO: use configurable options
        // for now, but default use 2/3 of streamLimit for lagging, and 1/3 for leading
        // round up to nearest integer
        const lagging = Math.ceil((streamLimit * 2) / 3);
        const leading = streamLimit - lagging;
        const polled = await store().poll(lagging, leading);
        const fetched = await Promise.all(
          polled.map(async ({ stream, source, at }) => {
            const events = await this.query_array({
              stream: source,
              after: at,
              limit: eventLimit,
            });
            return { stream, source, at, events } as const;
          })
        );
        if (fetched.length) {
          tracer.fetched(fetched);

          const leases = new Map<
            string,
            { lease: Lease; payloads: ReactionPayload<E>[] }
          >();

          // last event id found in fetch window
          const last_window_at = fetched.reduce(
            (max, { at, events }) => Math.max(max, events.at(-1)?.id || at),
            0
          );
          fetched.forEach(({ stream, events }) => {
            const payloads = events.flatMap((event) => {
              const register = this.registry.events[event.name] || [];
              return [...register.reactions.values()]
                .filter((reaction) => {
                  const resolved =
                    typeof reaction.resolver === "function"
                      ? reaction.resolver(event)
                      : reaction.resolver;
                  return resolved && resolved.target === stream;
                })
                .map((reaction) => ({ ...reaction, event }));
            });
            leases.set(stream, {
              lease: {
                stream,
                by: randomUUID(),
                at: events.at(-1)?.id || last_window_at, // ff when no matching events
                retry: 0,
              },
              // @ts-expect-error indexed by key
              payloads,
            });
          });

          const leased = await store().lease(
            [...leases.values()].map((l) => l.lease),
            leaseMillis
          );
          tracer.leased(leased);

          const handled = await Promise.all(
            leased.map((lease) =>
              this.handle(lease, leases.get(lease.stream)!.payloads)
            )
          );

          const acked = await store().ack(
            handled
              .filter(({ error }) => !error)
              .map(({ at, lease }) => ({ ...lease, at }))
          );
          if (acked.length) {
            tracer.acked(acked);
            this.emit("acked", acked);
          }

          const blocked = await store().block(
            handled
              .filter(({ block }) => block)
              .map(({ lease, error }) => ({ ...lease, error: error! }))
          );
          if (blocked.length) {
            tracer.blocked(blocked);
            this.emit("blocked", blocked);
          }

          // @ts-expect-error key
          return { fetched, leased, acked, blocked };
        }
      } catch (error) {
        logger.error(error);
      } finally {
        this._drain_locked = false;
      }
    }

    return { fetched: [], leased: [], acked: [], blocked: [] };
  }

  /**
   * Correlates streams using reaction resolvers.
   * @param query - The query filter (e.g., by stream, event name, or starting point).
   * @returns The leases of newly correlated streams, and the last seen event ID.
   */
  async correlate(
    query: Query = { after: -1, limit: 10 }
  ): Promise<{ leased: Lease[]; last_id: number }> {
    const correlated = new Map<string, ReactionPayload<E>[]>();
    let last_id = query.after || -1;
    await store().query<E>((event) => {
      last_id = event.id;
      const register = this.registry.events[event.name];
      // skip events with no registered reactions
      if (register) {
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
    }, query);
    if (correlated.size) {
      const leases = [...correlated.entries()].map(([stream, payloads]) => ({
        stream,
        // TODO: by convention, the first defined source wins (this can be tricky)
        source: payloads.find((p) => p.source)?.source || undefined,
        by: randomUUID(),
        at: 0,
        retry: 0,
        payloads,
      }));
      // register leases with 0ms lease timeout (just to tag the new streams)
      const leased = await store().lease(leases, 0);
      leased.length && tracer.correlated(leased);
      return { leased, last_id };
    }
    return { leased: [], last_id };
  }

  /**
   * Starts correlation worker that identifies and registers new streams using reaction resolvers.
   *
   * Enables "dynamic reactions", allowing streams to be auto-discovered based on event content.
   * - Uses a correlation sliding window over the event stream to identify new streams.
   * - Once registered, these streams are picked up by the main `drain` loop.
   * - Users should have full control over their correlation strategy.
   * - The starting point keeps increasing with each new batch of events.
   * - Users are responsible for storing the last seen event ID.
   *
   * @param query - The query filter (e.g., by stream, event name, or starting point).
   * @param frequency - The frequency of correlation checks (in milliseconds).
   * @param callback - Callback to report stats (new strems, last seen event ID, etc.).
   * @returns true if the correlation worker started, false otherwise (already started).
   */
  start_correlations(
    query: Query = {},
    frequency = 10_000,
    callback?: (leased: Lease[]) => void
  ): boolean {
    if (this._correlation_interval) return false;

    const limit = query.limit || 100;
    let after = query.after || -1;
    this._correlation_interval = setInterval(
      () =>
        this.correlate({ ...query, after, limit })
          .then((result) => {
            after = result.last_id;
            if (callback && result.leased.length) callback(result.leased);
          })
          .catch(console.error),
      frequency
    );
    return true;
  }

  stop_correlations() {
    if (this._correlation_interval) {
      clearInterval(this._correlation_interval);
      this._correlation_interval = undefined;
    }
  }
}
