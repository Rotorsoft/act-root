import { randomUUID } from "crypto";
import EventEmitter from "events";
import * as es from "./event-sourcing.js";
import { logger, store } from "./ports.js";
import { ValidationError } from "./types/errors.js";
import type {
  Committed,
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

/**
 * Act is the main orchestrator for event-sourced state machines and workflows.
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
   * @param drainLimit The maximum number of events to drain per cycle
   */
  constructor(
    public readonly registry: Registry<S, E, A>,
    public readonly drainLimit: number
  ) {}

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
   * @param lease The lease to handle
   * @param reactions The reactions to handle
   * @returns The lease
   */
  private async handle(
    lease: Lease,
    reactions: ReactionPayload<E>[]
  ): Promise<Lease> {
    const stream = lease.stream;

    lease.retry > 0 &&
      logger.warn(`Retrying ${stream}@${lease.at} (${lease.retry}).`);

    for (const reaction of reactions) {
      const { event, handler, options } = reaction;
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
  async drain(): Promise<number> {
    if (this.drainLocked) return 0;
    this.drainLocked = true;

    const drained: Lease[] = [];
    const { streams, events } = await store().fetch<E>(this.drainLimit);

    if (events.length) {
      logger.trace(
        events
          .map(({ id, stream, name }) => ({ id, stream, name }))
          .reduce(
            (a, { id, stream, name }) => ({ ...a, [id]: { [stream]: name } }),
            {}
          ),
        "⚡️ fetch"
      );

      // correlate events to streams by reaction resolvers
      const resolved = new Set<string>(streams);
      const correlated = new Map<string, ReactionPayload<E>[]>();
      for (const event of events) {
        const register = this.registry.events[event.name];
        if (!register) continue; // skip events with no registered reactions
        for (const reaction of register.reactions.values()) {
          const stream =
            typeof reaction.resolver === "string"
              ? reaction.resolver
              : reaction.resolver(event);
          if (stream) {
            resolved.add(stream);
            (
              correlated.get(stream) || correlated.set(stream, []).get(stream)!
            ).push({ ...reaction, event: event });
          }
        }
      }

      // lease fetched & resolved streams to the position of the last fetched event
      const last = events.at(-1)!.id;
      const leases = [...resolved.values()].map((stream) => ({
        by: randomUUID(),
        stream,
        at: last,
        retry: 0,
        block: false,
      }));
      const leased = await store().lease(leases);
      logger.trace(
        leased
          .map(({ stream, at, retry }) => ({ stream, at, retry }))
          .reduce(
            (a, { stream, at, retry }) => ({ ...a, [stream]: { at, retry } }),
            {}
          ),
        "⚡️ lease"
      );

      const handling = leased
        .map((lease) => ({
          lease,
          reactions: correlated.get(lease.stream) || [],
        }))
        .filter(({ reactions }) => reactions.length);

      if (handling.length) {
        await Promise.allSettled(
          handling.map(({ lease, reactions }) => this.handle(lease, reactions))
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
      }

      // acknowledge leases
      await store().ack(leased);
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

    this.drainLocked = false;
    return drained.length;
  }
}
