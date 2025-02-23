import EventEmitter from "events";
import { logger, queuestore } from "../ports";
import type { EventRegister, Queue, Schemas } from "../types";
import { ValidationError } from "../types/errors";

interface DrainedArgs<E extends Schemas> {
  queue: Queue<E>;
  first?: number;
  last?: number;
}

export class Broker<E extends Schemas> {
  private _emitter = new EventEmitter();

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
    const { events, queues } = await queuestore().fetch<E>(
      this._register,
      this.drainLimit
    );
    if (events.length) {
      logger.trace(
        events
          .map(({ id, stream, name }) => ({ id, stream, name }))
          .reduce(
            (a, { id, stream, name }) => ({ ...a, [id]: { stream, name } }),
            {}
          ),
        "⚡️ fetch"
      );

      if (queues.length) {
        logger.trace(
          queues
            .map(({ stream, position }) => ({ stream, position }))
            .reduce(
              (a, { stream, position }) => ({ ...a, [stream]: position }),
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
    }

    this.drainLocked = false;
    return drained;
  }
}
