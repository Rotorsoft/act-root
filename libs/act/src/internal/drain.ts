/**
 * @module drain
 * @category Internal
 *
 * Pipeline operations consumed by the drain/correlate loop. Each op is a
 * single async step the orchestrator invokes per drain cycle:
 *
 * - `claim` — atomically discover and lock streams for processing
 * - `fetch` — read events for each leased stream
 * - `ack` — release leases for successfully handled streams
 * - `block` — flag leases that exceeded the retry budget
 * - `subscribe` — register newly correlated streams with the store
 *
 * This module exposes only the bare implementations as plain async functions,
 * mirroring the shape of {@link "event-sourcing"}. Trace decoration is
 * layered on top in {@link "tracing"} and selected by the orchestrator at
 * construction time. No tracing imports here.
 *
 * @internal
 */

import { store } from "../ports.js";
import type {
  BlockedLease,
  Committed,
  Fetch,
  Lease,
  Schemas,
} from "../types/index.js";

/** @internal */
export interface DrainOps<TEvents extends Schemas> {
  claim: typeof claim;
  fetch: typeof fetch<TEvents>;
  ack: typeof ack;
  block: typeof block;
  subscribe: typeof subscribe;
}

export const claim = (
  lagging: number,
  leading: number,
  by: string,
  millis: number,
  lane?: string
): Promise<Lease[]> => store().claim(lagging, leading, by, millis, lane);

export async function fetch<TEvents extends Schemas>(
  leased: Lease[],
  eventLimit: number
): Promise<Fetch<TEvents>> {
  return Promise.all(
    leased.map(async ({ stream, source, at, lagging }) => {
      const events: Committed<TEvents, keyof TEvents>[] = [];
      await store().query<TEvents>((e) => events.push(e), {
        stream: source,
        after: at,
        limit: eventLimit,
      });
      return { stream, source, at, lagging, events } as const;
    })
  );
}

export const ack = (leases: Lease[]): Promise<Lease[]> => store().ack(leases);

export const block = (leases: BlockedLease[]): Promise<BlockedLease[]> =>
  store().block(leases);

export const subscribe = (
  streams: Array<{
    stream: string;
    source?: string;
    priority?: number;
    lane?: string;
  }>
): Promise<{ subscribed: number; watermark: number }> =>
  store().subscribe(streams);
