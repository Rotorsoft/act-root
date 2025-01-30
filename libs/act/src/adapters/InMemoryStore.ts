import type { Event, Store } from "../types";
import { ConcurrencyError } from "../types/errors";

/**
 * @category Adapters
 * @remarks In-memory event store
 */
export function InMemoryStore(): Store {
  const _events: Event[] = [];

  return {
    name: "InMemoryStore",

    dispose: () => {
      _events.length = 0;
      return Promise.resolve();
    },

    seed: () => Promise.resolve(),

    drop: () => {
      _events.length = 0;
      return Promise.resolve();
    },

    query: (callback, query) => {
      const {
        stream,
        names,
        before,
        after = -1,
        limit,
        created_before,
        created_after,
        actor,
        correlation
      } = query || {};
      let i = after + 1,
        count = 0;
      while (i < _events.length) {
        const e = _events[i++];
        if (stream && e.stream !== stream) continue;
        if (actor && e.meta?.causation?.action?.actor?.id !== actor) continue;
        if (names && !names.includes(e.name)) continue;
        if (correlation && e.meta?.correlation !== correlation) continue;
        if (created_after && e.created <= created_after) continue;
        if (before && e.id >= before) break;
        if (created_before && e.created >= created_before) break;
        callback(e);
        count++;
        if (limit && count >= limit) break;
      }
      return Promise.resolve(count);
    },

    commit: (stream, events, metadata, expectedVersion) => {
      const instance = _events.filter((e) => e.stream === stream); // ignore state events, this is a production optimization
      if (expectedVersion && instance.length - 1 !== expectedVersion)
        throw new ConcurrencyError(
          instance.length - 1,
          events,
          expectedVersion
        );

      let version = instance.length;
      return Promise.resolve(
        events.map(({ name, data }) => {
          const committed: Event = {
            id: _events.length,
            stream,
            version,
            created: new Date(),
            name,
            data,
            meta: metadata
          };
          _events.push(committed);
          version++;
          return committed;
        })
      );
    }
  };
}
