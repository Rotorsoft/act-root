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
import { DEFAULT_LANE, log, store } from "../ports.js";
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
import { report_once } from "./report-once.js";

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
 *
 * **This separates leases; it does not make the topology supported.** Two
 * applications over one store still share a single read cursor, and a key
 * with no row of its own is seeded from it — so the second application
 * resumes where the first had read to and never correlates what lies below
 * (#1581). One store belongs to one application; the split-stores recipe is
 * the migration. The key exists so that many processes of the *same*
 * application can hand the scan between them, which is the supported case.
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
 * Where the record lives decides whether the floor survives: dynamic
 * targets are unbounded and go in the evictable LRU, static targets are a
 * bounded build-time list and go in a plain map that never evicts (#1582).
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
  /**
   * Every lane a controller exists for — `"default"` plus each
   * `.withLane({name})`. Injected rather than derived: `internal/` receives
   * what it needs. A resolution naming anything outside this set has no
   * claimant, so correlate reroutes it here (#1564).
   */
  declared_lanes: ReadonlySet<string>;
  run_scoped: <T>(fn: () => Promise<T>) => Promise<T>;
  on_init?: () => void;
  on_init_async?: () => Promise<void>;
  cold_start_back_scan?: number;
  lease_millis?: number;
};

/**
 * A dynamic resolution named a lane no controller claims (#1564).
 *
 * Reroutes to `"default"` rather than skipping: the target is legitimate and
 * only its lane is wrong, so stranding the stream at watermark `-1` — where
 * no health surface can see it — loses work that the operator never asked to
 * lose. `"default"` is where the reaction would have run had the lane been
 * omitted, which makes this the smallest correction that keeps it running.
 *
 * Keyed on the reaction and the lane it named, not on the target it minted
 * (#1584). One typo in one `.to(fn)` reroutes every target that resolver
 * produces, and the documented per-aggregate shape produces one per
 * aggregate — the target belongs in the message as an example, never in the
 * key. A resolver computing its lane from the event still reports each
 * distinct bad name, because each is a separate thing to fix.
 */
function report_undeclared_lane(
  seen: Set<string>,
  handler: string,
  target: string,
  lane: string,
  declared: ReadonlySet<string>
): void {
  report_once(
    seen,
    `lane|${handler}|${lane}`,
    `Reaction "${handler}" resolved onto undeclared lane "${lane}" — for example target "${target}". ` +
      `Declared lanes: ${[...declared].map((l) => `"${l}"`).join(", ")}. ` +
      'No controller claims it, so the stream would never drain — running it on "default" instead. ' +
      "The equivalent static `.to({ lane })` is rejected at build; a dynamic resolver's lane is only knowable here."
  );
}

/**
 * Two resolutions disagreed on one target's lane (#1567).
 *
 * Reported, not corrected. The lane a target already carries is the one its
 * in-flight leases were taken under, so re-laning it mid-run would move a
 * stream out from under a worker holding it; re-laning is restart-driven by
 * design. What the operator loses meanwhile is lane discipline — the losing
 * reaction runs inside the winner's `leaseMillis` and `streamLimit` — and
 * under `onlyLanes` sharding, a process provisioned for the losing lane never
 * runs it at all.
 *
 * Keyed on the losing declaration — the reaction whose lane was dropped, and
 * the two lanes — with the target out of the key (#1584), because a resolver
 * mints one target per aggregate and a target-keyed report scales with the
 * aggregate count rather than with the number of things to fix.
 *
 * The winner is named by lane rather than by handler on purpose. Which side
 * wins is "first discovered", so the same pair can land either way on
 * different targets, and those are two different facts about the same
 * misdeclaration: an operator seeing only one of them would read the outcome
 * as deterministic. Keeping the orientation in the key reports both, and the
 * count stays bounded by the declarations, which is what #1584 asked for.
 * (The winning handler is not available here anyway — a lane carried over
 * from an earlier scan, or seeded by a static subscribe, has no handler
 * recorded against it.)
 */
function report_lane_conflict(
  seen: Set<string>,
  handler: string,
  target: string,
  kept: string,
  dropped: string
): void {
  report_once(
    seen,
    `conflict|${handler}|${kept}|${dropped}`,
    `Reaction "${handler}" resolved lane "${dropped}" for a stream already on "${kept}" — for example "${target}". ` +
      `These are conflicting lane assignments from two dynamic resolutions at equal priority. ` +
      `Keeping "${kept}", the lane it was first discovered on — re-laning a live stream would move it out from under a worker holding its lease. ` +
      `The reaction resolving "${dropped}" runs inside the "${kept}" lane's budget, and a process restricted to "${dropped}" via onlyLanes never runs it. ` +
      "The equivalent static declaration is rejected at build; align the resolvers, or split the target."
  );
}

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
   * When this worker's correlation lease runs out, as a local clock reading,
   * or 0 when it holds none.
   *
   * Asking the store on every pass costs a round trip that the holder — which
   * is the *only* worker in a single-node deployment, and the steady-state
   * one everywhere else — gains nothing from: it already knows the answer.
   * The act-sqlite perf gate caught that as a 1.5x regression on
   * correlate+drain, which is the shape an embedded app runs constantly.
   *
   * Believing this while the store disagrees is safe in the one direction it
   * can fail. A worker that scans without really holding the lease produces
   * the duplicate scan that existed before the lease, and the marks are
   * idempotent — so a stale belief costs work, never correctness.
   */
  private _lease_until = 0;
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
  // Dynamically discovered targets → what each was last subscribed at,
  // bounded by `maxSubscribedStreams`. The static half lives in
  // `_static_subscriptions` below, which is deliberately not evictable.
  //
  // Every scan re-subscribes the
  // targets it resolved (that is how the work mark lands), so this no longer
  // decides *whether* a target is sent — it decides *what* is sent with it:
  // a resolution raises priority/lane only when it beats the recorded floor,
  // and otherwise re-sends the row's own values so the mark changes nothing
  // else. See {@link Subscription}.
  private readonly _dynamic_subscriptions: LruMap<string, Subscription>;
  /**
   * What each static target was subscribed at by `init`. A plain map, never
   * evicted: the collection is the build-time `_static_targets` list, so it
   * is already bounded by the registry and costs nothing the registry does
   * not already hold.
   *
   * Keeping these out of the LRU is what makes the `+Infinity` floor an
   * invariant rather than a race (#1582). Sharing the bounded map meant a
   * churn of dynamic targets could evict a static record, and the next
   * dynamic resolution to that target found no record, took the
   * first-discovery branch, and re-subscribed the target with its own
   * priority and lane — silently re-laning a stream whose lane the
   * build-time subscribe owns, and starving it wherever `onlyLanes` had
   * provisioned a worker for the declared lane.
   */
  private readonly _static_subscriptions = new Map<string, Subscription>();
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
  /** Lanes a controller exists for. See {@link CorrelateCycleDeps}. */
  private readonly _declared_lanes: ReadonlySet<string>;
  /**
   * Offending declarations already reported, so a resolver firing for every
   * matching event reports once. Owned by the instance rather than the
   * module: `internal/` holds no module-level state.
   */
  private readonly _reported = new Set<string>();

  constructor({
    registry,
    static_targets,
    cd,
    max_subscribed_streams,
    declared_lanes,
    run_scoped,
    on_init,
    on_init_async,
    cold_start_back_scan = DEFAULT_COLD_START_BACK_SCAN,
    lease_millis = DEFAULT_CORRELATION_LEASE_MS,
  }: CorrelateCycleDeps<TSchemaReg, TEvents, TActions>) {
    this._lease_millis = lease_millis;
    this._key = registry_key(registry.events);
    this._dynamic_subscriptions = new LruMap(max_subscribed_streams);
    this._registry = registry;
    this._declared_lanes = declared_lanes;
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
      // Recorded outside the LRU so eviction can't take the floor with it
      // (#1582).
      this._static_subscriptions.set(stream, {
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
   * Static targets are left alone: their record lives in
   * `_static_subscriptions`, which this never touches, so they stay pinned
   * at +Infinity and the dynamic path never re-opens them.
   */
  forget_subscribed(streams: Iterable<string>): void {
    for (const stream of streams) this._dynamic_subscriptions.delete(stream);
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
    // Re-ask only when the lease is running out. Renewing at the halfway mark
    // leaves a full half-lease of slack for the call itself, so a holder never
    // lapses by asking too late.
    const now = Date.now();
    if (lease && now >= this._lease_until - this._lease_millis / 2) {
      const { correlating } = await this._cd.subscribe([], undefined, {
        key: this._key,
        by: this._by,
        millis: this._lease_millis,
      });
      this._lease_until = correlating ? now + this._lease_millis : 0;
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
            // A lane no controller claims has no claimant, so the stream
            // would sit at watermark -1 forever. Reroute to "default" and
            // say so (#1564) — the build-time guard sees only static lanes.
            let lane = resolved.lane;
            if (lane !== undefined && !this._declared_lanes.has(lane)) {
              report_undeclared_lane(
                this._reported,
                reaction.handler.name,
                resolved.target,
                lane,
                this._declared_lanes
              );
              lane = undefined;
            }
            // Raise priority/lane only when this resolution beats what the
            // target was last subscribed at, so the store's `GREATEST` upsert
            // runs — the documented runtime `max()` invariant, which the
            // plain "already subscribed?" dedup silently froze at first
            // discovery (#1363). A never-seen target has no record, so its
            // first resolution always wins; a static target sits at +Infinity
            // and never does. Otherwise the row's own values ride along
            // unchanged, because the mark travels on the same upsert.
            //
            // Statics are consulted first and from their own map: the LRU
            // can evict, and a missing record reads as never-seen (#1582).
            const recorded =
              this._static_subscriptions.get(resolved.target) ??
              this._dynamic_subscriptions.get(resolved.target);
            const priority = resolved.priority ?? 0;
            const upgraded = !recorded || priority > recorded.floor;
            const carried = upgraded
              ? { priority, lane }
              : { priority: recorded.priority, lane: recorded.lane };
            const entry = correlated.get(resolved.target) || {
              source: resolved.source,
              priority: carried.priority,
              lane: carried.lane,
              upgraded,
              correlated_at: undefined,
            };
            // Two resolutions wanting different lanes for one target, with
            // neither outranking the other, is what the build-time guard
            // rejects for static declarations (#1567). Priority still decides
            // below; this only reports the tie the operator can't otherwise
            // see. Compare against what this target already carries, whether
            // that came from an earlier reaction in this scan or a past one,
            // and against that same source's priority — a resolution that
            // beat the floor outranks what it found rather than tying with
            // itself.
            //
            // Both lanes are compared by their resolved name, exactly as the
            // static guard does (#1583): an omitted lane *is* the default
            // lane, and the default lane is what the subscription row ends up
            // holding, so an omitted lane against a declared one is a real
            // disagreement. A never-seen target holds no lane at all, which is
            // not the same as holding "default" — the record's existence is
            // what gates the report.
            const seen_in_scan = correlated.has(resolved.target);
            const held_lane =
              (seen_in_scan ? entry.lane : recorded?.lane) ?? DEFAULT_LANE;
            const held_priority = seen_in_scan
              ? entry.priority
              : recorded?.priority;
            const resolved_lane = lane ?? DEFAULT_LANE;
            if (held_priority === priority && held_lane !== resolved_lane)
              report_lane_conflict(
                this._reported,
                reaction.handler.name,
                resolved.target,
                held_lane,
                resolved_lane
              );
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
      // Carry the correlator only when this pass is actually leasing, so it
      // renews as a side effect of persisting what the scan found.
      //
      // An explicit `app.correlate()` does not lease, and must not pay for
      // one either: sending a correlator turns a single checkpoint UPDATE
      // into a keyed upsert plus a second write and a read. The act-sqlite
      // perf gate caught exactly that as a regression on correlate+drain,
      // which is the shape an embedded app runs constantly and which never
      // wanted a lease in the first place.
      const renewed_at = Date.now();
      const { subscribed, correlating } = await this._cd.subscribe(
        streams,
        last_id,
        lease
          ? { key: this._key, by: this._by, millis: this._lease_millis }
          : undefined
      );
      if (lease && correlating !== false)
        this._lease_until = renewed_at + this._lease_millis;
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
      // Only dynamic targets reach here — a static sits at +Infinity, so no
      // resolution to one is ever `upgraded`.
      for (const { stream, priority, lane } of streams) {
        if (correlated.get(stream)?.upgraded)
          this._dynamic_subscriptions.set(stream, {
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
      this._lease_until = 0;
      await this._cd.subscribe([], undefined, {
        key: this._key,
        by: this._by,
        millis: 0,
      });
    } catch (error) {
      // The handback is best-effort by construction: the lease carries its
      // own expiry, so failing here costs at most `_lease_millis` before a
      // successor can take over, and nothing is lost.
      //
      // `warn`, not `error`, and deliberately: this runs during shutdown,
      // where the store is at its most contended — a pool closing under it,
      // or, on a single-writer store like SQLite, another connection holding
      // the file. Nothing is lost and it self-heals, so it does not deserve
      // a severity operators routinely page on; a clean Ctrl-C would page
      // every time. It stays visible because a contended file is still worth
      // investigating (#1577).
      //
      // A plain message rather than an `Error`: the stack would point at
      // this catch, not at whatever holds the lock, so it is noise.
      log().warn(
        `Could not hand back the correlation lease during shutdown; it expires on its own within ${this._lease_millis}ms and correlation resumes normally after that. ` +
          "On a single-writer store this usually means another connection holds the database. " +
          `Cause: ${String(error)}`
      );
    }
  }

  stop_polling(): void {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = undefined;
    }
  }
}
