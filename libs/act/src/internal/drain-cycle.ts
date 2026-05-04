/**
 * @module drain-cycle
 * @category Internal
 *
 * Two layers of the drain pipeline:
 *
 * - {@link runDrainCycle} — pure function for one round-trip of
 *   claim → fetch → group → dispatch → ack/block. No orchestrator state.
 *   Reusable for property tests and standalone benchmarks.
 *
 * - {@link DrainController} — stateful driver that owns the armed flag,
 *   the concurrency lock, and the adaptive lag/lead ratio. Wraps
 *   `runDrainCycle` with the lifecycle decisions Act used to make inline.
 *
 * @internal
 */

import { randomUUID } from "crypto";
import type {
  BatchHandler,
  BlockedLease,
  Drain,
  DrainOptions,
  Fetch,
  Lease,
  Logger,
  ReactionPayload,
  Registry,
  SchemaRegister,
  Schemas,
} from "../types/index.js";
import { computeLagLeadRatio } from "./drain-ratio.js";
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
      // fetch() returns one entry per leased stream — fetchMap.get is
      // always defined here (asserted with `!`).
      const entry = fetchMap.get(lease.stream)!;
      // fast-forward watermark using fetched events or window max
      const at = entry.fetch.events.at(-1)?.id || fetch_window_at;
      const { payloads } = entry;
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

/**
 * Empty drain result returned when the controller short-circuits (not
 * armed, locked out by a concurrent caller, claim returned nothing,
 * cycle threw).
 *
 * @internal
 */
const EMPTY_DRAIN: Drain<Schemas> = {
  fetched: [],
  leased: [],
  acked: [],
  blocked: [],
};

/**
 * Dependencies the {@link DrainController} needs from the orchestrator.
 * The lifecycle event sinks (`onAcked` / `onBlocked`) are callbacks so
 * this module doesn't reach back into Act's emitter.
 *
 * @internal
 */
export type DrainControllerDeps<
  TEvents extends Schemas,
  TActions extends Schemas,
  TSchemaReg extends SchemaRegister<TActions>,
> = {
  readonly logger: Logger;
  readonly ops: DrainOps<TEvents>;
  readonly registry: Registry<TSchemaReg, TEvents, TActions>;
  readonly batchHandlers: Map<string, BatchHandler<TEvents>>;
  readonly handle: Handle<TEvents>;
  readonly handleBatch: HandleBatch<TEvents>;
  readonly onAcked: (acked: Lease[]) => void;
  readonly onBlocked: (blocked: BlockedLease[]) => void;
};

/**
 * Stateful driver around {@link runDrainCycle}. Owns:
 *
 * - `_armed`  — has any commit / reset / cold-start signaled work to do?
 * - `_locked` — concurrent-call guard (overlapping `drain()` calls return
 *               an empty result instead of running twice)
 * - `_ratio`  — adaptive lag-to-lead frontier split, updated per cycle
 *
 * The orchestrator owns commits, lifecycle emission, and `arm()` triggers
 * — the controller owns everything between those edges.
 *
 * @internal
 */
export class DrainController<
  TEvents extends Schemas,
  TActions extends Schemas,
  TSchemaReg extends SchemaRegister<TActions>,
> {
  private _armed = false;
  private _locked = false;
  private _ratio = 0.5;

  constructor(
    private readonly deps: DrainControllerDeps<TEvents, TActions, TSchemaReg>
  ) {}

  /**
   * Signal that a commit (or reset / cold-start) may have produced work.
   * Subsequent `drain()` calls will run the pipeline; once the pipeline
   * settles to no-progress, the controller disarms itself.
   */
  arm(): void {
    this._armed = true;
  }

  /** Read-only flag — true while a commit / reset is unprocessed. */
  get armed(): boolean {
    return this._armed;
  }

  /** Run one drain pass. Short-circuits when not armed or already running. */
  async drain({
    streamLimit = 10,
    eventLimit = 10,
    leaseMillis = 10_000,
  }: DrainOptions = {}): Promise<Drain<TEvents>> {
    if (!this._armed) return EMPTY_DRAIN as Drain<TEvents>;
    if (this._locked) return EMPTY_DRAIN as Drain<TEvents>;

    try {
      this._locked = true;
      const lagging = Math.ceil(streamLimit * this._ratio);
      const leading = streamLimit - lagging;

      const cycle = await runDrainCycle(
        this.deps.ops,
        this.deps.registry,
        this.deps.batchHandlers,
        this.deps.handle,
        this.deps.handleBatch,
        lagging,
        leading,
        eventLimit,
        leaseMillis
      );

      if (!cycle) {
        // claim() returned no leases — fully caught up
        this._armed = false;
        return EMPTY_DRAIN as Drain<TEvents>;
      }

      const { leased, fetched, handled, acked, blocked } = cycle;

      // Adapt next cycle's frontier split to where the pressure is.
      this._ratio = computeLagLeadRatio(handled, lagging, leading);

      if (acked.length) this.deps.onAcked(acked);
      if (blocked.length) this.deps.onBlocked(blocked);

      // Disarm only when fully caught up. Errors keep the flag set so
      // retries flow through the next drain.
      const hasErrors = handled.some(({ error }) => error);
      if (!acked.length && !blocked.length && !hasErrors) this._armed = false;

      return { fetched, leased, acked, blocked };
    } catch (error) {
      this.deps.logger.error(error);
      return EMPTY_DRAIN as Drain<TEvents>;
    } finally {
      this._locked = false;
    }
  }
}
