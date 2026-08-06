import type { QueryStreams, Store, StreamPosition } from "../types/index.js";

/** Streams read per page when walking the whole table. */
export const DEFAULT_STREAM_PAGE = 500;

/**
 * Walks EVERY stream matching `query`, paging with the keyset cursor.
 *
 * `Store.query_streams` defaults to `limit: 100`, so a caller that wants
 * the whole table must page — passing no query silently truncates at the
 * first page, which is a false all-clear for anything that reports on
 * what it found.
 *
 * The cursor is the last stream name the callback saw; results are
 * ordered by stream name, so a short page means the walk is done.
 *
 * @param store - Store to walk.
 * @param callback - Invoked once per matching position, in name order.
 * @param query - Optional filter. A caller-supplied `limit` sets the page
 *   size (the walk still visits every match); `after` seeds the cursor.
 * @returns The total number of positions emitted.
 *
 * @internal
 */
export async function walk_streams(
  store: Store,
  callback: (position: StreamPosition) => void,
  query?: Omit<QueryStreams, "after" | "limit"> & {
    after?: string;
    limit?: number;
  }
): Promise<number> {
  const page_size = query?.limit ?? DEFAULT_STREAM_PAGE;
  let after = query?.after;
  let total = 0;
  for (;;) {
    let last: string | undefined;
    const { count } = await store.query_streams(
      (position) => {
        last = position.stream;
        callback(position);
      },
      { ...query, after, limit: page_size }
    );
    total += count;
    if (count < page_size) return total;
    after = last;
  }
}
