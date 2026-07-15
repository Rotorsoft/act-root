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
 * Cold-start back-scan window (ACT-1207). On init the correlate cursor
 * would otherwise jump straight to the store watermark (`max(at)` across
 * every subscribed stream). A dynamic-resolver event committed but not
 * yet correlated before a crash sits *below* that watermark whenever a
 * busier stream has since advanced — so a plain `max(at)` cold start
 * skips it forever, and a one-shot dynamic target is never subscribed.
 *
 * Flooring the cold-start checkpoint at `watermark - BACK_SCAN` re-scans
 * the tail on restart so those in-flight events are re-discovered.
 * Re-scanning already-correlated events is harmless: `_subscribed`
 * dedups and `subscribe` is an idempotent UPSERT. The window bounds the
 * one-time restart cost; steady-state correlation still advances the
 * checkpoint forward normally.
 *
 * @internal
 */
const DEFAULT_COLD_START_BACK_SCAN = 10_000;

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
/**
 * Constructor dependencies for {@link CorrelateCycle}. A named bag rather
 * than a positional list: the trailing hooks (`on_init`, `on_init_async`)
 * plus `cold_start_back_scan` are all optional and easy to transpose
 * positionally, so callers pass them by name.
 */
export type CorrelateCycleDeps<
  TSchemaReg extends SchemaRegister<TActions>,
  TEvents extends Schemas,
  TActions extends Schemas,
> = {
  registry: Registry<TSchemaReg, TEvents, TActions>;
  static_targets: ReadonlyArray<StaticTarget>;
  has_dynamic_resolvers: boolean;
  cd: DrainOps<TEvents>;
  max_subscribed_streams: number;
  run_scoped: <T>(fn: () => Promise<T>) => Promise<T>;
  on_init?: () => void;
  on_init_async?: () => Promise<void>;
  cold_start_back_scan?: number;
};

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
  /**
   * Tail re-scan window applied to the cold-start checkpoint (ACT-1207).
   * See {@link DEFAULT_COLD_START_BACK_SCAN}. Constructor arg (not a
   * public option) so tests can shrink it; defaults otherwise.
   */
  private readonly _cold_start_back_scan: number;

  constructor({
    registry,
    static_targets,
    has_dynamic_resolvers,
    cd,
    max_subscribed_streams,
    run_scoped,
    on_init,
    on_init_async,
    cold_start_back_scan = DEFAULT_COLD_START_BACK_SCAN,
  }: CorrelateCycleDeps<TSchemaReg, TEvents, TActions>) {
    this._subscribed = new LruSet(max_subscribed_streams);
    this._registry = registry;
    this._static_targets = static_targets;
    this._has_dynamic_resolvers = has_dynamic_resolvers;
    this._cd = cd;
    this._on_init = on_init;
    this._run_scoped = run_scoped;
    this._on_init_async = on_init_async;
    this._cold_start_back_scan = cold_start_back_scan;
  }

  /** Last correlated event id. */
  get checkpoint(): number {
    return this._checkpoint;
  }

  /**
   * Initialize correlation state on first call.
   * - Reads max(at) from store, then floors the cold-start checkpoint at
   *   `watermark - back_scan` when dynamic resolvers exist, so an event
   *   committed-but-not-correlated before a crash is re-scanned on
   *   restart instead of skipped (ACT-1207)
   * - Subscribes static resolver targets (idempotent upsert)
   * - Populates the subscribed-streams LRU
   * - Fires `on_init` once (Act uses this to flag a cold-start drain)
   */
  async init(): Promise<void> {
    if (this._initialized) return;
    this._initialized = true;

    const { watermark } = await store().subscribe([...this._static_targets]);
    // Without dynamic resolvers correlate never scans, so the checkpoint
    // is inert — keep the plain `max(at)` cold start. With dynamic
    // resolvers, back the cursor off the watermark by a bounded window so
    // the crash-window tail (an uncorrelated event now below a busier
    // stream's watermark) is re-discovered. Never floor below -1.
    this._checkpoint = this._has_dynamic_resolvers
      ? Math.max(-1, watermark - this._cold_start_back_scan)
      : watermark;
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
              // single correlate scan — keep the max priority, and carry the
              // winning reaction's lane so the highest-priority reaction sets
              // the lane (matches the subscribe-side `max()` invariant).
              if (incoming_priority > entry.priority) {
                entry.priority = incoming_priority;
                entry.lane = resolved.lane;
              }
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
