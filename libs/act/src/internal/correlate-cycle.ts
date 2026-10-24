/**
 * Correlation, the discovery half of correlate→drain: resolves each event to
 * its target streams and raises each target's work mark (`correlated_at`),
 * which is what `claim` reads. See docs/architecture/correlation-and-drain.
 */

import { createHash, randomUUID } from "node:crypto";
import { log, store } from "../ports.js";
import type {
  EventRegister,
  Query,
  Registry,
  Resolved,
  SchemaRegister,
  Schemas,
  StreamPosition,
  SubscribeInput,
} from "../types/index.js";
import { DEFAULT_LANE } from "../types/index.js";
import { is_literal_source } from "../utils.js";
import type { DrainOps } from "./drain-ops.js";
import { LruMap } from "./lru-map.js";
import { report_once } from "./report-once.js";

/**
 * First-boot scan starts this far below the watermark, so an event committed
 * but not correlated before a crash is found again. Re-scanning is harmless:
 * `subscribe` is an idempotent upsert and a mark never regresses.
 */
const COLD_START_BACK_SCAN = 10_000;

/**
 * Too short and a slow scan outruns its lease (duplicate work, still safe);
 * too long and a crashed holder stalls discovery.
 */
const CORRELATION_LEASE_MS = 5_000;

/**
 * The correlation lease key: a hash of every reacted-to event name with its
 * handler names, so only interchangeable workers share a lease. See
 * docs/architecture/correlation-and-drain § The correlation lease.
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
 * One correlate pass. An `idle` pass read nothing it keeps (it was
 * disarmed, refused the lease, or discarded its read), so it is no
 * evidence the store is up; a `scanned` pass read the log.
 */
export type CorrelatePass =
  | { readonly kind: "idle"; readonly last_id: number }
  | {
      readonly kind: "scanned";
      readonly last_id: number;
      /** Targets newly subscribed. */
      readonly subscribed: number;
      /** Targets whose work mark was raised. */
      readonly marked: number;
      /** It read events: settle's progress signal. */
      readonly read: boolean;
    };

/** Bound on compiled pattern sources; guards a resolver that mints one per event. */
const PATTERN_CACHE_SIZE = 32;

/** Static resolver target collected at build time and subscribed at init. */
export type StaticTarget = {
  readonly stream: string;
  readonly source?: string;
  readonly priority?: number;
  readonly lane?: string;
};

/**
 * What a target's subscription row holds. A resolution sends its own
 * priority/lane only when it beats `floor` (`+Infinity` for static targets);
 * otherwise it re-sends these values with the mark. The store owns the lane;
 * this only caches it, so a missing record is re-read from the row.
 */
type Subscription = {
  readonly floor: number;
  readonly priority: number;
  readonly lane: string | undefined;
};

/** One target accumulated during a scan; `correlated_at` is its work mark. */
type Correlated = {
  source: string | undefined;
  priority: number;
  lane: string | undefined;
  /** True when priority/lane came from a resolution that beat the floor. */
  upgraded: boolean;
  /** True when the target had no record, so its row must be read. */
  missed: boolean;
  /** The reaction whose resolution set priority/lane. */
  handler: string;
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
  /** Every lane a controller exists for; others are rerouted to default. */
  declared_lanes: ReadonlySet<string>;
  /** Set when `onlyLanes` leaves a lane out; each shard gets its own lease. */
  shard?: ReadonlyArray<string>;
  /** Runs once at the end of init: arms the lanes and re-seeds defer timers across a restart. */
  on_init?: () => Promise<void>;
};

/**
 * A dynamic resolution named an undeclared lane. Rerouted to `"default"`
 * rather than skipped, so the work still runs. Reported once per reaction
 * and lane, since a resolver mints one target per aggregate.
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
 * Two resolutions disagreed on one target's lane. Reported, not corrected:
 * re-laning a live stream would move it out from under a lease holder.
 * Keyed by orientation, since "first discovered" can land either way.
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

/** Drives correlation for one Act: the checkpoint, the lease, the subscription records. */
export class CorrelateCycle<
  TSchemaReg extends SchemaRegister<TActions>,
  TEvents extends Schemas,
  TActions extends Schemas,
