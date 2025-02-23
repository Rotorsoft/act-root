import { logger, store } from "../ports";
import type {
  Committed,
  EventRegister,
  Queue,
  QueueStore,
  Reaction,
  ReactionPayload,
  Schemas,
} from "../types";
import { sleep } from "../utils";

class InMemoryQueue<E extends Schemas> implements Queue<E> {
  private _position = -1;
  private _blocked = false;
  private _queue: ReactionPayload<E>[] = [];

  constructor(public readonly stream: string) {}

  get position() {
    return this._position;
  }
  get blocked() {
    return this._blocked;
  }
  get next() {
    return this._queue.at(0);
  }
  enqueue(event: Committed<E, keyof E>, reaction: Reaction<E>) {
    event.id > this._position && this._queue.push({ ...reaction, event });
  }
  async ack(position: number, dequeue = true) {
    await sleep();
    dequeue && this._queue.shift();
    this._position = position;
    return true;
  }
  async block() {
    await sleep();
    this._blocked = true;
    return true;
  }

  // to advance uncorrelated queues on fetches
  ff(position: number) {
    this._position = position;
  }
}

export class InMemoryQueueStore implements QueueStore {
  // represents persisted stream positions and other stats
  private _queues: Map<string, Queue<Schemas>> = new Map();
  private _watermark = -1;

  /**
   * Enqueues events by resolved correlated streams
   * - Queue stores implement their own correlated stream resolution strategies
   */
  private correlate<E extends Schemas>(
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
            queue = new InMemoryQueue(stream);
            this._queues.set(stream, queue);
          }
          !queue.blocked &&
            queue.enqueue(
              event as Committed<Schemas, keyof Schemas>,
              reaction as Reaction<Schemas>
            );
          streams.add(queue.stream);
        }
      }
    }
    return streams;
  }

  /**
   * Fetches events and correlated queues from the last watermark
   * - Queue stores can implement their own watermarking and prioritization strategies
   */
  async fetch<E extends Schemas>(register: EventRegister<E>, limit: number) {
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
      limit,
    });

    for (const event of events) {
      const reactions = register[event.name].reactions;
      const correlated = this.correlate(event, reactions);

      // TODO: this could be tricky, how to sync uncorrelated queues on fetches?
      // - without this in-memory watermaks won't advance
      for (const queue of this._queues.values())
        if (!correlated.has(queue.stream)) {
          if (queue.position < event.id) {
            (queue as InMemoryQueue<E>).ff(event.id);
            logger.trace(
              { stream: queue.stream, position: event.id },
              "⚡️ >>"
            );
          }
        }
    }
    const queues = [...this._queues.values()]
      .filter((queue) => queue.next && !queue.blocked)
      .map((queue) => queue as Queue<E>);

    return { events, queues };
  }

  async dispose() {
    await sleep();
  }
}
