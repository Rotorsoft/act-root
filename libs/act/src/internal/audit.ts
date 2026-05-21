/**
 * @module audit
 * @category Internal
 *
 * Operator-driven store audit (#723).
 *
 * Walks the connected store and yields per-category {@link AuditFinding}s.
 * Each category answers a different "what should I do with this store?"
 * question and pairs with a remediation:
 *
 *   - `schema` → fix the data model (poison events, unknown names)
 *   - `close-candidate` → `app.close([...])`
 *   - `restart-candidate` → `app.close([{stream, restart:true}, …])`
 *   - `deprecated-load` → `app.close([...])` on the heaviest carriers
 *   - `reaction-health` → `app.unblock(...)` / `app.reset(...)`
 *   - `snapshot-drift` → manual `load({snap:true})` or wait for policy
 *   - `routing-health` → restart-with-new-config to re-lane
 *   - `correlation-gaps` → fix upstream correlator misconfig
 *   - `clock-anomalies` → infra remediation (clock skew)
 *
 * ## Single-scan multiplex (efficiency contract)
 *
 * Earlier draft had each category run its own `store.query(...)`,
 * which meant N requested categories → N table walks. Bad for large
 * stores. Refactored to a pass-based design: each category is a
 * factory that returns an {@link AuditPass} with optional per-row
 * callbacks (`onEvent` / `onStream` / `onStat`) and a `finalize` hook
 * for any second-pass work. The dispatcher determines the UNION of
 * required data sources, runs each *once*, and broadcasts each row
 * to all interested passes. Worst case: three scans total (events,
 * streams, stats) regardless of how many categories the operator
 * requested. Most categories also share state — close-candidate and
 * restart-candidate both consume the same `onStat` stream; schema,
 * correlation-gaps, and clock-anomalies all hang off the same
 * `onEvent` broadcast.
 *
 * Categories that need follow-up work (snapshot-drift's per-stream
 * snapshot lookup, correlation-gaps' orphan-id check after collecting
 * ids) do that in their `finalize` hook with their own targeted store
 * calls — keeps the shared scan path minimal.
 *
 * Isolated from orchestration internals — `act.ts` builds the
 * {@link AuditDeps} bag at `.build()` time and hands it here via
 * a one-liner. The audit module never reaches into
 * `internal/{event-sourcing,drain-cycle,settle,close-cycle}.ts`; it
 * only reads through the deps interface and the public `Store`
 * surface. Same shape as `act-tck` within the workspace — a peer of
 * orchestration, not entangled with its private mechanics.
 *
 * @internal
 */

import type {
  AuditCategory,
  AuditFinding,
  AuditOptions,
  Committed,
  Logger,
  Schemas,
  State,
  Store,
  StreamPosition,
  StreamStats,
} from "../types/index.js";
import { currentVersionOf, deprecatedEventNames } from "./event-versions.js";

/**
 * Snapshot of orchestrator state the audit reads. Built once at
 * `app.build()`; the audit treats it as immutable for the duration
 * of a call. The orchestrator never passes its own private maps in
 * directly — this bag is the abstraction boundary so a future
 * orchestration refactor can't accidentally entangle with audit
 * logic.
 */
export type AuditDeps = {
  readonly store: () => Store;
  readonly logger: Logger;
  /** event-name → state that registers it (for schema validation). */
  readonly event_to_state: ReadonlyMap<string, State<any, any, any>>;
  /** state-name → state (for snapshot-supported check on restart-candidate). */
  readonly states: ReadonlyMap<string, State<any, any, any>>;
  /** All event names the registry knows (for unknown-name detection). */
  readonly known_events: ReadonlySet<string>;
  /** Declared drain lanes (for routing-health unknown-lane). */
  readonly declared_lanes: ReadonlySet<string>;
  /**
   * Event names that the registry has at least one reaction for —
   * used by routing-health to detect "registered but unrouted"
   * events. Normalized down from the internal `eventToLanes` map
   * (which carries lane-set details audit doesn't need).
   */
  readonly routed_events: ReadonlySet<string>;
};

/**
 * Defaults applied when the operator doesn't override via
 * {@link AuditOptions.thresholds}. Values land where most workloads
 * find them operationally useful — operators can tune per call.
 */
const DEFAULTS = {
  idle_days: 90,
  restart_min: 10_000,
  stuck_minutes: 30,
  deprecated_min: 0.1,
  drift_min: 500,
  near_block: 3,
};