> {
  private _checkpoint = -1;
  /** Lease holder id; per instance, so a restart never inherits a stale claim. */
  private readonly _by = randomUUID();
  private readonly _key: string;
  /** Local expiry of the held lease (0 = none); stale only costs a duplicate scan. */
  private _lease_until = 0;
  /**
   * Armed while `_raised` (bumped by a commit or notification) is ahead of
   * `_lowered` (the raise count the last short page saw). Starts armed.
   */
  private _raised = 1;
  private _lowered = 0;
  /**
   * Bumped by a release (shutdown), so a scan or lease reply that was out
   * across one writes nothing.
   */
  private _epoch = 0;
  /** Passes in flight: a restore waits for them, and refuses new ones. */
  private readonly _passes = new Set<Promise<CorrelatePass>>();
  private _restoring = false;
  private _init_promise: Promise<void> | undefined;
  // Bounded by `maxSubscribedStreams`; static records live apart so eviction
  // never drops their +Infinity floor.
  private readonly _dynamic_subscriptions: LruMap<string, Subscription>;
  private readonly _static_subscriptions = new Map<string, Subscription>();
  private readonly _patterns = new LruMap<string, RegExp>(PATTERN_CACHE_SIZE);
  private readonly _registry: Registry<TSchemaReg, TEvents, TActions>;
  private readonly _static_targets: ReadonlyArray<StaticTarget>;
  private readonly _cd: DrainOps<TEvents>;
  private readonly _on_init: (() => Promise<void>) | undefined;
  private readonly _declared_lanes: ReadonlySet<string>;
  /** Report-once keys; per instance because `internal/` holds no module state. */
  private readonly _reported = new Set<string>();

  constructor({
    registry,
    static_targets,
    cd,
    max_subscribed_streams,
    declared_lanes,
    shard,
    on_init,
  }: CorrelateCycleDeps<TSchemaReg, TEvents, TActions>) {
    this._key = shard
      ? `${registry_key(registry.events)}:${[...shard].sort().join(",")}`
      : registry_key(registry.events);
    this._dynamic_subscriptions = new LruMap(max_subscribed_streams);
    this._registry = registry;
    this._declared_lanes = declared_lanes;
    this._static_targets = static_targets;
    this._cd = cd;
    this._on_init = on_init;
  }

  get checkpoint(): number {
    return this._checkpoint;
  }

  /** A commit (local or remote) may have produced uncorrelated events. */
  arm(): void {
    this._raised++;
  }

  private async _init(): Promise<void> {
    // Single-flight, but a failure clears the promise so the next call retries.
    this._init_promise ??= this._run_init().catch((error) => {
      this._init_promise = undefined;
      throw error;
    });
    await this._init_promise;
  }

  private async _run_init(): Promise<void> {
    const { watermark, correlated_at } = await this._cd.subscribe([
      ...this._static_targets,
    ]);
    this._checkpoint =
      correlated_at >= 0
        ? correlated_at
        : Math.max(-1, watermark - COLD_START_BACK_SCAN);
    for (const { stream, priority = 0, lane } of this._static_targets) {
      this._static_subscriptions.set(stream, {
        floor: Number.POSITIVE_INFINITY,
        priority,
        lane,
      });
    }
    // After the static subscribe, so the streams walk sees them.
    await this._on_init?.();
  }

  /**
   * Replace the log with no pass in flight, then cold-start: a pass that
   * read the old log writes before the restore, never into the new one.
   */
  async restart(restore: () => Promise<void>): Promise<void> {
    this._restoring = true;
    try {
      await Promise.allSettled(this._passes);
      await restore();
    } finally {
      this._restoring = false;
    }
    this._init_promise = undefined;
    this._checkpoint = -1;
    this._dynamic_subscriptions.clear();
    this._static_subscriptions.clear();
  }

  /** Forget dynamic targets whose rows a full close deleted, so they re-subscribe. */
  forget_subscribed(streams: Iterable<string>): void {
    for (const stream of streams) this._dynamic_subscriptions.delete(stream);
  }

  /** Would the target's own `fetch` (filtered by `source`) return this event? */
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

  /** Scan past the checkpoint, subscribe new targets and raise their work marks. */
  async correlate(
    query: Query,
    /**
     * Honour the correlation lease. Only the settle loop and poller do; an
     * explicit `app.correlate()` scans now, since `close` loops on it.
     */
    lease = false
  ): Promise<CorrelatePass> {
    if (this._restoring) return { kind: "idle", last_id: this._checkpoint };
    const pass = this._scan(query, lease);
    this._passes.add(pass);
    try {
      return await pass;
    } finally {
      this._passes.delete(pass);
    }
  }

  private async _scan(query: Query, lease: boolean): Promise<CorrelatePass> {
    await this._init();
    const epoch = this._epoch;
    const idle = (): CorrelatePass => ({
      kind: "idle",
      last_id: this._checkpoint,
    });

    // A remote writer without notify leaves this disarmed; the poller re-arms.
    if (this._raised === this._lowered) return idle();

    const raised = this._raised;

    // The lease rides `subscribe` with no streams ("may I scan?"). Its shared
    // checkpoint is ignored: adopting it would skip events this worker never
    // read. Renew at the halfway mark.
    const now = Date.now();
    if (lease && now >= this._lease_until - CORRELATION_LEASE_MS / 2) {
      const { correlating } = await this._cd.subscribe([], undefined, {
        key: this._key,
        by: this._by,
        millis: CORRELATION_LEASE_MS,
      });
      // A release that landed while the call was out (shutdown) stays
      // released: the reply must not hand the lease back to this worker.
      if (this._epoch !== epoch) return idle();
      this._lease_until = correlating ? now + CORRELATION_LEASE_MS : 0;
      // `undefined` = store without leasing. Refused: stay armed, look again.
      if (correlating === false) return idle();
    }

    // One checkpoint serves every reaction, so the scan reads only `limit`:
    // a filter would move it past events the filter skipped.
    const after = this._checkpoint;
    const correlated = new Map<string, Correlated>();
    let last_id = after;
    // A resolver threw: the scan stops before that event, so the next one
    // retries it and nothing past it is lost.
    let stopped = false;
    const found = await store().query<TEvents>(
      (event) => {
        if (stopped) return;
        const register = this._registry.events[event.name];
        if (register) {
          for (const reaction of register.reactions.values()) {
            let resolved: Resolved | undefined;
            try {
              resolved =
                typeof reaction.resolver === "function"
                  ? reaction.resolver(event)
                  : reaction.resolver;
            } catch (error) {
              stopped = true;
              report_once(
                this._reported,
                `resolver|${reaction.handler.name}|${event.id}`,
                `Resolver of reaction "${reaction.handler.name}" threw on ${String(event.name)} #${event.id} (stream "${event.stream}"): ${String(error)}. ` +
                  "Correlation stops before this event until the resolver stops throwing; work already found keeps draining."
              );
              return;
            }
            if (!resolved) continue;
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
              missed: !recorded,
              handler: reaction.handler.name,
              correlated_at: undefined,
            };
            // Compare against what the target already carries, from this
            // scan or a past one.
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
            // Within one scan the highest priority sets the lane.
            if (carried.priority > entry.priority) {
              entry.priority = carried.priority;
              entry.lane = carried.lane;
              entry.upgraded = upgraded;
              entry.handler = reaction.handler.name;
            }
            if (this._in_fetch_window(resolved.source, event.stream))
              entry.correlated_at = event.id;
            correlated.set(resolved.target, entry);
          }
        }
        last_id = event.id;
      },
      // Resolvers see `pii: null`: correlate runs actor-less, and one
      // undecryptable row would otherwise stop every stream's reactions.
      { after, limit: query.limit, with_pii: false }
    );

    if (this._declared_lanes.size > 1) await this._recall(correlated);
    const read = last_id > after;

    // Released while the scan was out: what it read belongs to a lease this
    // worker gave up, and writing it would take the lease back.
    if (this._epoch !== epoch) return idle();

    // Only targets with a mark to raise or priority/lane to register.
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
      // Leasing renews for free on the same call.
      const renewed_at = Date.now();
      const { subscribed, correlating } = await this._cd.subscribe(
        streams,
        last_id,
        lease
          ? { key: this._key, by: this._by, millis: CORRELATION_LEASE_MS }
          : undefined
      );
      if (lease && correlating !== false)
        this._lease_until = renewed_at + CORRELATION_LEASE_MS;
      // The orchestrator arms on re-marks too, not just new subscriptions.
      const marked = streams.filter(
        (entry) => entry.correlated_at !== undefined
      ).length;
      this._checkpoint = last_id;
      // Only dynamic targets can be upgraded (statics sit at +Infinity).
      for (const { stream, priority, lane } of streams) {
        if (correlated.get(stream)?.upgraded)
          this._dynamic_subscriptions.set(stream, {
            floor: priority as number,
            priority: priority as number,
            lane,
          });
      }
      return { kind: "scanned", last_id, subscribed, marked, read };
    }
    // Only a short page proves the log is exhausted; resolving nothing does
    // not. It lowers only the raises it saw, so one that landed mid-scan
    // keeps the cycle armed.
    this._checkpoint = last_id;
    if (!stopped && found !== query.limit) this._lowered = raised;
    return { kind: "scanned", last_id, subscribed: 0, marked: 0, read };
  }

  /**
   * Read the row of each target this scan had no record of (new or evicted),
   * so a resolution that doesn't beat its priority keeps the row's lane.
   * Only called with more than one lane declared.
   */
  private async _recall(correlated: Map<string, Correlated>): Promise<void> {
    const missed = [...correlated].filter(([, entry]) => entry.missed);
    await Promise.all(
      missed.map(async ([stream, entry]) => {
        let row: StreamPosition | undefined;
        await store().query_streams(
          (position) => {
            row = position;
          },
          { stream, stream_exact: true, limit: 1 }
        );
        if (!row) return;
        this._dynamic_subscriptions.set(stream, {
          floor: row.priority,
          priority: row.priority,
          lane: row.lane,
        });
        if (entry.priority > row.priority) return;
        const held_lane = row.lane ?? DEFAULT_LANE;
        const resolved_lane = entry.lane ?? DEFAULT_LANE;
        if (entry.priority === row.priority && held_lane !== resolved_lane)
          report_lane_conflict(
            this._reported,
            entry.handler,
            stream,
            held_lane,
            resolved_lane
          );
        entry.priority = row.priority;
        entry.lane = row.lane;
        entry.upgraded = false;
      })
    );
  }

  /** Release the lease early by re-acquiring it for zero ms. Best-effort. */
  async release_correlation(): Promise<void> {
    try {
      this._lease_until = 0;
      this._epoch++;
      await this._cd.subscribe([], undefined, {
        key: this._key,
        by: this._by,
        millis: 0,
      });
    } catch (error) {
      log().warn(
        `Could not hand back the correlation lease during shutdown; it expires on its own within ${CORRELATION_LEASE_MS}ms and correlation resumes normally after that. ` +
          "On a single-writer store this usually means another connection holds the database. " +
          `Cause: ${String(error)}`
      );
    }
  }
}
