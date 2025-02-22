import type {
  Committed,
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

  constructor(
    public readonly broker: string,
    public readonly stream: string
  ) {}

  get position() {
    return this._position;
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
}

export class InMemoryQueueStore implements QueueStore {
  async load<E extends Schemas>(
    broker: string,
    stream: string
  ): Promise<Queue<E>> {
    await sleep();
    return new InMemoryQueue<E>(broker, stream);
  }

  async dispose() {
    await sleep();
  }
}
