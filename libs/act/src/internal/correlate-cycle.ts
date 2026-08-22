/**
 * @module correlate-cycle
 * @category Internal
 *
 * Correlation — the discovery half of the correlate→drain pair. Owns the
 * lazy init (subscribe static targets, read cold-start watermark), the
 * scan that resolves each event to its target streams, and the periodic
 * timer that drives background discovery.
 *
 * The scan is also the **producer of the work mark** (#1487): every target
 * an event resolves to is subscribed with `correlated_at` = that event's
 * id, which is how `claim` answers "does this stream have work?" off the
 * subscription row instead of probing the event log.
 *
 * The Act orchestrator passes registry + classification (which static
 * targets to subscribe) at build time; everything past that lives here.
 *
 * @internal
 */

import { createHash, randomUUID } from "node:crypto";
import { log, store } from "../ports.js";
import type {
  EventRegister,
  Query,
  Registry,
  SchemaRegister,
  Schemas,
  SubscribeInput,
} from "../types/index.js";
import { is_literal_source } from "../utils.js";
import type { DrainOps } from "./drain.js";
import { LruMap } from "./lru-map.js";

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
 * Re-scanning already-correlated events is harmless: a re-issued
 * `subscribe` is an idempotent UPSERT and a re-issued mark never
 * regresses. The window bounds the one-time restart cost; steady-state
 * correlation still advances the checkpoint forward normally.
 *
 * @internal
 */
const DEFAULT_COLD_START_BACK_SCAN = 10_000;

/**
 * Default correlation lease duration (#1532).
 *
 * Bounds two opposing risks. Too short and a slow scan outruns its own lease,
 * letting a second worker scan the same range — which is merely the
 * duplication that exists without a lease at all, so it fails safe. Too long
 * and a crashed holder stalls discovery for that whole window, because
 * nothing raises marks while nobody holds the lease and nothing becomes
 * claimable. Seconds rather than minutes, for that reason.
 */
const DEFAULT_CORRELATION_LEASE_MS = 5_000;

/**
 * A stable identity for "which correlator is this?" (#1532).
 *
 * The correlation lease lets one worker scan on behalf of others, which is
 * only sound when they are interchangeable. Two processes running the same
 * application are; two different applications sharing one database are not —
 * leasing across those would let one starve the other, and its reactions
 * would silently stop.
 *
 * The key is every event name this correlator reacts to, each with the names
 * of the handlers registered for it. Event names alone would do if reacting
 * to an event implied doing the same thing with it, and it does not: two
 * applications can both react to `Placed` and resolve it to entirely
 * different targets, so a shared lease would mark one's targets and never the
 * other's. Handler names cost nothing — the registry already keys reactions
 * by them — and separate exactly that case.
 *
 * Sorted before hashing so identical workers agree regardless of declaration
 * order. Truncated to 32 hex characters: a collision means two applications
 * with identical event *and* handler names share a lease, and those are
 * interchangeable by construction.
 */
const registry_key = <TEvents extends Schemas>(
  events: EventRegister<TEvents>
): string => {
  const shape = Object.keys(events)
    .filter((name) => events[name].reactions.size > 0)
    .sort()
    .map((name) => [name, [...events[name].reactions.keys()].sort()]);
  return createHash("sha256")
    .update(JSON.stringify(shape))
    .digest("hex")
    .slice(0, 32);
};

/**
 * How many distinct pattern sources keep a compiled `RegExp` around. A
 * pattern source is declared on a resolver, so the live set is tiny; the
 * bound only guards a dynamic resolver that mints one per event.
 *
 * @internal
 */
const PATTERN_CACHE_SIZE = 32;

/**
 * Static resolver target collected at build time. Subscribed once during
 * init, then marked by every scan whose events resolve to it.
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
 * What a target was last subscribed at, remembered per target so a scan
 * knows what its subscription row already holds.
 *
 * `floor` guards priority upgrades (#1363): a resolution re-subscribes its
 * own priority/lane only when it beats the floor, and a static target sits
 * at `+Infinity` so a dynamic resolution never re-opens what the build-time
 * subscribe owns. `priority`/`lane` are what the row holds, re-sent
 * verbatim by a resolution that does *not* beat the floor — the work mark
 * rides `subscribe`, and `subscribe` writes lane unconditionally, so a
 * mark-carrying upsert has to carry the row's own lane to leave it alone.
 *
 * @internal
 */
