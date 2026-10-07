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
  SubscribeInput,
  SubscribeResult,
} from "../types/index.js";
import { is_literal_source } from "../utils.js";

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
      // A literal `source` fetches with `stream_exact` so an exact name
      // like "s1" reads only "s1" — never a sibling prefix "s12". A
      // pattern source (e.g. `^(A|B)$`) stays a regex query, matching the
      // same streams the has-work probe claimed it for.
      const stream_exact =
        source !== undefined && is_literal_source(source) ? true : undefined;
      try {
        await store().query<TEvents>((e) => events.push(e), {
          stream: source,
          stream_exact,
          after: at,
          limit: eventLimit,
        });
      } catch (error) {
        // Contain it per stream. These reads are already per-stream, but they
        // shared one `Promise.all`, so one stream's failure rejected the whole
        // cycle and every healthy stream leased beside it got nothing —
        // an unreadable `pii` payload on one aggregate stalled unrelated
        // reactions. The cycle turns this into a no-progress failure
        // for THIS stream only, which the retry budget then escalates.
        //
        // Unlike correlate, this read cannot simply decline the payload:
        // handlers receive it (through their own gate), so a fetch that
        // dropped it would hand them a silently incomplete event.
        return {
          stream,
          source,
          at,
          lagging,
          events: [],
          error: (error as Error)?.message ?? String(error),
        } as const;
      }
      return { stream, source, at, lagging, events } as const;
    })
  );
}

// Finalize: acks and defers in one atomic store call. Leases
// carrying `due` are deferred, the rest acked — a failed finalize lands
// nothing, and redelivery covers every outcome uniformly.
export const ack = (leases: Lease[]): Promise<Lease[]> => store().ack(leases);

export const block = (leases: BlockedLease[]): Promise<BlockedLease[]> =>
  store().block(leases);

export const subscribe = (
  streams: SubscribeInput[],
  correlated_at?: number,
  correlator?: { key: string; by: string; millis: number }
): Promise<SubscribeResult> =>
  store().subscribe(streams, correlated_at, correlator);
