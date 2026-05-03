/**
 * @module drain-cycle
 * @category Internal
 *
 * Pure drain-pipeline orchestration: one round-trip of claim → fetch →
 * group → dispatch → ack/block. The Act orchestrator owns the `_needs_drain`
 * / `_drain_locked` flags and the adaptive lag-to-lead ratio; everything
 * sequential between those state updates lives here.
 *
 * @internal
 */

import { randomUUID } from "crypto";
import type {
  BatchHandler,
  BlockedLease,
  Fetch,
  Lease,
  ReactionPayload,
  Registry,
  SchemaRegister,
  Schemas,
} from "../types/index.js";
import type { DrainOps } from "./drain.js";

/**
 * Outcome of processing a single leased stream — produced by Act's `handle`
 * / `handleBatch` dispatchers, consumed by `runDrainCycle` to drive ack/block.
 *
 * @internal
 */
export type HandleResult = Readonly<{
  lease: Lease;
  handled: number;
  at: number;
  error?: string;
  block?: boolean;
}>;

/**
 * Per-event reaction dispatcher signature (matches `Act.handle`).
 * @internal
 */
export type Handle<TEvents extends Schemas> = (
  lease: Lease,
  payloads: ReactionPayload<TEvents>[]
) => Promise<HandleResult>;

/**
 * Bulk reaction dispatcher signature (matches `Act.handleBatch`).
 * @internal
 */
export type HandleBatch<TEvents extends Schemas> = (
  lease: Lease,
  payloads: ReactionPayload<TEvents>[],
  batchHandler: BatchHandler<TEvents>
) => Promise<HandleResult>;

/**
 * One drain cycle's results. Returned by {@link runDrainCycle}; consumed by
 * `Act.drain()` to update lifecycle state, the lag/lead ratio, and emit the
 * `acked` / `blocked` lifecycle events.
 *
 * @internal
 */
export type DrainCycle<TEvents extends Schemas> = {
  readonly leased: Lease[];
  readonly fetched: Fetch<TEvents>;
  readonly handled: HandleResult[];
  readonly acked: Lease[];
  readonly blocked: BlockedLease[];
};

/**
 * Run one drain cycle: claim streams, fetch their events, dispatch
 * matching reactions, ack the successes, block the retries-exhausted.
 *
 * Returns `undefined` when nothing was claimed — caller can short-circuit
 * the rest of the drain pass.
 *
 * @internal
 */
export async function runDrainCycle<
  TEvents extends Schemas,
  TActions extends Schemas,
  TSchemaReg extends SchemaRegister<TActions>,
>(
  ops: DrainOps<TEvents>,
  registry: Registry<TSchemaReg, TEvents, TActions>,
  batchHandlers: Map<string, BatchHandler<TEvents>>,
  handle: Handle<TEvents>,
  handleBatch: HandleBatch<TEvents>,
  lagging: number,
  leading: number,
  eventLimit: number,
  leaseMillis: number
): Promise<DrainCycle<TEvents> | undefined> {
  // Atomically discover and lease streams (competing consumer pattern)
  const leased = await ops.claim(lagging, leading, randomUUID(), leaseMillis);
  if (!leased.length) return undefined;

  // Fetch events for each leased stream
  const fetched = await ops.fetch(leased, eventLimit);

  // Build a single index keyed by stream — collapses two passes
  // (payloadsMap build + per-lease fetched.find) into one Map lookup.
  type FetchEntry = (typeof fetched)[number];
  const fetchMap = new Map<
    string,
    { fetch: FetchEntry; payloads: ReactionPayload<TEvents>[] }
  >();

  // compute fetch window max event id
  const fetch_window_at = fetched.reduce(
    (max, { at, events }) => Math.max(max, events.at(-1)?.id || at),
    0
  );

  for (const f of fetched) {
    const { stream, events } = f;
    const payloads = events.flatMap((event) => {
      const register = registry.events[event.name];
      if (!register) return [];
      return [...register.reactions.values()]
        .filter((reaction) => {
          const resolved =
            typeof reaction.resolver === "function"
              ? reaction.resolver(event)
              : reaction.resolver;
          return resolved && resolved.target === stream;
        })
        .map((reaction) => ({ ...reaction, event }));
    });
    fetchMap.set(stream, { fetch: f, payloads });
  }

  const handled = await Promise.all(
    leased.map((lease) => {
      const entry = fetchMap.get(lease.stream);
      // fast-forward watermark using fetched events or window max
      const at = entry?.fetch.events.at(-1)?.id || fetch_window_at;
      const payloads = entry?.payloads ?? [];
      const batchHandler = batchHandlers.get(lease.stream);
      if (batchHandler && payloads.length > 0) {
        return handleBatch({ ...lease, at }, payloads, batchHandler);
      }
      return handle({ ...lease, at }, payloads);
    })
  );

  const acked = await ops.ack(
    handled
      .filter(({ error }) => !error)
      .map(({ at, lease }) => ({ ...lease, at }))
  );

  const blocked = await ops.block(
    handled
      .filter(({ block }) => block)
      .map(({ lease, error }) => ({ ...lease, error: error! }))
  );

  return { leased, fetched, handled, acked, blocked };
}
