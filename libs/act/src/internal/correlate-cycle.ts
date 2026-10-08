/**
 * @module correlate-cycle
 * @category Internal
 *
 * Correlation — the discovery half of the correlate→drain pair. Owns the
 * lazy init (subscribe static targets, read cold-start watermark) and the
 * scan that resolves each event to its target streams.
 *
 * The scan is also the **producer of the work mark**: every target
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
 * Cold-start back-scan window, used only when no durable checkpoint exists.
 * An event committed but not correlated before a crash can sit below the
 * store watermark (`max(at)`) once a busier stream has advanced, so the
 * first scan starts at `watermark - BACK_SCAN` to re-discover it.
 * Re-scanning correlated events is harmless: `subscribe` is an idempotent
 * upsert and a mark never regresses.
 *
 * @internal
 */
const DEFAULT_COLD_START_BACK_SCAN = 10_000;

/**
 * Default correlation lease duration. Too short and a slow scan outruns its
 * lease, so a second worker scans the same range (duplicate work, still
 * safe). Too long and a crashed holder stalls discovery for the whole lease.
 */
const DEFAULT_CORRELATION_LEASE_MS = 5_000;

/**
 * A stable identity for "which correlator is this?".
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
 * This separates leases; it does not make two applications over one store
 * supported. They still share one read cursor, so the second would never
 * correlate what the first had already read past. One store belongs to one
 * application (see the split-stores recipe).
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
 * `floor` guards priority upgrades: a resolution re-subscribes its
 * own priority/lane only when it beats the floor, and a static target sits
 * at `+Infinity` so a dynamic resolution never re-opens what the build-time
 * subscribe owns. `priority`/`lane` are what the row holds, re-sent
 * verbatim by a resolution that does *not* beat the floor, so the work mark
 * riding the same `subscribe` carries the row's own values rather than a
 * losing resolution's.
 *
 * This is an optimization, not the guarantee. A record can go missing —
 * eviction here, an empty map after a restart — and a missing record reads
 * as never-seen. What keeps a forgotten target on its lane is the store:
 * `subscribe` writes the lane only when the incoming priority is at or
 * above the stored one, the same max it merges priority with.
 *
 * Where the record lives decides whether the floor survives: dynamic
 * targets are unbounded and go in the evictable LRU, static targets are a
 * bounded build-time list and go in a plain map that never evicts.
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

/** Constructor dependencies for {@link CorrelateCycle}. */
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
   * claimant, so correlate reroutes it here.
   */
  declared_lanes: ReadonlySet<string>;
  on_init?: () => void;
  on_init_async?: () => Promise<void>;
  cold_start_back_scan?: number;
  lease_millis?: number;
};

