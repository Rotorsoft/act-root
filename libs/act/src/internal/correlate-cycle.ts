/**
 * @module correlate-cycle
 * @category Internal
 *
 * Correlation — the discovery half of the correlate→drain pair. Owns the
 * lazy init (subscribe static targets, read cold-start watermark), the
 * dynamic-resolver scan that registers new streams as events arrive, and
 * the periodic timer that drives background discovery.
 *
 * The Act orchestrator passes registry + classification (which static
 * targets to subscribe, whether any dynamic resolvers exist) at build
 * time; everything past that lives here.
 *
 * @internal
 */

import { LruSet } from "../lru-map.js";
import { log, store } from "../ports.js";
import type {
  Query,
  ReactionPayload,
  Registry,
  SchemaRegister,
  Schemas,
} from "../types/index.js";
import type { DrainOps } from "./drain.js";

/**
 * Static resolver target collected at build time. Subscribed once during
 * init; never re-evaluated.
 *
 * @property priority - Scheduling priority for the resolved target stream.
 *   Combined with peers via `max()` at build time when multiple reactions
 *   target the same stream — see `build-classify.ts`.
 *
 * @internal
 */
export type StaticTarget = {
  readonly stream: string;
  readonly source?: string;
  readonly priority?: number;
};

/**
 * Drives correlation for one Act instance. Owns the checkpoint, the
 * subscribed-streams LRU, and the periodic timer.
 *
 * @internal
 */
export class CorrelateCycle<
  TSchemaReg extends SchemaRegister<TActions>,
  TEvents extends Schemas,
  TActions extends Schemas,
> {
  private _checkpoint = -1;
  private _initialized = false;
  private _timer: ReturnType<typeof setInterval> | undefined = undefined;
  private readonly _subscribed: LruSet<string>;

  constructor(
    private readonly registry: Registry<TSchemaReg, TEvents, TActions>,
    private readonly staticTargets: ReadonlyArray<StaticTarget>,
    private readonly hasDynamicResolvers: boolean,
    private readonly cd: DrainOps<TEvents>,
    maxSubscribedStreams: number,
    private readonly onInit?: () => void
  ) {
    this._subscribed = new LruSet(maxSubscribedStreams);
  }

  /** Last correlated event id. */
  get checkpoint(): number {
    return this._checkpoint;
  }

  /**
   * Initialize correlation state on first call.
   * - Reads max(at) from store as cold-start checkpoint
   * - Subscribes static resolver targets (idempotent upsert)
   * - Populates the subscribed-streams LRU
   * - Fires `onInit` once (Act uses this to flag a cold-start drain)
   */
  async init(): Promise<void> {
    if (this._initialized) return;
    this._initialized = true;

    const { watermark } = await store().subscribe([...this.staticTargets]);
    this._checkpoint = watermark;
    this.onInit?.();
    for (const { stream } of this.staticTargets) {
      this._subscribed.add(stream);
    }
  }

  /**
   * Discover dynamic-resolver targets in the events past the checkpoint
   * and register any new streams via `cd.subscribe`. Static targets are
   * subscribed at init time, so this only walks dynamic resolvers.
   */
  async correlate(
    query: Query = { after: -1, limit: 10 }
  ): Promise<{ subscribed: number; last_id: number }> {
    await this.init();

    // No dynamic resolvers — nothing to discover
    if (!this.hasDynamicResolvers)
      return { subscribed: 0, last_id: this._checkpoint };

    // Use checkpoint as floor, allow explicit query.after to override upward
    const after = Math.max(this._checkpoint, query.after || -1);
    const correlated = new Map<
      string,
      {
        source?: string;
        priority: number;
        payloads: ReactionPayload<TEvents>[];
      }
    >();
    let last_id = after;
    await store().query<TEvents>(
      (event) => {
        last_id = event.id;
        const register = this.registry.events[event.name];
        // skip events with no registered reactions
        if (register) {
          for (const reaction of register.reactions.values()) {
            // only evaluate dynamic resolvers — statics are subscribed at init
            if (typeof reaction.resolver !== "function") continue;
            const resolved = reaction.resolver(event);
            if (resolved && !this._subscribed.has(resolved.target)) {
              const incomingPriority = resolved.priority ?? 0;
              const entry = correlated.get(resolved.target) || {
                source: resolved.source,
                priority: incomingPriority,
                payloads: [],
              };
              // Multiple reactions targeting the same stream within a
              // single correlate scan — keep the max priority so the
              // highest-priority reaction sets the lane (matches the
              // subscribe-side `max()` invariant).
              if (incomingPriority > entry.priority)
                entry.priority = incomingPriority;
              entry.payloads.push({
                ...reaction,
                source: resolved.source,
                event,
              });
              correlated.set(resolved.target, entry);
            }
          }
        }
      },
      { ...query, after }
    );

    if (correlated.size) {
      const streams = [...correlated.entries()].map(
        ([stream, { source, priority }]) => ({
          stream,
          source,
          priority,
        })
      );
      const { subscribed } = await this.cd.subscribe(streams);
      // Advance checkpoint only after subscribe succeeds
      this._checkpoint = last_id;
      if (subscribed) {
        // Track newly subscribed dynamic targets
        for (const { stream } of streams) {
          this._subscribed.add(stream);
        }
      }
      return { subscribed, last_id };
    }
    // No streams to subscribe — safe to advance
    this._checkpoint = last_id;
    return { subscribed: 0, last_id };
  }

  /**
   * Start a periodic correlation worker. Returns false if one is already
   * running. Errors from `correlate()` are routed through `log()` so they
   * land in the configured logger (the timer keeps running on failure).
   */
  startPolling(
    query: Query = {},
    frequency = 10_000,
    callback?: (subscribed: number) => void
  ): boolean {
    if (this._timer) return false;

    const limit = query.limit || 100;
    this._timer = setInterval(
      () =>
        this.correlate({ ...query, after: this._checkpoint, limit })
          .then((result) => {
            if (callback && result.subscribed) callback(result.subscribed);
          })
          .catch((err) => log().error(err)),
      frequency
    );
    return true;
  }

  /** Stop the periodic correlation worker. Idempotent. */
  stopPolling(): void {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = undefined;
    }
  }
}
