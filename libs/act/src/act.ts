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
 * Act is the main orchestrator for event-sourced state machines.
 * It manages actions, reactions, event streams, and provides APIs for loading, querying, and draining events.
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

  emit(event: "committed", args: SnapshotArgs): boolean;
  emit(event: "drained", args: Lease[]): boolean;
  emit(event: string, args: any): boolean {
    return this._emitter.emit(event, args);
  }

  on(event: "committed", listener: (args: SnapshotArgs) => void): this;
  on(event: "drained", listener: (args: Lease[]) => void): this;
  on(event: string, listener: (args: any) => void): this {
    this._emitter.on(event, listener);
    return this;
  }

  constructor(
    public readonly registry: Registry<S, E, A>,
    public readonly drainLimit: number
  ) {}

  /**
   * Executes an action and emits an event to be committed by the store.
   *
   * @template K The type of action to execute
   * @template T The type of target
   * @template P The type of payloads
   * @param action The action to execute
   * @param target The target of the action
   * @param payload The payload of the action
   * @param reactingTo The event that the action is reacting to
   * @param skipValidation Whether to skip validation
   * @returns The snapshot of the committed Event
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
   * Loads a snapshot of the state from the store.
   *
   * @template SX The type of state
   * @template EX The type of events
   * @template AX The type of actions
   * @param state The state to load
   * @param stream The stream to load
   * @param callback The callback to call with the snapshot
   * @returns The snapshot of the loaded state
   */
  async load<SX extends Schema, EX extends Schemas, AX extends Schemas>(
    state: State<SX, EX, AX>,
    stream: string,
    callback?: (snapshot: Snapshot<SX, EX>) => void
  ): Promise<Snapshot<SX, EX>> {
    return await es.load(state, stream, callback);
  }

  /**
   * Queries the store for events.
   *
   * @param query The query to execute
   * @param callback The callback to call with the events
   * @returns The query result
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
      logger.error(`Retrying ${stream}@${lease.at} (${lease.retry}).`);

    for (const reaction of reactions) {
      const { event, handler, options } = reaction;
      try {
        await handler(event, stream); // the actual reaction
        lease.at = event.id;
        lease.count = (lease.count || 0) + 1;
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
   * Drains events from the store.
   *
   * @returns The number of drained events
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
      for (const event of events)
        for (const reaction of this.registry.events[
          event.name
        ].reactions.values()) {
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
              else if (result.value.count) drained.push(result.value);
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
          .map(({ stream, at, retry, block, count: handled }) => ({
            stream,
            at,
            retry,
            block,
            handled,
          }))
          .reduce(
            (a, { stream, at, retry, block, handled }) => ({
              ...a,
              [stream]: { at, retry, block, handled },
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
