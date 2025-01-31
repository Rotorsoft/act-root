import type {
  Committed,
  EventMeta,
  Message,
  Query,
  Schemas,
  Store,
} from "../types";
import { ConcurrencyError } from "../types/errors";
import { sleep } from "../utils";

/**
 * @category Adapters
 * @remarks In-memory event store
 */
export class InMemoryStore implements Store {
  private events: Committed<Schemas, keyof Schemas>[] = [];

  async dispose() {
    await sleep();
    this.events.length = 0;
  }

  async seed() {
    await sleep();
  }

  async drop() {
    await sleep();
    this.events.length = 0;
  }

  async query<E extends Schemas>(
    callback: (event: Committed<E, keyof E>) => void,
    query?: Query
  ) {
    await sleep();
    const {
      stream,
      names,
      before,
      after = -1,
      limit,
      created_before,
      created_after,
      actor,
      correlation,
    } = query || {};
    let i = after + 1,
      count = 0;
    while (i < this.events.length) {
      const e = this.events[i++];
      if (stream && e.stream !== stream) continue;
      if (actor && e.meta?.causation?.action?.actor?.id !== actor) continue;
      if (names && !names.includes(e.name)) continue;
      if (correlation && e.meta?.correlation !== correlation) continue;
      if (created_after && e.created <= created_after) continue;
      if (before && e.id >= before) break;
      if (created_before && e.created >= created_before) break;
      callback(e as Committed<E, keyof E>);
      count++;
      if (limit && count >= limit) break;
    }
    return count;
  }

  async commit<E extends Schemas>(
    stream: string,
    msgs: Message<E, keyof E>[],
    meta: EventMeta,
    expectedVersion?: number
  ) {
    await sleep();
    const instance = this.events.filter((e) => e.stream === stream); // ignore state events, this is a production optimization
    if (expectedVersion && instance.length - 1 !== expectedVersion)
      throw new ConcurrencyError(
        instance.length - 1,
        msgs as Message<Schemas, keyof Schemas>[],
        expectedVersion
      );

    let version = instance.length;
    return msgs.map(({ name, data }) => {
      const committed: Committed<E, keyof E> = {
        id: this.events.length,
        stream,
        version,
        created: new Date(),
        name,
        data,
        meta,
      };
      this.events.push(committed as Committed<Schemas, keyof Schemas>);
      version++;
      return committed;
    });
  }
}
