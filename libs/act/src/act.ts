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
  Registry,
  Schema,
  SchemaRegister,
  Schemas,
  Snapshot,
  State,
  Target,
} from "./types/index.js";

type SnapshotArgs = Snapshot<Schemas, Schema>;

function traceFetch<E extends Schemas>(fetch: Fetch<E>) {
  logger.trace(
    fetch.map(({ stream, events }) => ({
      stream,
      events: events
        .map(({ id, stream, name }) => ({ id, stream, name }))
        .reduce(
          (a, { id, stream, name }) => ({ ...a, [id]: { [stream]: name } }),
          {}
        ),
    })),
    "⚡️ fetch"
  );
}

function traceLeased(leased: Lease[]) {
  logger.trace(
    leased
      .map(({ stream, at, retry }) => ({ stream, at, retry }))
      .reduce(
        (a, { stream, at, retry }) => ({ ...a, [stream]: { at, retry } }),
        {}
      ),
    "⚡️ lease"
  );
}

function traceAcked(leased: Lease[]) {
  logger.trace(
    leased
      .map(({ stream, at, retry, block, error }) => ({
        stream,
        at,
        retry,
        block,
        error,
      }))
      .reduce(
        (a, { stream, at, retry, block, error }) => ({
          ...a,
          [stream]: { at, retry, block, error },
        }),
        {}
      ),
    "⚡️ ack"
  );
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
  emit(event: "committed", args: SnapshotArgs): boolean;
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
  on(event: "committed", listener: (args: SnapshotArgs) => void): this;
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
  off(event: "committed", listener: (args: SnapshotArgs) => void): this;
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
    const snapshot = await es.action(
      this.registry.actions[action],
      action,
      target,
      payload,
      reactingTo as Committed<Schemas, keyof Schemas>,
      skipValidation
    );
    this.emit("committed", snapshot as SnapshotArgs);
    return snapshot;
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
   * Handles leased reactions.
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
  async drain(options: FetchOptions = { streamLimit: 10, eventLimit: 10 }) {
    if (this.drainLocked) return 0;
    this.drainLocked = true;

    // nothing to handle yet
    const reactions = new Map<string, ReactionPayload<E>[]>();
    const leases: Array<Lease & { payloads: ReactionPayload<E>[] }> = [];
    // nothing drained yet
    const drained: Lease[] = [];

    // fetch unprocessed events
    const fetch = await store().fetch<E>(options);
    traceFetch(fetch);

    if (fetch.length === 1 && fetch[0].stream === "") {
      const events = fetch[0].events;
      // this is a forced fetch
      // try to correlate the events to new streams by reaction resolvers (dynamic reactions)
      for (const event of events) {
        const register = this.registry.events[event.name];
        if (!register) continue; // skip events with no registered reactions
        for (const reaction of register.reactions.values()) {
          const resolved =
            typeof reaction.resolver === "function"
              ? reaction.resolver(event)
              : reaction.resolver;
          resolved &&
            (
              reactions.get(resolved.output) ||
              reactions.set(resolved.output, []).get(resolved.output)!
            ).push({ ...reaction, input: resolved.input, event });
        }
      }
      if (reactions.size) {
        // found new correlations from fetched events!
        // prepare leases - at the last fetched event
        const last = events.at(-1)!.id;
        reactions.forEach((payloads, stream) => {
          // optimizate stream for future fetches when:
          // - stream resolver defines an input stream -> stream will always be correlated to the same input stream
          // - stream is always resolved statically -> no function resolver driven by event content, so we can map
          //   all reactions (event names) to a target stream
          const filter = { stream: undefined, names: undefined };
          // // TODO: make sure all reactions mapping to this stream have the same input stream
          // const input = inputs.size === 1 ? [...inputs.values()][0] : undefined;
          // // TODO: find all event names with reactions mapping to this stream
          // const names = undefined;
          leases.push({
            stream,
            by: randomUUID(),
            payloads,
            at: last,
            filter,
            retry: 0,
            block: false,
          });
        });
      }
    } else {
      // map existing streams with reactions to the fetched events
      // and prepare lease - at the last fetched event
      fetch.forEach(({ stream, events }) => {
        const payloads = events.flatMap((event) => {
          const register = this.registry.events[event.name];
          return [...register.reactions.values()]
            .filter((reaction) => {
              const resolved =
                typeof reaction.resolver === "function"
                  ? reaction.resolver(event)
                  : reaction.resolver;
              return resolved && resolved.output === stream;
            })
            .map((reaction) => ({ ...reaction, event }));
        });
        leases.push({
          stream,
          by: randomUUID(),
          payloads,
          at: events.at(-1)!.id,
          retry: 0,
          block: false,
        });
      });
    }

    // lease streams and handle reactions
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

      // acknowledge leases
      await store().ack(leased);
      traceAcked(leased);
    }

    this.drainLocked = false;
    return drained.length;
  }
}