type Subscription = {
  readonly floor: number;
  readonly priority: number;
  readonly lane: string | undefined;
};

/**
 * One target accumulated during a scan: the values to subscribe it with,
 * and the highest event id observed to resolve to it — its work mark,
 * `undefined` when no scanned event fell inside the target's fetch window.
 *
 * @internal
 */
type Correlated = {
  source: string | undefined;
  priority: number;
  lane: string | undefined;
  /** True when priority/lane came from a resolution that beat the floor. */
  upgraded: boolean;
  correlated_at: number | undefined;
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
  cd: DrainOps<TEvents>;
  max_subscribed_streams: number;
  run_scoped: <T>(fn: () => Promise<T>) => Promise<T>;
  on_init?: () => void;
  on_init_async?: () => Promise<void>;
  cold_start_back_scan?: number;
  lease_millis?: number;
};

export class CorrelateCycle<
  TSchemaReg extends SchemaRegister<TActions>,
  TEvents extends Schemas,
  TActions extends Schemas,
> {
  private _checkpoint = -1;
  private _initialized = false;
  /**
   * This worker's identity for the correlation lease (#1532). A per-instance
   * UUID, matching the drain's convention, so a renewal is recognised as the
   * same holder and a restarted process never inherits a stale claim.
   */
  private readonly _by = randomUUID();
  /** How long the correlation lease is taken for. */
  private readonly _lease_millis: number;
  /**
   * Which correlator this is. Computed once from the registry so identical
   * workers share a lease and unrelated applications never do.
   */
  private readonly _key: string;
  /**
   * Whether a scan might find anything. The drain has carried the same flag
   * since it was written — a commit raises it, an empty claim lowers it, and
   * a disarmed drain returns without touching the store. Correlate had no
   * equivalent, so a settle pass always scanned, including the final pass
   * whose only job is to confirm nothing changed (#1510).
   *
   * Starts armed: the log may already hold events this process has never
   * correlated, and only a scan can find out.
   */
  private _armed = true;
  /** In-flight init, memoized for single-flight and cleared on failure. */
  private _init_promise: Promise<void> | undefined;
  private _timer: ReturnType<typeof setInterval> | undefined = undefined;
  // target → what it was last subscribed at. Every scan re-subscribes the
  // targets it resolved (that is how the work mark lands), so this no longer
  // decides *whether* a target is sent — it decides *what* is sent with it:
  // a resolution raises priority/lane only when it beats the recorded floor,
  // and otherwise re-sends the row's own values so the mark changes nothing
  // else. See {@link Subscription}.
  private readonly _subscribed: LruMap<string, Subscription>;
  /** Compiled pattern sources, bounded by {@link PATTERN_CACHE_SIZE}. */
  private readonly _patterns = new LruMap<string, RegExp>(PATTERN_CACHE_SIZE);
  private readonly _registry: Registry<TSchemaReg, TEvents, TActions>;
  private readonly _static_targets: ReadonlyArray<StaticTarget>;
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
    cd,
    max_subscribed_streams,
    run_scoped,
    on_init,
    on_init_async,
    cold_start_back_scan = DEFAULT_COLD_START_BACK_SCAN,
    lease_millis = DEFAULT_CORRELATION_LEASE_MS,
  }: CorrelateCycleDeps<TSchemaReg, TEvents, TActions>) {
    this._lease_millis = lease_millis;
    this._key = registry_key(registry.events);
    this._subscribed = new LruMap(max_subscribed_streams);
    this._registry = registry;
    this._static_targets = static_targets;
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
   * Signal that a commit (local or remote) may have produced events this
   * process has not correlated. Cheap and idempotent — the orchestrator calls
   * it on every commit and every notification.
   */
  arm(): void {
    this._armed = true;
  }

  /**
   * Initialize correlation state on first call.
   * - Reads the durable correlate checkpoint (and max(at)) from the store,
   *   flooring a first boot at `watermark - back_scan` so an event
   *   committed-but-not-correlated before a crash is re-scanned on
   *   restart instead of skipped (ACT-1207)
   * - Subscribes static resolver targets (idempotent upsert)
   * - Populates the subscribed-streams LRU
   * - Fires `on_init` once (Act uses this to flag a cold-start drain)
   */
  async init(): Promise<void> {
    if (this._initialized) return;
    // Single-flight, but retryable: the promise is memoized so concurrent
    // callers (correlate, the settle loop, every lane worker) share one
    // run, and cleared on rejection so a transient store failure doesn't
    // latch. Setting a boolean before the await instead left every static
    // target unsubscribed for the process lifetime after one blip — the
    // reaction pipeline silently dead, with nothing in blocked_streams or
    // the audit to reveal it, because the subscription row never existed.
    if (!this._init_promise) {
      this._init_promise = this._run_init().catch((error) => {
        this._init_promise = undefined;
        throw error;
      });
    }
    await this._init_promise;
    this._initialized = true;
  }

  private async _run_init(): Promise<void> {
    const { watermark, correlated_at } = await store().subscribe([
      ...this._static_targets,
    ]);
    // Resume from the durable checkpoint when one exists (#1484). On a first
    // boot it sits at -1 and a full scan of an existing log would be
    // unbounded, so seed from the old heuristic: the watermark backed off by
    // a bounded window, which re-discovers the crash-window tail (an
    // uncorrelated event now below a busier stream's watermark). Never floor
    // below -1. After the first scan the checkpoint is exact and the
    // heuristic never runs again.
    //
    // Static-only apps take the same path since #1487: correlate scans for
    // every app now, because a target that is never scanned is a target that
    // is never marked.
    this._checkpoint =
      correlated_at >= 0
        ? correlated_at
        : Math.max(-1, watermark - this._cold_start_back_scan);
    this._on_init?.();
    for (const { stream, priority = 0, lane } of this._static_targets) {
      // floor +Infinity: a dynamic resolution's priority can never exceed it,
      // so a static target is never re-opened through the dynamic path
      // (#1363) — its priority/lane are owned by the build-time subscribe
      // above, and a scan that marks it re-sends exactly those values.
      this._subscribed.set(stream, {
        floor: Number.POSITIVE_INFINITY,
        priority,
        lane,
      });
    }
    // Cold-start defer re-seed (#1221) — after the static targets are
    // subscribed, so a walk of the streams table sees them.
    await this._on_init_async?.();
  }

  /**
   * Forget targets whose subscription rows no longer exist, so a later
   * scan can re-subscribe them.
   *
   * A full close deletes the closed stream's subscription row. The
   * in-process dedup would otherwise still believe the target is
   * subscribed and never re-issue `subscribe()`, silently stopping
   * delivery for any reaction whose target is named after the stream —
   * the documented per-aggregate shape `.to(e => ({target: e.stream}))`
   * makes those two namespaces collide by construction (#1398).
   *
   * Static targets are left alone: they are subscribed once at init and
   * recorded at +Infinity so the dynamic path never re-opens them.
   */
  forget_subscribed(streams: Iterable<string>): void {
    const statics = new Set(this._static_targets.map((t) => t.stream));
    for (const stream of streams) {
      if (!statics.has(stream)) this._subscribed.delete(stream);
    }
  }

  /**
   * Would an event from `stream` be fetched for a target subscribed with
   * `source`? The subscription's source is the filter `fetch` queries with
   * — literal names by equality, patterns compiled as a `RegExp` — so an
   * event outside it is not work for that target and must not mark it.
   * No source means the target consumes every stream.
   */
  private _in_fetch_window(
    source: string | undefined,
    stream: string
  ): boolean {
    if (source === undefined || source === stream) return true;
    if (is_literal_source(source)) return false;
    let pattern = this._patterns.get(source);
    if (!pattern) {
      pattern = new RegExp(source);
      this._patterns.set(source, pattern);
    }
    return pattern.test(stream);
  }

  /**
   * Scan the events past the checkpoint, resolve each to its target
   * streams, and record what it found through `cd.subscribe` — new dynamic
   * targets get registered, and every target an event resolved to gets its
   * **work mark** raised to that event's id (#1487).
   *
   * Both resolver kinds are walked. A static target is already subscribed
   * at init, but marking it is what makes it claimable without probing the
   * event log, so the scan runs for every app.
   */
  async correlate(
    query: Query = { after: -1, limit: 10 },
    /**
     * Whether to honour the correlation lease (#1532).
     *
     * True only on the automatic paths — the settle loop and the poller —
     * where the question is "should *someone* scan?" and one worker doing it
     * serves all of them.
     *
     * An explicit `app.correlate()` means "scan now", and silently no-oping
     * it because a peer holds the lease would be wrong rather than merely
     * surprising: `close` catches up by looping until the checkpoint moves,
     * so a blocked scan would make it give up and cap its prune at a stale
     * position — pruning far less than the retention window asked for, with
     * nothing to explain why.
     */
    lease = false
  ): Promise<{
    subscribed: number;
    last_id: number;
    marked: number;
    /** False when the pass was disarmed and returned without a store read. */
    scanned: boolean;
  }> {
    await this.init();

    // Nothing has happened since the last scan reached the end of the log, so
    // there is nothing to find (#1510).
    //
    // The flag only ever means "a local signal says there may be work" — a
    // commit through `do()`, or a `notify` from another process. It is
    // deliberately NOT a claim that the log is unchanged: a remote writer on a
    // store with no notify support leaves this process disarmed and stale.
    // `start_polling` exists for exactly that case and arms on every tick, so
    // the poller keeps its meaning ("I have no signal, go and look anyway").
    if (!this._armed)
      return {
        subscribed: 0,
        last_id: this._checkpoint,
        marked: 0,
        scanned: false,
      };

    // Only one worker per registry scans at a time (#1532). Each worker holds
    // its own in-memory checkpoint, so without this they all wake on the same
    // commit and each reads the whole range and writes the same marks —
    // measured at exactly W reads and W mark-writes per committed event for W
    // workers.
    //
    // The lease rides `subscribe`, the call correlate already makes to
    // persist its checkpoint, rather than a verb of its own. Asking with no
    // streams and no advance is a pure "may I scan?".
    //
    // The answer's checkpoint is deliberately ignored. Adopting it looks like
    // free catch-up and is not: the durable position is a floor shared with
    // every other correlator, so a worker that adopted it would start its
    // scan past events it had never read and never mark their targets. A
    // worker that takes over instead re-scans from its own position —
    // redundant, bounded by paging, idempotent, and correct. `init` remains
    // the only place the durable checkpoint seeds a local one, where the
    // cold-start back-scan window guards exactly this hazard.
    if (lease) {
      const { correlating } = await this._cd.subscribe([], undefined, {
        key: this._key,
        by: this._by,
        millis: this._lease_millis,
      });
      // `undefined` means the store does not implement leasing, so every
      // worker scans exactly as before.
      if (correlating === false)
        // Another worker with the same registry is scanning, so this one need
        // not. Stay armed: the work still needs doing, and this worker should
        // look again next pass rather than disarm and wait for an unrelated
        // commit to wake it.
        return {
          subscribed: 0,
          last_id: this._checkpoint,
          marked: 0,
          scanned: false,
        };
    }

    // Use checkpoint as floor, allow explicit query.after to override upward
    const after = Math.max(this._checkpoint, query.after || -1);
    const correlated = new Map<string, Correlated>();
    let last_id = after;
    await store().query<TEvents>(
      (event) => {
        last_id = event.id;
        const register = this._registry.events[event.name];
        // skip events with no registered reactions
        if (register) {
          for (const reaction of register.reactions.values()) {
            const resolved =
              typeof reaction.resolver === "function"
                ? reaction.resolver(event)
                : reaction.resolver;
            if (!resolved) continue;
            // Raise priority/lane only when this resolution beats what the
            // target was last subscribed at, so the store's `GREATEST` upsert
            // runs — the documented runtime `max()` invariant, which the
            // plain "already subscribed?" dedup silently froze at first
            // discovery (#1363). A never-seen target has no record, so its
            // first resolution always wins; a static target sits at +Infinity
            // and never does. Otherwise the row's own values ride along
            // unchanged, because the mark travels on the same upsert.
            const recorded = this._subscribed.get(resolved.target);
            const priority = resolved.priority ?? 0;
            const upgraded = !recorded || priority > recorded.floor;
            const carried = upgraded
              ? { priority, lane: resolved.lane }
              : { priority: recorded.priority, lane: recorded.lane };
            const entry = correlated.get(resolved.target) || {
              source: resolved.source,
              priority: carried.priority,
              lane: carried.lane,
              upgraded,
              correlated_at: undefined,
            };
            // Multiple reactions targeting the same stream within a
            // single correlate scan — keep the max priority, and carry the
            // winning reaction's lane so the highest-priority reaction sets
            // the lane (matches the subscribe-side `max()` invariant).
            if (carried.priority > entry.priority) {
              entry.priority = carried.priority;
              entry.lane = carried.lane;
              entry.upgraded = upgraded;
            }
            // The mark is an assertion about the log: only an event the
            // target's own fetch would return may raise it. Ids ascend
            // through the scan, so the last one wins.
            if (this._in_fetch_window(resolved.source, event.stream))
              entry.correlated_at = event.id;
            correlated.set(resolved.target, entry);
          }
        }
      },
      { ...query, after }
    );

    // A target rides the batch when it has something to say: a mark to
    // raise, or priority/lane to register. A re-seen target that this scan
    // found no work for (its source filtered every event out) says neither,
    // and is left alone.
    const streams: SubscribeInput[] = [];
    for (const [stream, entry] of correlated) {
      if (entry.upgraded || entry.correlated_at !== undefined)
        streams.push({
          stream,
          source: entry.source,
          priority: entry.priority,
          lane: entry.lane,
          correlated_at: entry.correlated_at,
        });
    }

    if (streams.length) {
      // Persist the read cursor with the targets this scan discovered
      // (#1484). Correlate is the only component that knows how far it has
      // read, and it is already making this call.
      const { subscribed } = await this._cd.subscribe(streams, last_id, {
        key: this._key,
        by: this._by,
        millis: this._lease_millis,
      });
      // Raising a mark is work becoming claimable, exactly like registering
      // a new target — the orchestrator arms on both (#1488). A target that
      // was already subscribed reports `subscribed: 0`, so arming on that
      // alone leaves freshly marked work sitting until an unrelated commit
      // wakes the lane.
      const marked = streams.filter(
        (entry) => entry.correlated_at !== undefined
      ).length;
      // Advance checkpoint only after subscribe succeeds
      this._checkpoint = last_id;
      // Record what each upgraded target was just subscribed at (the
      // within-scan max), so a later lower-or-equal resolution carries these
      // values forward and a strictly-higher one re-opens the guard (#1363).
      for (const { stream, priority, lane } of streams) {
        if (correlated.get(stream)?.upgraded)
          this._subscribed.set(stream, {
            floor: priority as number,
            priority: priority as number,
            lane,
          });
      }
      return { subscribed, last_id, marked, scanned: true };
    }
    // Nothing to subscribe — safe to advance. Disarm only here: this is the
    // branch where the scan resolved no target at all, which is what "the log
    // has nothing more for us" looks like. A scan that found something leaves
    // the flag up, so the next pass continues from the new checkpoint rather
    // than stopping mid-backlog.
    this._checkpoint = last_id;
    this._armed = false;
    return { subscribed: 0, last_id, marked: 0, scanned: true };
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
        this._run_scoped(() => {
          // Polling is the discovery path for commits this process never saw —
          // a remote writer on a store without `notify`. Arming each tick is
          // what keeps that true now that a scan can park itself (#1510).
          this.arm();
          // The poller is an automatic path, so it honours the lease: one
          // worker scanning on each tick serves every worker.
          return this.correlate(
            {
              ...query,
              after: this._checkpoint,
              limit,
            },
            true
          );
        })
          .then((result) => {
            if (callback && result.subscribed) callback(result.subscribed);
          })
          .catch((err) => log().error(err)),
      frequency
    );
    return true;
  }

  /** Stop the periodic correlation worker. Idempotent. */
  /**
   * Hand the correlation lease back early.
   *
   * There is no release verb on the port, deliberately — expiry is the only
   * path, which keeps a crash and a clean stop on the same code path. A
   * holder can still shorten its own lease, because re-acquiring as the same
   * holder renews, and renewing to a millisecond is a release in all but
   * name.
   *
   * Without this a worker that stops cleanly still blocks discovery for the
   * rest of its lease — invisible in a long-lived deployment, very visible
   * anywhere Acts are created and dropped inside one process.
   *
   * Best-effort: failing here costs the lease's remaining lifetime, which is
   * what would have happened had the process died instead.
   */
  async release_correlation(): Promise<void> {
    try {
      // Zero releases outright. A near-zero expiry would still refuse a
      // successor asking in the same instant, which reads as the handback
      // not having happened.
      await this._cd.subscribe([], undefined, {
        key: this._key,
        by: this._by,
        millis: 0,
      });
    } catch (error) {
      log().error(error);
    }
  }

  stop_polling(): void {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = undefined;
    }
  }
}