const ALL_CATEGORIES = [
  "schema",
  "close-candidate",
  "restart-candidate",
  "deprecated-load",
  "reaction-health",
  "snapshot-drift",
  "routing-health",
  "correlation-gaps",
  "clock-anomalies",
] as const satisfies readonly AuditCategory[];

/**
 * A single audit category, expressed as a stream-consumer:
 *
 * - `onEvent` / `onStream` / `onStat` are called by the dispatcher
 *   during the shared scans. Each is optional; the dispatcher uses
 *   the presence/absence to decide which scans to run.
 * - `finalize` runs after all shared scans complete. Categories that
 *   need targeted follow-up store calls (snapshot-drift fetches the
 *   last `__snapshot__` per drifted stream; correlation-gaps cross-
 *   checks causations against the collected id set) do that here.
 * - `drain` is called last and returns the accumulated findings.
 */
type AuditPass = {
  category: AuditCategory;
  onEvent?: (e: Committed<Schemas, string>) => void;
  onStream?: (p: StreamPosition) => void;
  onStat?: (stream: string, s: StreamStats<Schemas>) => void;
  finalize?: (deps: AuditDeps) => Promise<void>;
  drain: () => AuditFinding[];
};

type PassFactory = (deps: AuditDeps, options: AuditOptions) => AuditPass;

/**
 * Top-level audit dispatcher. Single-scan multiplex: each requested
 * category contributes a `AuditPass`, the dispatcher determines the
 * union of required data sources (events / streams / stats), runs
 * each once, broadcasts rows, and yields per-category findings in
 * the order the categories were requested.
 *
 * Callers can `break` the iteration early — the underlying scan
 * loops have already completed by the time yield starts, so early
 * break only saves the iteration over already-collected findings.
 * (Per-row early termination during a scan isn't feasible without
 * coordination across passes; the audit is bounded by `options.query`
 * scoping rather than mid-scan cancellation.)
 */
export async function* audit(
  deps: AuditDeps,
  categories?: AuditCategory[],
  options: AuditOptions = {}
): AsyncIterable<AuditFinding> {
  const requested = new Set<AuditCategory>(categories ?? [...ALL_CATEGORIES]);
  // Preserve a deterministic category order (matches ALL_CATEGORIES
  // declaration) so output ordering doesn't depend on the order
  // operators list categories in their call.
  const orderedCategories = ALL_CATEGORIES.filter((c) => requested.has(c));
  const passes: AuditPass[] = orderedCategories.map((c) =>
    PASS_FACTORIES[c](deps, options)
  );

  // Determine scan needs. `some(...)` short-circuits — three trivial
  // walks at worst.
  const needStats = passes.some((p) => p.onStat !== undefined);
  const needStreams = passes.some((p) => p.onStream !== undefined);
  const needEvents = passes.some((p) => p.onEvent !== undefined);

  if (needStats) {
    const stats = await deps
      .store()
      .query_stats<Schemas>({}, { count: true, names: true });
    for (const [stream, s] of stats) {
      for (const p of passes) p.onStat?.(stream, s);
    }
  }

  if (needStreams) {
    await deps.store().query_streams((pos) => {
      for (const p of passes) p.onStream?.(pos);
    });
  }

  if (needEvents) {
    await deps.store().query<Schemas>((event) => {
      for (const p of passes) p.onEvent?.(event);
    }, options.query);
  }

  // Async post-processing (per-stream queries, second-pass orphan
  // detection). Serial to avoid pool contention; categories are
  // independent so order doesn't matter semantically.
  for (const p of passes) await p.finalize?.(deps);

  // Yield findings in requested-category order.
  for (const p of passes) {
    for (const f of p.drain()) yield f;
  }
}

// =================== Pass factories ===================
//
// Each category is implemented as a closure-bound `AuditPass`. The
// factory captures `deps` + relevant options + a `findings` array;
// the returned pass exposes the per-row hooks the dispatcher calls.
//
// All findings are accumulated in a per-pass `findings` buffer and
// returned from `drain()`. No yield-during-scan — that would couple
// the pass to async iteration semantics and prevent the shared-scan
// multiplexing.

/**
 * `schema` — every event in the audit window is parsed against the
 * Zod schema the registry currently declares for its name. Two
 * failure modes: `unknown_event_name` (event sits on disk, registry
 * has no entry) and `schema_validation_failed` (event matches a
 * known name but fails the current Zod schema).
 */
