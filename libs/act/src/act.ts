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

function traceLeased(leased: Lease[]) {
  const data = Object.fromEntries(
    leased.map(({ stream, at, retry }) => [stream, { at, retry }])
  );
  logger.trace(data, "⚡️ lease");
}

function traceAcked(leased: Lease[]) {
  const data = Object.fromEntries(
    leased.map(({ stream, at, retry, block, error }) => [
      stream,
      { at, retry, block, error },
    ])
  );
  logger.trace(data, "⚡️ ack");
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
 * - Register event listeners with `.on("committed", ...)` and `.on("drained", ...)` to react to lifecycle events.
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
   * @param event The event name ("committed" or "drained")
   * @param args The event payload
   * @returns true if the event had listeners, false otherwise
   */
  emit(event: "committed", args: Snapshot<S, E>[]): boolean;
  emit(event: "drained", args: Lease[]): boolean;
  emit(event: string, args: any): boolean {
    return this._emitter.emit(event, args);
  }

  /**
   * Register a listener for a lifecycle event ("committed" or "drained").
   *
   * @param event The event name
   * @param listener The callback function
   * @returns this (for chaining)
   */
  on(event: "committed", listener: (args: Snapshot<S, E>[]) => void): this;
  on(event: "drained", listener: (args: Lease[]) => void): this;
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
  off(event: "drained", listener: (args: Lease[]) => void): this;
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
      reactingTo as Committed<Schemas, keyof Schemas>,
      skipValidation
    );
    this.emit("committed", snapshots as Snapshot<S, E>[]);
    // fire and forget correlations
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
   * Identifies and registers new streams triggered by committed events using reaction resolvers.
   *
   * Enables "dynamic reactions", allowing streams to be auto-discovered based on event content.
   * Once registered, these streams will be picked up by the main `drain` loop.
   */
  async correlate<E extends Schemas>(events: Committed<E, keyof E>[]) {
    if (!events.length) return;
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
    const leases: Lease[] = [...correlated.entries()].map(
      ([stream, payloads]) => ({
        stream,
        // TODO: by convention, the first defined source wins (this can be tricky)
        source: payloads.find((p) => p.source)?.source || undefined,
        by: randomUUID(),
        payloads,
        at: 0,
        retry: 0,
        block: false,
      })
    );
    if (leases.length) {
      const leased = await store().lease(leases);
      traceLeased(leased);
    }
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
  ): Promise<Lease> {
    const stream = lease.stream;

    lease.retry > 0 &&
      logger.warn(`Retrying ${stream}@${lease.at} (${lease.retry}).`);

    for (const payload of payloads) {
      const { event, handler, options } = payload;
      try {
        await handler(event, stream); // the actual reaction
        lease.at = event.id;
      } catch (error) {
        lease.error = error;
        if (error instanceof ValidationError)
          logger.error({ stream, error }, error.message);
        else logger.error(error);

        if (lease.retry < options.maxRetries) lease.retry++;
        else if (options.blockOnError) {
          lease.block = true;
          logger.error(`Blocked ${stream} after ${lease.retry} retries.`);
        }
        break;
      }
    }
    return lease;
  }

  /**
   * Fetches new events from store according to the fetch options.
   * @param options - Fetch options.
   * @returns Fetched streams with next events to process.
   */
  private async fetch<E extends Schemas>(options: FetchOptions) {
    const polled = await store().poll(options.streamLimit);
    return Promise.all(
      polled.map(async ({ stream, source, at }) => {
        const events: Committed<E, keyof E>[] = [];
        await store().query<E>((e) => events.push(e), {
          stream: source,
          after: at,
          limit: options.eventLimit,
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
  async drain<E extends Schemas>(
    options: FetchOptions = { streamLimit: 10, eventLimit: 10 }
  ) {
    if (this.drainLocked) return 0;
    this.drainLocked = true;

    const fetch = await this.fetch<E>(options);
    traceFetch(fetch);

    const leases: Array<Lease & { payloads: ReactionPayload<E>[] }> = fetch.map(
      ({ stream, events }) => {
        const payloads: ReactionPayload<E>[] = events.flatMap((event) => {
          // @ts-expect-error indexed by key
          const register = this.registry.events[
            event.name
          ] as ReactionsRegister<E, keyof E>;
          if (!register) return [];
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
        return {
          stream,
          by: randomUUID(),
          payloads,
          at: events.at(-1)?.id || -1,
          retry: 0,
          block: false,
        };
      }
    );

    const drained: Lease[] = [];
    if (leases.length) {
      const leased = await store().lease(leases);
      traceLeased(leased);

      await Promise.allSettled(
        leases.map((lease) => this.handle(lease, lease.payloads))
      ).then(
        (promise) => {
          promise.forEach((result) => {
            if (result.status === "rejected") logger.error(result.reason);
            else if (!result.value.error) drained.push(result.value);
          });
        },
        (error) => logger.error(error)
      );
      drained.length && this.emit("drained", drained);

      await store().ack(leased);
      traceAcked(leased);
    }

    this.drainLocked = false;
    return drained.length;
  }
}
