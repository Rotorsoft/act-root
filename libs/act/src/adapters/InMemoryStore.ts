import type {
  Committed,
  EventMeta,
  Lease,
  Message,
  Query,
  Schemas,
  Store,
} from "../types";
import { ConcurrencyError } from "../types/errors";
import { sleep } from "../utils";

class InMemoryStream {
  _at = -1;
  _retry = -1;
  _lease: Lease | undefined;
  _blocked = false;

  constructor(public readonly stream: string) {}

  lease(lease: Lease) {
    if (!this._blocked && lease.at > this._at) {
      this._lease = { ...lease, retry: this._retry + 1 };
      return this._lease;
    }
  }

  ack(lease: Lease) {
    if (this._lease && lease.at >= this._at) {
      this._at = lease.at;
      this._retry = lease.retry;
      this._blocked = lease.block;
      this._lease = undefined;
    }
  }
}

/**
 * @category Adapters
 * @remarks In-memory event store
 */
export class InMemoryStore implements Store {
  // stored events
  private _events: Committed<Schemas, keyof Schemas>[] = [];
  // stored stream positions and other metadata
  private _streams: Map<string, InMemoryStream> = new Map();

  async dispose() {
    await sleep();
    this._events.length = 0;
  }

  async seed() {
    await sleep();
  }

  async drop() {
    await sleep();
    this._events.length = 0;
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
      correlation,
    } = query || {};
    let i = after + 1,
      count = 0;
    while (i < this._events.length) {
      const e = this._events[i++];
      if (stream && e.stream !== stream) continue;
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
    const instance = this._events.filter((e) => e.stream === stream); // ignore state events, this is a production optimization
    if (expectedVersion && instance.length - 1 !== expectedVersion)
      throw new ConcurrencyError(
        instance.length - 1,
        msgs as Message<Schemas, keyof Schemas>[],
        expectedVersion
      );

    let version = instance.length;
    return msgs.map(({ name, data }) => {
      const committed: Committed<E, keyof E> = {
        id: this._events.length,
        stream,
        version,
        created: new Date(),
        name,
        data,
        meta,
      };
      this._events.push(committed as Committed<Schemas, keyof Schemas>);
      version++;
      return committed;
    });
  }

  /**
   * Fetches new events from stream watermarks
   */
  async fetch<E extends Schemas>(limit: number) {
    const streams = [...this._streams.values()]
      .filter((s) => !s._blocked)
      .sort((a, b) => a._at - b._at)
      .slice(0, limit);

    const after = streams.length
      ? streams.reduce(
          (min, s) => Math.min(min, s._at),
          Number.MAX_SAFE_INTEGER
        )
      : -1;

    const events: Committed<E, keyof E>[] = [];
    await this.query<E>((e) => events.push(e), { after, limit });
    return { streams: streams.map(({ stream }) => stream), events };
  }

  async lease(leases: Lease[]) {
    await sleep();
    leases.forEach((lease) => {
      const stream =
        this._streams.get(lease.stream) ||
        // store new correlations
        this._streams
          .set(lease.stream, new InMemoryStream(lease.stream))
          .get(lease.stream)!;
      stream.lease(lease);
    });
    return leases;
  }

  async ack(leases: Lease[]) {
    await sleep();
    leases.forEach((lease) => this._streams.get(lease.stream)?.ack(lease));
  }
}