const makeSchemaPass: PassFactory = (deps) => {
  const findings: AuditFinding[] = [];
  return {
    category: "schema",
    onEvent(event) {
      const name = String(event.name);
      const state = deps.event_to_state.get(name);
      if (!state) {
        // Skip framework markers — they're not user-declared.
        if (name.startsWith("__")) return;
        findings.push({
          category: "schema",
          stream: event.stream,
          event_id: event.id,
          name,
          reason: "unknown_event_name",
        });
        return;
      }
      const schema = state.events[name];
      const parsed = schema.safeParse(event.data);
      if (!parsed.success) {
        findings.push({
          category: "schema",
          stream: event.stream,
          event_id: event.id,
          name,
          reason: "schema_validation_failed",
          zod_error: parsed.error,
        });
      }
    },
    drain: () => findings,
  };
};

/**
 * `deprecated-load` — workspace-wide event-name histogram classified
 * by the framework's `_v<digits>` rule. Built from the shared `onStat`
 * stream — accumulates per-name + per-stream totals in memory, then
 * emits one finding per deprecated event above the threshold during
 * `drain`.
 */
const makeDeprecatedLoadPass: PassFactory = (deps, options) => {
  const share_min =
    options.thresholds?.deprecated_min ?? DEFAULTS.deprecated_min;
  const totals = new Map<string, number>();
  const perStream = new Map<string, Map<string, number>>();
  return {
    category: "deprecated-load",
    onStat(stream, { names }) {
      // Contract: query_stats was called with `{names: true}`,
      // so adapter populates `names` with positive integer counts.
      // No runtime fallback needed.
      for (const [name, count] of Object.entries(names!)) {
        totals.set(name, (totals.get(name) ?? 0) + count!);
        let m = perStream.get(name);
        if (!m) {
          m = new Map();
          perStream.set(name, m);
        }
        m.set(stream, count!);
      }
    },
    drain() {
      const findings: AuditFinding[] = [];
      const grand = [...totals.values()].reduce((s, n) => s + n, 0);
      if (grand === 0) return findings;
      // Registry-driven deprecation classification (not on-disk-driven).
      const deprecated = deprecatedEventNames(deps.known_events);
      const sorted = [...deprecated]
        .map((name) => ({ name, count: totals.get(name) ?? 0 }))
        .sort((a, b) => b.count - a.count);
      for (const { name, count } of sorted) {
        if (count === 0) continue;
        if (count / grand < share_min) continue;
        // Contract: `deprecatedEventNames(registry)` only returns names
        // that have a higher version in the same family, so
        // `currentVersionOf(name, registry)` is guaranteed defined.
        const currentVersion = currentVersionOf(name, deps.known_events)!;
        // perStream is populated in lockstep with totals — name is guaranteed present.
        const topStreams = [...perStream.get(name)!.entries()]
          .map(([stream, c]) => ({ stream, count: c }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 10);
        findings.push({
          category: "deprecated-load",
          name,
          current_version: currentVersion,
          total: count,
          top_streams: topStreams,
        });
      }
      return findings;
    },
  };
};

/**
 * `close-candidate` — flags streams ripe for `app.close(...)`. Two
 * flavours: `idle` (head older than `idleDays`) and `terminal` (head
 * event name in operator-supplied `terminalEvents` list). Each
 * finding carries `restartSupported` (state has `.snap()`).
 */
const makeCloseCandidatePass: PassFactory = (deps, options) => {
  const idle_days = options.thresholds?.idle_days ?? DEFAULTS.idle_days;
  const terminal_events = new Set(options.thresholds?.terminal_events ?? []);
  const idle_cutoff = Date.now() - idle_days * 24 * 60 * 60 * 1000;
  const findings: AuditFinding[] = [];
  return {
    category: "close-candidate",
    onStat(stream, { head }) {
      const head_name = String(head.name);
      if (head_name.startsWith("__")) return; // already-closed or mid-truncate
      // All in-tree adapters return `created` as Date; the Date
      // constructor passes Date instances through unchanged, so a
      // single call shape works regardless.
      const head_time = head.created.getTime();
      const is_idle = head_time < idle_cutoff;
      const is_terminal = terminal_events.has(head_name);
      if (!is_idle && !is_terminal) return;
      findings.push({
        category: "close-candidate",
        stream,
        last_event_at: head.created.toISOString(),
        reason: is_terminal ? "terminal" : "idle",
        idle_days: is_idle
          ? Math.floor((Date.now() - head_time) / (24 * 60 * 60 * 1000))
          : undefined,
        restart_supported: restartIsSupported(deps, head_name),
      });
    },
    drain: () => findings,
  };
};

/**
 * `restart-candidate` — streams above `eventCountForRestart` whose
 * state declares `.snap()`. Reads from the shared `onStat` stream.
 */
const makeRestartCandidatePass: PassFactory = (deps, options) => {
  const threshold = options.thresholds?.restart_min ?? DEFAULTS.restart_min;
  const findings: AuditFinding[] = [];
  return {
    category: "restart-candidate",
    onStat(stream, { head, count, names }) {
      // `count` / `names` always populated — query_stats is called
      // with both flags set; adapters keep them present together.
      if (count! < threshold) return;
      const head_name = String(head.name);
      if (head_name.startsWith("__")) return;
      if (!restartIsSupported(deps, head_name)) return;
      findings.push({
        category: "restart-candidate",
        stream,
        count: count!,
        // names map is sparse — `__snapshot__` key absent when the
        // stream has never been snapshotted (a common case for the
        // restart-candidate signal).
        snaps: names!["__snapshot__"] ?? 0,
      });
    },
    drain: () => findings,
  };
};

/**
 * `reaction-health` — surfaces blocked / near-block / stuck-backoff
 * streams. Reads from the shared `onStream` stream-positions
 * broadcast.
 */
const makeReactionHealthPass: PassFactory = (_deps, options) => {
  const near_block = options.thresholds?.near_block ?? DEFAULTS.near_block;
  const stuck_minutes =
    options.thresholds?.stuck_minutes ?? DEFAULTS.stuck_minutes;
  const stuck_cutoff = Date.now() - stuck_minutes * 60 * 1000;
  const findings: AuditFinding[] = [];
  return {
    category: "reaction-health",
    onStream(p) {
      if (p.blocked) {
        findings.push({
          category: "reaction-health",
          stream: p.stream,
          status: "blocked",
          retry: p.retry,
          reason: p.error || "blocked without recorded error",
        });
        return;
      }
      if (p.retry >= near_block) {
        findings.push({
          category: "reaction-health",
          stream: p.stream,
          status: "near-block",
          retry: p.retry,
          reason: `retry ${p.retry} ≥ near-block threshold ${near_block}`,
        });
        return;
      }
      if (
        p.leased_by &&
        p.leased_until &&
        p.leased_until.getTime() < stuck_cutoff
      ) {
        const minutes = Math.floor(
          (Date.now() - p.leased_until.getTime()) / (60 * 1000)
        );
        findings.push({
          category: "reaction-health",
          stream: p.stream,
          status: "stuck-backoff",
          retry: p.retry,
          reason: `lease expired ${minutes}m ago without release`,
        });
      }
    },
    drain: () => findings,
  };
};

/**
 * `snapshot-drift` — buffers candidate streams from the shared
 * `onStat` pass (skipping non-snap states + tombstoned heads), then
 * does targeted per-stream lookups in `finalize` to find the last
 * `__snapshot__` event id and count events past it.
 */
const makeSnapshotDriftPass: PassFactory = (deps, options) => {
  const drift_min = options.thresholds?.drift_min ?? DEFAULTS.drift_min;
  // Streams the workspace pass identifies as drift candidates —
  // resolved in finalize with per-stream queries.
  const candidates: Array<{
    stream: string;
    total: number;
    snaps: number;
  }> = [];
  const findings: AuditFinding[] = [];
  return {
    category: "snapshot-drift",
    onStat(stream, { head, count, names }) {
      // restartIsSupported() already filters out framework markers
      // (__snapshot__, __tombstone__) — neither name appears in any
      // user state's events map, so the snap check rejects them.
      if (!restartIsSupported(deps, String(head.name))) return;
      if (count! < drift_min) return; // upper-bound short-circuit
      candidates.push({
        stream,
        total: count!,
        snaps: names!["__snapshot__"] ?? 0,
      });
    },
    async finalize(deps) {
      for (const { stream, total, snaps } of candidates) {
        let events_since_snap = total;
        let snap_at: number | undefined;
        if (snaps > 0) {
          const collected: Array<{ id: number }> = [];
          await deps.store().query(
            (e) => {
              collected.push({ id: e.id });
            },
            {
              stream,
              stream_exact: true,
              names: ["__snapshot__"],
              backward: true,
              limit: 1,
              with_snaps: true,
            }
          );
          // snaps > 0 means at least one `__snapshot__` event sits on
          // this stream — the backward-walk above must surface it.
          snap_at = collected[0]!.id;
          let after = 0;
          await deps.store().query(
            () => {
              after++;
            },
            { stream, stream_exact: true, after: snap_at }
          );
          events_since_snap = after;
        }
        if (events_since_snap < drift_min) continue;
        findings.push({
          category: "snapshot-drift",
          stream,
          events_since_snap,
          snap_at,
        });
      }
    },
    drain: () => findings,
  };
};

/**
 * `routing-health` — `unknown-lane` from the streams-table pass +
 * `unrouted` from the stats pass. Reads from BOTH shared streams.
 */
const makeRoutingHealthPass: PassFactory = (deps) => {
  const findings: AuditFinding[] = [];
  const seenEventNames = new Set<string>();
  return {
    category: "routing-health",
    onStream(p) {
      if (!p.lane) return; // default lane — never an unknown-lane finding
      if (deps.declared_lanes.has(p.lane)) return;
      findings.push({
        category: "routing-health",
        stream: p.stream,
        reason: "unknown-lane",
        lane: p.lane,
      });
    },
    onStat(_stream, { names }) {
      for (const name of Object.keys(names!)) {
        seenEventNames.add(name);
      }
    },
    finalize() {
      for (const name of seenEventNames) {
        if (name.startsWith("__")) continue;
        if (deps.routed_events.has(name)) continue;
        findings.push({
          category: "routing-health",
          stream: "*",
          reason: "unrouted",
        });
      }
      return Promise.resolve();
    },
    drain: () => findings,
  };
};

/**
 * `correlation-gaps` — collects ids + parent_ids during the shared
 * event pass; flags orphans in `drain`. No second store walk — the
 * id-set + the (id, parent) buffer are both populated in one pass.
 */
const makeCorrelationGapsPass: PassFactory = () => {
  const seenIds = new Set<number>();
  const checks: Array<{ stream: string; id: number; parentId: number }> = [];
  return {
    category: "correlation-gaps",
    onEvent(e) {
      seenIds.add(e.id);
      const causation = (e.meta as Record<string, unknown> | undefined)
        ?.causation as { event?: { id?: number } } | undefined;
      const parentId = causation?.event?.id;
      if (parentId !== undefined) {
        checks.push({ stream: e.stream, id: e.id, parentId });
      }
    },
    drain() {
      const findings: AuditFinding[] = [];
      for (const { stream, id, parentId } of checks) {
        if (!seenIds.has(parentId)) {
          findings.push({
            category: "correlation-gaps",
            stream,
            event_id: id,
            reason: "orphan-parent",
          });
        }
      }
      return findings;
    },
  };
};

/**
 * `clock-anomalies` — flags future timestamps + per-stream out-of-
 * order `created`. Single pass, per-stream "last seen" state in a
 * Map. Cheap.
 */
const makeClockAnomaliesPass: PassFactory = () => {
  const findings: AuditFinding[] = [];
  const lastPerStream = new Map<string, number>();
  return {
    category: "clock-anomalies",
    onEvent(e) {
      // `created` is a Date instance per the Store contract.
      const created = e.created.getTime();
      if (created > Date.now()) {
        findings.push({
          category: "clock-anomalies",
          stream: e.stream,
          event_id: e.id,
          reason: "future-created",
        });
      }
      const prev = lastPerStream.get(e.stream);
      if (prev !== undefined && created < prev) {
        findings.push({
          category: "clock-anomalies",
          stream: e.stream,
          event_id: e.id,
          reason: "out-of-order",
        });
      }
      lastPerStream.set(e.stream, created);
    },
    drain: () => findings,
  };
};

/** Does the stream's owning state declare a `.snap()` reducer? */
function restartIsSupported(deps: AuditDeps, headEventName: string): boolean {
  const state = deps.event_to_state.get(headEventName);
  return state?.snap !== undefined;
}

/** Factory registry — pass-creation indexed by category name. */
const PASS_FACTORIES: Record<AuditCategory, PassFactory> = {
  schema: makeSchemaPass,
  "deprecated-load": makeDeprecatedLoadPass,
  "close-candidate": makeCloseCandidatePass,
  "restart-candidate": makeRestartCandidatePass,
  "reaction-health": makeReactionHealthPass,
  "snapshot-drift": makeSnapshotDriftPass,
  "routing-health": makeRoutingHealthPass,
  "correlation-gaps": makeCorrelationGapsPass,
  "clock-anomalies": makeClockAnomaliesPass,
};
