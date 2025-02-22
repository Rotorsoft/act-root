import EventEmitter from "events";
import { logger, queues, store } from "../ports";
import type {
  Committed,
  EventRegister,
  Queue,
  Reaction,
  Schemas,
} from "../types";
import { ValidationError } from "../types/errors";

interface DrainedArgs<E extends Schemas> {
  queue: Queue<E>;
  first?: number;
  last?: number;
}

export class Broker<E extends Schemas> {
  private _emitter = new EventEmitter();
  private _queues: Map<string, Queue<E>> = new Map();
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
    const unblocked = [...this._queues.values()].filter(
      (queue) => !queue.blocked
    );
    this._watermark = unblocked.length
      ? unblocked // start from the minimum position of all queues
          .reduce(
            (min, queue) => Math.min(min, queue.position),
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
   * Enqueues events by resolved correlated streams
   */
  private async correlate(
    event: Committed<E, keyof E>,
    reactions: Map<string, Reaction<E>>
  ) {
    const streams = new Set<string>();
    if (reactions.size) {
      for (const reaction of reactions.values()) {
        const stream =
          typeof reaction.resolver === "string"
            ? reaction.resolver
            : reaction.resolver(event);
        if (stream) {
          let queue = this._queues.get(stream);
          if (!queue) {
            queue = await queues().load("TODO", stream); // TODO: broker key
            this._queues.set(stream, queue);
          }
          !queue.blocked && queue.enqueue(event, reaction);
          streams.add(queue.stream);
        }
      }
    }
    return streams;
  }

  private async handle<E extends Schemas>(
    queue: Queue<E>,
    retry = 0
  ): Promise<{ queue: Queue<E>; first?: number; last?: number }> {
    const stream = queue.stream;
    let first: number | undefined;
    let last: number | undefined;

    retry > 0 &&
      logger.error(`Retrying stream ${stream}@${queue.position} (${retry}).`);
    while (queue.next) {
      const { event, handler, options } = queue.next;
      try {
        await handler(event, stream);
        if (await queue.ack(event.id)) {
          logger.trace({ stream, position: event.id }, "⚡️ ack");
          !first && (first = event.id);
          last = event.id;
        }
      } catch (error) {
        if (error instanceof ValidationError)
          logger.error({ stream, error }, error.message);
        else logger.error(error);

        if (retry < options.maxRetries) {
          setTimeout(
            () => this.handle(queue, retry + 1),
            options.retryDelayMs * (retry + 1)
          );
        } else if (options.blockOnError) {
          logger.error(`Blocking stream ${stream} after ${retry} retries.`);
          await queue.block();
        }
        break; // stop pushing after max retries
      }
    }
    return { queue, first, last };
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

      const uncorrelated = new Map<string, [Queue<E>, number]>();
      for (const event of events) {
        const reactions = this._register[event.name].reactions;
        const correlated = await this.correlate(event, reactions);
        for (const queue of this._queues.values())
          !correlated.has(queue.stream) &&
            uncorrelated.set(queue.stream, [queue, event.id]);
      }

      const queues = [...this._queues.values()].filter(
        (queue) => queue.size && !queue.blocked
      );
      if (queues.length) {
        logger.trace(
          queues
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
          queues.map((queue) => this.handle(queue))
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

      await Promise.all(
        // TODO: batch acks?
        uncorrelated.values().map(async ([queue, position]) => {
          if (queue.position < position) {
            if (await queue.ack(position, false))
              logger.trace({ stream: queue.stream, position }, "⚡️ move");
          }
        })
      ).catch((error) => logger.error(error));
    }

    this.drainLocked = false;
    return drained;
  }
}
