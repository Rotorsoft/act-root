import EventEmitter from "events";
import { logger, store } from "../ports";
import type {
  Committed,
  EventRegister,
  Reaction,
  ReactionPayload,
  Schemas,
} from "../types";
import { ValidationError } from "../types/errors";
import { sleep } from "../utils";

/**
 * In memory cache of a correlated stream  (broker key, stream name)
 */
class CorrelatedStream<E extends Schemas> {
  private _position = -1;
  private _blocked = false;
  private _queue: ReactionPayload<E>[] = [];

  constructor(public readonly stream: string) {}

  get position() {
    return this._position;
  }
  set position(value: number) {
    this._position = value;
  }
  get size() {
    return this._queue.length;
  }
  get blocked() {
    return this._blocked;
  }
  get next() {
    return this._queue.at(0);
  }
  enqueue(reaction: Reaction<E>, event: Committed<E, keyof E>) {
    event.id > this._position &&
      this._queue.push({ ...reaction, event } as ReactionPayload<E>);
  }
  async handle() {
    if (this._blocked) return false;
    const payload = this._queue.at(0);
    if (!payload) return false;
    const { event, handler } = payload;
    await handler(event, this.stream);

    // TODO: port to atomically persist the watermark (ack) of this stream by broker key
    this._queue.shift();
    this._position = event.id;
    logger.trace({ stream: this.stream, position: this._position }, "⚡️ ack");
    return true;
  }
  // TODO: port to persist blocked state of this stream by broker key
  async block() {
    await sleep();
    this._blocked = true;
  }
}

interface DrainedArgs<E extends Schemas> {
  stream: CorrelatedStream<E>;
  first?: number;
  last?: number;
}

export class Broker<E extends Schemas> {
  private _emitter = new EventEmitter();
  private _streams: Map<string, CorrelatedStream<E>> = new Map();
  private _watermark = -1;

  emit(event: "drained", args: DrainedArgs<E>): boolean {
    return this._emitter.emit(event, args);
  }
  on(event: "drained", listener: (args: DrainedArgs<E>) => void): this {
    this._emitter.on(event, listener);
    return this;
  }

  constructor(
    private readonly _register: EventRegister<E>,
    readonly drainLimit: number
  ) {}

  /**
   * Loads events from the event store *after* the watermark
   */
  private async query() {
    const unblocked = [...this._streams.values()].filter((s) => !s.blocked);
    this._watermark = unblocked.length
      ? unblocked // start from the minimum position of all streams
          .reduce(
            (min, stream) => Math.min(min, stream.position),
            Number.MAX_SAFE_INTEGER
          )
      : this._watermark;
    const events = [] as Committed<E, keyof E>[];
    await store().query<E>((e) => events.push(e), {
      after: this._watermark,
      limit: this.drainLimit,
    });
    return events;
  }

  /**
   * Enqueues events into correlated streams.
   */
  private correlate(
    event: Committed<E, keyof E>,
    reactions: Map<string, Reaction<E>>
  ) {
    const streams = new Set<string>();
    if (reactions.size) {
      for (const reaction of reactions.values()) {
        const target =
          typeof reaction.resolver === "string"
            ? reaction.resolver
            : reaction.resolver(event);
        if (target) {
          let stream = this._streams.get(target);
          if (!stream) {
            // TODO: port to load stream from persistent store by broker key, stream name
            // - should we load all streams at once or lazily?
            stream = new CorrelatedStream(target);
            this._streams.set(target, stream);
          }
          !stream.blocked && stream.enqueue(reaction, event);
          streams.add(stream.stream);
        }
      }
    }
    return streams;
  }

  /**
   * Handles events in correlated streams
   */
  private async handle<E extends Schemas>(
    stream: CorrelatedStream<E>,
    retry = 0
  ): Promise<{ stream: CorrelatedStream<E>; first?: number; last?: number }> {
    let first: number | undefined;
    let last: number | undefined;

    retry > 0 &&
      logger.error(
        `Retrying stream ${stream.stream} @ ${stream.position} (${retry}).`
      );
    while (stream.next) {
      const { event, options } = stream.next;
      try {
        if (await stream.handle()) {
          !first && (first = event.id);
          last = event.id;
        }
      } catch (error) {
        if (error instanceof ValidationError)
          logger.error({ stream: stream.stream, error }, error.message);
        else logger.error(error);

        if (retry < options.maxRetries) {
          setTimeout(
            () => this.handle(stream, retry + 1),
            options.retryDelayMs * (retry + 1)
          );
        } else if (options.blockOnError) {
          logger.error(
            `Blocking stream ${stream.stream} after ${retry} retries.`
          );
          await stream.block();
        }
        break; // stop pushing after max retries
      }
    }
    return { stream, first, last };
  }

  private drainLocked = false;
  async drain(): Promise<number> {
    if (this.drainLocked) return 0;
    this.drainLocked = true;

    let drained = 0;
    const events = await this.query();
    if (events.length) {
      logger.trace(
        events
          .map(({ id, stream, name }) => ({ id, stream, name }))
          .reduce(
            (a, { id, stream, name }) => ({ ...a, [id]: { stream, name } }),
            {}
          ),
        "⚡️ pull"
      );

      const uncorrelated_positions = new Map<string, number>();
      for (const event of events) {
        const reactions = this._register[event.name].reactions;
        const correlated = this.correlate(event, reactions);
        for (const stream of this._streams.values())
          !correlated.has(stream.stream) &&
            uncorrelated_positions.set(stream.stream, event.id);
      }

      const streams = [...this._streams.values()].filter(
        (s) => s.size && !s.blocked
      );
      if (streams.length) {
        logger.trace(
          streams
            .map(({ stream, position, size }) => ({ stream, position, size }))
            .reduce(
              (a, { stream, position, size }) => ({
                ...a,
                [stream]: { position, size },
              }),
              {}
            ),
          "⚡️ drain"
        );

        await Promise.allSettled(
          streams.map((stream) => this.handle(stream))
        ).then(
          (promise) => {
            promise.forEach((result) => {
              if (result.status === "rejected") logger.error(result.reason);
              else if (result.value.first && result.value.last) {
                drained++;
                this.emit("drained", result.value);
              }
            });
          },
          (error) => logger.error(error)
        );
      }

      // TODO: port to update position of locally uncorrelated streams so that all move in sync
      // and the local watermark keeps moving
      uncorrelated_positions.entries().forEach(([stream, position]) => {
        const s = this._streams.get(stream)!;
        if (s.position < position) {
          s.position = position;
          logger.trace({ stream, position }, "⚡️ move");
        }
      });
    }

    this.drainLocked = false;
    return drained;
  }
}