/**
 * A dynamic resolution named a lane no controller claims.
 *
 * Reroutes to `"default"` rather than skipping: the target is legitimate and
 * only its lane is wrong, so stranding the stream at watermark `-1` — where
 * no health surface can see it — loses work that the operator never asked to
 * lose. `"default"` is where the reaction would have run had the lane been
 * omitted, which makes this the smallest correction that keeps it running.
 *
 * Reported once per reaction and lane name, not per target: a resolver
 * mints one target per aggregate, so the target is only an example in the
 * message.
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
 * Two resolutions disagreed on one target's lane.
 *
 * Reported, not corrected. The lane a target already carries is the one its
 * in-flight leases were taken under, so re-laning it mid-run would move a
 * stream out from under a worker holding it; re-laning is restart-driven by
 * design. What the operator loses meanwhile is lane discipline — the losing
 * reaction runs inside the winner's `leaseMillis` and `streamLimit` — and
 * under `onlyLanes` sharding, a process provisioned for the losing lane never
 * runs it at all.
 *
 * Reported once per losing reaction and lane pair, not per target. The
 * winner is "first discovered", so the same pair can land either way on
 * different targets; keeping the orientation in the key reports both.
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

/**
 * Drives correlation for one Act instance. Owns the checkpoint, the
 * correlation lease and the subscription records.
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
  /**
   * This worker's identity for the correlation lease. A per-instance
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
   * Cached so the holder doesn't ask the store on every pass. A stale belief
   * can only cause a duplicate scan, and marks are idempotent, so it costs
   * work, never correctness.
   */
  private _lease_until = 0;
  /**
   * Whether a scan might find anything, like the drain's flag: a commit or
   * notification raises it, a short page lowers it, and a disarmed scan
   * returns without touching the store.
   *
   * Starts armed: the log may already hold events this process has never
   * correlated, and only a scan can find out.
   */
  private _armed = true;
  /** In-flight init, memoized for single-flight and cleared on failure. */
  private _init_promise: Promise<void> | undefined;
  // Dynamically discovered targets → what each was last subscribed at,
  // bounded by `maxSubscribedStreams`. It decides *what* a scan sends with a
  // target: priority/lane only when the resolution beats the recorded floor,
  // otherwise the row's own values. See {@link Subscription}.
  private readonly _dynamic_subscriptions: LruMap<string, Subscription>;
  /**
   * What each static target was subscribed at by `init`. A plain map, never
   * evicted: the collection is the build-time `_static_targets` list, so it
   * is already bounded by the registry and costs nothing the registry does
   * not already hold.
   *
   * Kept out of the LRU so eviction can never drop a static target's
   * `+Infinity` floor and let a dynamic resolution re-lane it.
   */
  private readonly _static_subscriptions = new Map<string, Subscription>();
  /** Compiled pattern sources, bounded by {@link PATTERN_CACHE_SIZE}. */
  private readonly _patterns = new LruMap<string, RegExp>(PATTERN_CACHE_SIZE);
  private readonly _registry: Registry<TSchemaReg, TEvents, TActions>;
  private readonly _static_targets: ReadonlyArray<StaticTarget>;
  private readonly _cd: DrainOps<TEvents>;
  private readonly _on_init: (() => void) | undefined;
  /**
   * Async cold-start hook, run once after `on_init` inside `init()`. The
   * orchestrator re-seeds its defer timers from the persisted `deferred_at`
   * here, so an idle deferred stream re-arms across a restart.
   */
  private readonly _on_init_async: (() => Promise<void>) | undefined;
  /**
   * Tail re-scan window applied to the cold-start checkpoint.
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
   *   restart instead of skipped
   * - Subscribes static resolver targets (idempotent upsert)
   * - Populates the subscribed-streams LRU
   * - Fires `on_init` once (Act uses this to flag a cold-start drain)
   */
  async init(): Promise<void> {
    if (this._initialized) return;
    // Single-flight but retryable: concurrent callers share one run, and a
    // failure clears the promise so the next call tries again instead of
    // leaving static targets unsubscribed for the process lifetime.
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
    const { watermark, correlated_at } = await this._cd.subscribe([
      ...this._static_targets,
    ]);
    // Resume from the durable checkpoint. On a first boot it is -1 and a full
    // scan of an existing log would be unbounded, so start a bounded window
    // below the watermark instead (see DEFAULT_COLD_START_BACK_SCAN).
    this._checkpoint =
      correlated_at >= 0
        ? correlated_at
        : Math.max(-1, watermark - this._cold_start_back_scan);
    this._on_init?.();
    for (const { stream, priority = 0, lane } of this._static_targets) {
      // Floor +Infinity: no dynamic resolution can re-open a static target;
      // a scan that marks it re-sends the build-time priority/lane.
      this._static_subscriptions.set(stream, {
        floor: Number.POSITIVE_INFINITY,
        priority,
        lane,
      });
    }
    // Cold-start defer re-seed — after the static targets are
    // subscribed, so a walk of the streams table sees them.
    await this._on_init_async?.();
  }

  /**
   * Start correlation over after the event log was replaced wholesale
   * (`restore`). The restored log is renumbered from the start and its
   * subscription rows are gone, so the in-memory scan position and both
   * subscription records describe a log that no longer exists. Dropping them
   * and the init latch makes the next pass run cold-start again: static
   * targets are re-subscribed, the checkpoint is re-read from the store
   * (which `restore` reset), and dynamic targets are rediscovered by the
   * scan.
   */
  restart(): void {
    this._initialized = false;
    this._init_promise = undefined;
    this._checkpoint = -1;
    this._dynamic_subscriptions.clear();
    this._static_subscriptions.clear();
    this._armed = true;
  }

  /**
   * Forget dynamic targets whose subscription rows no longer exist (a full
   * close deletes the row), so a later scan re-subscribes them. Static
   * targets keep their records.
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
   * **work mark** raised to that event's id.
   *
   * Both resolver kinds are walked. A static target is already subscribed
   * at init, but marking it is what makes it claimable without probing the
   * event log, so the scan runs for every app.
   */
  async correlate(
    query: Query = { after: -1, limit: 10 },
    /**
     * Whether to honour the correlation lease.
     *
     * True only on the automatic paths — the settle loop and the poller —
     * where the question is "should *someone* scan?" and one worker doing it
     * serves all of them.
     *
     * An explicit `app.correlate()` means "scan now" and ignores the lease:
     * `close` catches up by looping until the checkpoint moves, and a
     * lease-blocked scan would cap its prune at a stale position.
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
    // there is nothing to find.
    //
    // The flag means "a local signal says there may be work", not "the log
    // is unchanged": a remote writer on a store without notify leaves this
    // process disarmed, which is why the poller arms on every tick.
    if (!this._armed)
      return {
        subscribed: 0,
        last_id: this._checkpoint,
        marked: 0,
        scanned: false,
      };

    // One worker per registry scans at a time; otherwise W workers each read
    // and mark every committed event. The lease rides `subscribe` (no streams,
    // no advance = "may I scan?"). The answer's checkpoint is ignored: it is a
    // floor shared by every correlator, and adopting it would skip events this
    // worker never read. Renew at the halfway mark so the holder never lapses.
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
    const found = await store().query<TEvents>(
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
            // say so — the build-time guard sees only static lanes.
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
            // target was last subscribed at (the runtime `max()` rule); a
            // never-seen target always wins, a static one never does.
            // Otherwise the row's own values ride along with the mark.
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
            // Report an equal-priority lane disagreement (the build-time guard
            // rejects the static equivalent). Compare against what the target
            // already carries, from this scan or a past one. An omitted lane
            // is "default"; a never-seen target holds no lane at all.
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
      // Decline the sensitive payload: the scan only needs name/stream/id,
      // and one undecryptable row would otherwise stop every stream's
      // reactions. Resolvers therefore see `pii: null`; correlate runs
      // actor-less, so plaintext here would be un-gated disclosure.
      { ...query, after, with_pii: false }
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
      // Persist the read cursor with the targets found. Send the correlator
      // only when leasing, so it renews for free; an explicit
      // `app.correlate()` keeps the cheaper single checkpoint update.
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
      // A raised mark makes work claimable just like a new target, so the
      // orchestrator arms on both (`subscribed` alone misses re-marks).
      const marked = streams.filter(
        (entry) => entry.correlated_at !== undefined
      ).length;
      // Advance checkpoint only after subscribe succeeds
      this._checkpoint = last_id;
      // Record what each upgraded target was just subscribed at (the
      // within-scan max), so a later lower-or-equal resolution carries these
      // values forward and a strictly-higher one re-opens the guard.
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
    // Nothing to subscribe — safe to advance. Only a short page proves the
    // log is exhausted; resolving no target does not.
    this._checkpoint = last_id;
    this._armed = found === query.limit;
    return { subscribed: 0, last_id, marked: 0, scanned: true };
  }

  /**
   * Hand the correlation lease back early.
   *
   * The port has no release verb; re-acquiring as the same holder with a
   * zero duration releases it. Best-effort: a failure costs the lease's
   * remaining lifetime, as a crash would.
   */
  async release_correlation(): Promise<void> {
    try {
      this._lease_until = 0;
      await this._cd.subscribe([], undefined, {
        key: this._key,
        by: this._by,
        millis: 0,
      });
    } catch (error) {
      // `warn`, not `error`: this runs during shutdown, nothing is lost, and
      // the lease expires on its own.
      log().warn(
        `Could not hand back the correlation lease during shutdown; it expires on its own within ${this._lease_millis}ms and correlation resumes normally after that. ` +
          "On a single-writer store this usually means another connection holds the database. " +
          `Cause: ${String(error)}`
      );
    }
  }
}
