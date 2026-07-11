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

import { log, store } from "../ports.js";
import type {
  Query,
  ReactionPayload,
  Registry,
  SchemaRegister,
  Schemas,
} from "../types/index.js";
import type { DrainOps } from "./drain.js";
import { LruSet } from "./lru-map.js";

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
  readonly lane?: string;
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
  private readonly _registry: Registry<TSchemaReg, TEvents, TActions>;
  private readonly _static_targets: ReadonlyArray<StaticTarget>;
  private readonly _has_dynamic_resolvers: boolean;
  private readonly _cd: DrainOps<TEvents>;
  private readonly _on_init: (() => void) | undefined;
  /**
   * Async cold-start hook (#1221). Runs once, after the sync `on_init`,
   * inside the same `init()` await. The orchestrator uses it to re-seed the
   * process-local defer timers from the store's persisted `deferred_at` so
   * an idle deferred stream re-arms its drain across a restart. Kept
   * separate from `on_init` because seeding is an async store read; `init`
   * already awaits, so folding it in here preserves the "runs exactly once"
   * guarantee without a second gate on the Act side.
   */
  private readonly _on_init_async: (() => Promise<void>) | undefined;
  /**
   * Scope runner (#1191). The periodic `start_polling` timer fires
   * outside any caller frame, so its `correlate()` must be re-wrapped in
   * the Act's `_scoped` bag or `store()`/`cache()` resolve to the
   * singleton for a scoped Act. The orchestrator always threads its
   * `_scoped` (identity for a non-scoped Act), so it's required.
   */
  private readonly _run_scoped: <T>(fn: () => Promise<T>) => Promise<T>;

  constructor(
    registry: Registry<TSchemaReg, TEvents, TActions>,
    static_targets: ReadonlyArray<StaticTarget>,
    has_dynamic_resolvers: boolean,
    cd: DrainOps<TEvents>,
    maxSubscribedStreams: number,
    on_init: (() => void) | undefined,
    run_scoped: <T>(fn: () => Promise<T>) => Promise<T>,
    on_init_async?: () => Promise<void>
  ) {
    this._subscribed = new LruSet(maxSubscribedStreams);
    this._registry = registry;
    this._static_targets = static_targets;
    this._has_dynamic_resolvers = has_dynamic_resolvers;
    this._cd = cd;
    this._on_init = on_init;
    this._run_scoped = run_scoped;
    this._on_init_async = on_init_async;
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
   * - Fires `on_init` once (Act uses this to flag a cold-start drain)
   */
  async init(): Promise<void> {
    if (this._initialized) return;
    this._initialized = true;

    const { watermark } = await store().subscribe([...this._static_targets]);
    this._checkpoint = watermark;
    this._on_init?.();
    for (const { stream } of this._static_targets) {
      this._subscribed.add(stream);
    }
    // Cold-start defer re-seed (#1221) — after the static targets are
    // subscribed, so a walk of the streams table sees them.
    await this._on_init_async?.();
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
    if (!this._has_dynamic_resolvers)
      return { subscribed: 0, last_id: this._checkpoint };

    // Use checkpoint as floor, allow explicit query.after to override upward
    const after = Math.max(this._checkpoint, query.after || -1);
    const correlated = new Map<
      string,
      {
        source?: string;
        priority: number;
        lane?: string;
        payloads: ReactionPayload<TEvents>[];
      }
    >();
    let last_id = after;
    await store().query<TEvents>(
      (event) => {
        last_id = event.id;
        const register = this._registry.events[event.name];
        // skip events with no registered reactions
        if (register) {
          for (const reaction of register.reactions.values()) {
            // only evaluate dynamic resolvers — statics are subscribed at init
            if (typeof reaction.resolver !== "function") continue;
            const resolved = reaction.resolver(event);
            if (resolved && !this._subscribed.has(resolved.target)) {
              const incoming_priority = resolved.priority ?? 0;
              const entry = correlated.get(resolved.target) || {
                source: resolved.source,
                priority: incoming_priority,
                lane: resolved.lane,
                payloads: [],
              };
              // Multiple reactions targeting the same stream within a
              // single correlate scan — keep the max priority so the
              // highest-priority reaction sets the lane (matches the
              // subscribe-side `max()` invariant).
              if (incoming_priority > entry.priority)
                entry.priority = incoming_priority;
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
        ([stream, { source, priority, lane }]) => ({
          stream,
          source,
          priority,
          lane,
        })
      );
      const { subscribed } = await this._cd.subscribe(streams);
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
  start_polling(
    query: Query = {},
    frequency = 10_000,
    callback?: (subscribed: number) => void
  ): boolean {
    if (this._timer) return false;

    const limit = query.limit || 100;
    this._timer = setInterval(
      () =>
        this._run_scoped(() =>
          this.correlate({ ...query, after: this._checkpoint, limit })
        )
          .then((result) => {
            if (callback && result.subscribed) callback(result.subscribed);
          })
          .catch((err) => log().error(err)),
      frequency
    );
    return true;
  }

  /** Stop the periodic correlation worker. Idempotent. */
  stop_polling(): void {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = undefined;
    }
  }
}
